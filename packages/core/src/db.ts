import { Database } from "bun:sqlite"

/**
 * Workspace database. Design notes:
 * - `sources.csl_json` is only ever written from Crossref/OpenAlex responses —
 *   never from model output. This is the structural anti-fabrication gate.
 * - `chunks` carry page/char offsets so every claim can open the exact passage.
 * - dense vectors (sqlite-vec) arrive with the ingestion milestone; FTS5 ships now.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS sources (
  id          TEXT PRIMARY KEY,
  path        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('pdf','md','txt','image','url')),
  title       TEXT,
  doi         TEXT,
  csl_json    TEXT,
  grade       TEXT NOT NULL DEFAULT 'note'
              CHECK (grade IN ('peer_reviewed','preprint','web','note')),
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','ingested','failed')),
  added_at    INTEGER NOT NULL,
  meta        TEXT
);

CREATE TABLE IF NOT EXISTS chunks (
  id          TEXT PRIMARY KEY,
  source_id   TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  section     TEXT,
  page        INTEGER,
  char_start  INTEGER,
  char_end    INTEGER,
  text        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source_id);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text, content='chunks', content_rowid='rowid'
);
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;

CREATE TABLE IF NOT EXISTS verdicts (
  id          TEXT PRIMARY KEY,
  claim       TEXT NOT NULL,
  chunk_id    TEXT NOT NULL REFERENCES chunks(id),
  verdict     TEXT NOT NULL CHECK (verdict IN ('supported','partial','unsupported')),
  quote       TEXT,
  model       TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  title       TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,
  parts       TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);

CREATE TABLE IF NOT EXISTS memory_notes (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('style','preference','project','lesson')),
  content     TEXT NOT NULL,
  approved    INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS feedback_events (
  id          TEXT PRIMARY KEY,
  context     TEXT NOT NULL,
  diff        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL
);
`

export function openDb(path: string): Database {
  const db = new Database(path, { create: true })
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA foreign_keys = ON")
  db.exec(SCHEMA)
  migrate(db)
  return db
}

/** additive migrations for existing workspace databases */
function migrate(db: Database): void {
  const cols = (db.query("PRAGMA table_info(chunks)").all() as { name: string }[]).map((c) => c.name)
  if (!cols.includes("line_start")) {
    db.exec("ALTER TABLE chunks ADD COLUMN line_start INTEGER")
    db.exec("ALTER TABLE chunks ADD COLUMN line_end INTEGER")
  }
  db.exec(`CREATE TABLE IF NOT EXISTS read_log (
    source_path TEXT NOT NULL,
    from_page   INTEGER NOT NULL,
    to_page     INTEGER NOT NULL,
    created_at  INTEGER NOT NULL
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS chunk_vecs (
    chunk_id  TEXT PRIMARY KEY,
    dim       INTEGER NOT NULL,
    embedding BLOB NOT NULL
  )`)
  // cached summaries of a session's earlier turns (context compaction);
  // upto = number of leading messages the summary replaces
  db.exec(`CREATE TABLE IF NOT EXISTS compactions (
    session_id  TEXT NOT NULL,
    upto        INTEGER NOT NULL,
    summary     TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (session_id, upto)
  )`)
  // crash journal: the in-flight turn's completed model steps, persisted as
  // the run progresses. A clean finish deletes the row; a crash leaves it, and
  // the next request for the SAME user message resumes from it instead of
  // losing hours of work. user_key ties the journal to the exact request.
  db.exec(`CREATE TABLE IF NOT EXISTS turn_journal (
    session_id  TEXT PRIMARY KEY,
    user_key    TEXT NOT NULL,
    accumulated TEXT NOT NULL,
    updated_at  INTEGER NOT NULL
  )`)
  // the agent's working plan for multi-step tasks (one per session, replaced whole)
  db.exec(`CREATE TABLE IF NOT EXISTS plans (
    session_id  TEXT PRIMARY KEY,
    todos       TEXT NOT NULL,
    updated_at  INTEGER NOT NULL
  )`)
  // concept graph — a navigation layer over the library. Nodes are concepts
  // (keyed by normalized label so the same concept across papers is ONE node);
  // edges are relations, each anchored to the exact chunk it was read from.
  // The graph POINTS to passages; it is never itself citable evidence.
  db.exec(`CREATE TABLE IF NOT EXISTS graph_nodes (
    id          TEXT PRIMARY KEY,
    label       TEXT NOT NULL,
    kind        TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS graph_edges (
    id          TEXT PRIMARY KEY,
    src         TEXT NOT NULL,
    dst         TEXT NOT NULL,
    relation    TEXT NOT NULL,
    source_path TEXT NOT NULL,
    chunk_id    TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
    confidence  TEXT NOT NULL DEFAULT 'EXTRACTED',
    created_at  INTEGER NOT NULL
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_gedge_src ON graph_edges(src)`)
  // graph v2 canonicalization: node label embeddings + surface-form aliases,
  // so "LLM" and "large language model" resolve to ONE node without losing
  // either surface form (new tables — no migration needed on existing DBs)
  db.exec(`CREATE TABLE IF NOT EXISTS graph_node_vecs (
    node_id   TEXT PRIMARY KEY,
    dim       INTEGER NOT NULL,
    embedding BLOB NOT NULL
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS graph_node_aliases (
    node_id    TEXT NOT NULL,
    alias      TEXT NOT NULL,
    PRIMARY KEY (node_id, alias)
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_gedge_dst ON graph_edges(dst)`)
  // PRISMA-S search log: every scholarly query AS RUN, with source, datetime
  // and hit count — the reproducibility record no competitor exports. A
  // review's search strategy is reconstructable from this table alone.
  db.exec(`CREATE TABLE IF NOT EXISTS searches (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT,
    source      TEXT NOT NULL,
    query       TEXT NOT NULL,
    mode        TEXT,
    hits        INTEGER NOT NULL,
    created_at  INTEGER NOT NULL
  )`)
  // screening ledger (Wohlin/PRISMA physics): every candidate paper ever
  // surfaced — by which query or snowball hop, screened or not, the
  // include/exclude decision WITH its reason, and how deeply it was read.
  // The funnel (identified → screened → included → read) renders from here.
  db.exec(`CREATE TABLE IF NOT EXISTS candidates (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    year        INTEGER,
    doi         TEXT,
    venue       TEXT,
    cited_by    INTEGER,
    found_by    TEXT NOT NULL,
    iteration   INTEGER NOT NULL DEFAULT 0,
    decision    TEXT,
    reason      TEXT,
    relevance   TEXT,
    source_path TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_candidates_doi ON candidates(doi)`)
  // structured per-paper extraction matrix (Elicit-grade): each cell is a
  // field extracted from ONE source, anchored to the chunk it came from with
  // a verbatim quote — synthesis tables and cross-paper queries build FROM
  // this instead of re-deriving facts at write time.
  db.exec(`CREATE TABLE IF NOT EXISTS extractions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    source_path TEXT NOT NULL,
    field       TEXT NOT NULL,
    value       TEXT NOT NULL,
    chunk_id    TEXT NOT NULL,
    quote       TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_extractions_source ON extractions(source_path)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_extractions_field ON extractions(field)`)
  // ranked cross-session search: text parts only, rebuilt per session at persist time
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    session_id UNINDEXED, message_id UNINDEXED, role UNINDEXED, content
  )`)
  // one-time backfill: sessions persisted before the index existed stay searchable
  const ftsCount = (db.query("SELECT COUNT(*) c FROM messages_fts").get() as { c: number }).c
  if (ftsCount === 0) {
    const rows = db
      .query("SELECT id, session_id, role, parts FROM messages")
      .all() as { id: string; session_id: string; role: string; parts: string }[]
    const ins = db.query(
      "INSERT INTO messages_fts (session_id, message_id, role, content) VALUES (?, ?, ?, ?)",
    )
    for (const r of rows) {
      try {
        const text = (JSON.parse(r.parts) as { type: string; text?: string }[])
          .filter((p) => p.type === "text" && p.text)
          .map((p) => p.text)
          .join(" ")
          .trim()
        if (text) ins.run(r.session_id, r.id, r.role, text)
      } catch {
        // unparseable parts — skip
      }
    }
  }
}

export type { Database }

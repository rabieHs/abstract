import type { Database, Workspace } from "@abstract/core"
import { listNotes } from "./notes.ts"
import { listSourceFiles } from "./tools.ts"

/**
 * The screening ledger + search log — PRISMA physics without PRISMA ceremony.
 * Every scholarly query is recorded AS RUN (source, datetime, hits); every
 * candidate paper ever surfaced gets a row (found by which query or snowball
 * hop, include/exclude decision WITH reason, link to the library file once
 * fetched). Coverage stops being a feeling and becomes a funnel the agent
 * must face: identified → screened → included → fetched → read.
 */

export function logSearch(
  db: Database,
  session: string | undefined,
  source: string,
  query: string,
  mode: string,
  hits: number,
): void {
  db.query(
    "INSERT INTO searches (session_id, source, query, mode, hits, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(session ?? null, source, query, mode, hits, Date.now())
}

export interface CandidateInput {
  title: string
  doi?: string | null
  year?: number | null
  venue?: string | null
  citedBy?: number | null
}

/** stable candidate key: DOI when known, normalized title otherwise */
export function candidateKey(c: { doi?: string | null; title: string }): string {
  if (c.doi) return `doi:${c.doi.toLowerCase()}`
  return "t:" + c.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 120)
}

/**
 * Saturation signal (Wohlin closure, P2.8): "searched enough" is when
 * recent hops stop adding NEW candidates — a number the agent must face,
 * never a feeling. Looks at the most recent search/snowball rounds.
 */
function saturationSignal(db: Database): string | null {
  const rows = db
    .query("SELECT id, created_at FROM searches ORDER BY id DESC LIMIT 3")
    .all() as { id: number; created_at: number }[]
  if (rows.length < 3) return null
  const since = rows[rows.length - 1]!.created_at
  const added = (
    db.query("SELECT COUNT(*) n FROM candidates WHERE created_at >= ? AND updated_at IS NULL").get(since) as {
      n: number
    }
  ).n
  if (added === 0)
    return "the last 3 search/snowball rounds added ZERO new candidates — saturation: coverage is converging, stop expanding and state the boundary"
  if (added <= 2)
    return `the last 3 search/snowball rounds added only ${added} new candidate(s) — approaching saturation`
  return null
}

/** record surfaced papers as ledger candidates; existing rows keep their decisions */
export function upsertCandidates(
  db: Database,
  results: CandidateInput[],
  foundBy: string,
  iteration = 0,
): { added: number; known: number } {
  const now = Date.now()
  let added = 0
  let known = 0
  const ins = db.query(
    `INSERT INTO candidates (id, title, year, doi, venue, cited_by, found_by, iteration, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       cited_by = COALESCE(excluded.cited_by, candidates.cited_by),
       venue = COALESCE(excluded.venue, candidates.venue),
       updated_at = excluded.created_at`,
  )
  const exists = db.query("SELECT 1 FROM candidates WHERE id = ?")
  for (const r of results) {
    const id = candidateKey(r)
    if (exists.get(id)) known++
    else added++
    ins.run(id, r.title, r.year ?? null, r.doi ?? null, r.venue ?? null, r.citedBy ?? null, foundBy.slice(0, 200), iteration, now)
  }
  return { added, known }
}

export interface ScreeningDecision {
  ref: string
  decision: "include" | "exclude"
  reason: string
  relevance?: "high" | "related" | "no"
}

/** apply decisions by DOI, ledger id, or title substring (case-insensitive) */
export function recordScreening(
  db: Database,
  decisions: ScreeningDecision[],
): { updated: number; unmatched: string[] } {
  const now = Date.now()
  let updated = 0
  const unmatched: string[] = []
  const upd = db.query(
    "UPDATE candidates SET decision = ?, reason = ?, relevance = ?, updated_at = ? WHERE id = ?",
  )
  for (const d of decisions) {
    const ref = d.ref.trim()
    const row =
      (db.query("SELECT id FROM candidates WHERE id = ?").get(ref) as { id: string } | null) ??
      (db
        .query("SELECT id FROM candidates WHERE doi = ? COLLATE NOCASE")
        .get(ref.replace(/^doi:/i, "")) as { id: string } | null) ??
      (db
        .query("SELECT id FROM candidates WHERE title LIKE ? ORDER BY created_at LIMIT 1")
        .get(`%${ref.replace(/[%_]/g, "")}%`) as { id: string } | null)
    if (!row) {
      unmatched.push(d.ref)
      continue
    }
    upd.run(d.decision, d.reason.slice(0, 300), d.relevance ?? null, now, row.id)
    updated++
  }
  return { updated, unmatched }
}

/** link a fetched library file back to its ledger candidate (by DOI) */
export function linkCandidateToSource(db: Database, doi: string | null, sourcePath: string): void {
  if (!doi) return
  try {
    db.query("UPDATE candidates SET source_path = ?, updated_at = ? WHERE doi = ? COLLATE NOCASE").run(
      sourcePath,
      Date.now(),
      doi,
    )
  } catch {
    /* ledger linking must never break a fetch */
  }
}

export interface Funnel {
  identified: number
  screened: number
  included: number
  excluded: number
  fetched: number
}

export function funnel(db: Database): Funnel {
  const one = (sql: string) => (db.query(sql).get() as { n: number }).n
  return {
    identified: one("SELECT COUNT(*) n FROM candidates"),
    screened: one("SELECT COUNT(*) n FROM candidates WHERE decision IS NOT NULL"),
    included: one("SELECT COUNT(*) n FROM candidates WHERE decision = 'include'"),
    excluded: one("SELECT COUNT(*) n FROM candidates WHERE decision = 'exclude'"),
    fetched: one("SELECT COUNT(*) n FROM candidates WHERE source_path IS NOT NULL"),
  }
}

/** files sitting in sources/ that were never ingested — downloaded ≠ known */
export function orphanedDownloads(db: Database, workspace: Workspace): string[] {
  const known = new Set(
    (db.query("SELECT path FROM sources").all() as { path: string }[]).map((r) => r.path),
  )
  return listSourceFiles(workspace)
    .map((f) => f.path)
    .filter((p) => p.startsWith("sources/") && !known.has(p))
}

/**
 * library_state v2 — the one-line reality signal that rides tool results:
 * library counts + the screening funnel + fetched-but-never-ingested orphans.
 */
export function renderLibraryState(db: Database, workspace: Workspace): string {
  const total = (db.query("SELECT COUNT(*) AS n FROM sources").get() as { n: number }).n
  const opened = (
    db.query("SELECT COUNT(DISTINCT source_path) AS n FROM read_log").get() as { n: number }
  ).n
  let noted = 0
  try {
    noted = listNotes(workspace).length
  } catch {
    // a fresh workspace has no notes dir yet — zero notes, not a crash
  }
  let s = `${total} sources in library · ${opened} opened via read_pages · ${noted} with notes`
  const f = funnel(db)
  if (f.identified > 0) {
    s += ` · ledger: ${f.identified} identified → ${f.screened} screened → ${f.included} included (${f.excluded} excluded)`
    if (f.screened < f.identified) s += ` — ${f.identified - f.screened} candidates never screened`
  }
  const orphans = orphanedDownloads(db, workspace)
  if (orphans.length > 0) {
    s += ` · ⚠ ${orphans.length} downloaded-but-never-ingested: ${orphans.slice(0, 3).join(", ")}${orphans.length > 3 ? ", …" : ""}`
  }
  const sat = saturationSignal(db)
  if (sat) s += ` · ${sat}`
  return s
}

/** the PRISMA-style flow + search record, rendered purely from the ledger */
export function prismaFlowMarkdown(db: Database): string {
  const f = funnel(db)
  const searches = db
    .query("SELECT source, query, mode, hits, created_at FROM searches ORDER BY created_at")
    .all() as { source: string; query: string; mode: string | null; hits: number; created_at: number }[]
  const exclusions = db
    .query(
      "SELECT reason, COUNT(*) n FROM candidates WHERE decision = 'exclude' GROUP BY reason ORDER BY n DESC",
    )
    .all() as { reason: string; n: number }[]
  const searchRows = searches
    .map(
      (s) =>
        `| ${new Date(s.created_at).toISOString().slice(0, 16).replace("T", " ")} | ${s.source} | ${s.mode ?? ""} | ${s.query.replace(/\|/g, "\\|")} | ${s.hits} |`,
    )
    .join("\n")
  const exclRows = exclusions.map((e) => `- ${e.reason} (n=${e.n})`).join("\n")
  return `# Search & screening record (PRISMA-style)

Rendered from the recorded ledger — every count below is a database query,
never a recollection.

## Searches as run

| when (UTC) | source | mode | query | hits |
|---|---|---|---|---|
${searchRows || "| — | — | — | (no searches recorded) | — |"}

## Flow

\`\`\`mermaid
flowchart TD
  A["Records identified (n=${f.identified})"] --> B["Records screened (n=${f.screened})"]
  A -.-> U["Never screened (n=${f.identified - f.screened})"]
  B --> C["Included (n=${f.included})"]
  B --> D["Excluded (n=${f.excluded})"]
  C --> E["Retrieved into library (n=${f.fetched})"]
\`\`\`

## Exclusion reasons

${exclRows || "(none recorded)"}
`
}

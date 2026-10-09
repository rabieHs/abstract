import { generateObject, type LanguageModel } from "ai"
import { z } from "zod"
import { createHash } from "node:crypto"
import type { Database, Workspace } from "@abstract/core"

/**
 * Concept graph — a navigation layer over the library, in the spirit of
 * Graphify: nodes are concepts (keyed by a normalized label so the same
 * concept across papers is ONE node), edges are relations, and EVERY edge is
 * anchored to the exact chunk it was read from (provenance) and tagged
 * EXTRACTED (stated in that passage) or INFERRED (pure graph logic, no LLM).
 *
 * The graph POINTS to passages so the agent can navigate without re-reading
 * everything. It is NEVER itself citable evidence — the verifier still gates
 * every claim, exactly as with notes and search.
 */

export type EdgeConfidence = "EXTRACTED" | "INFERRED"

const KINDS = ["concept", "method", "dataset", "metric", "tool", "finding", "task"] as const

const Triples = z.object({
  triples: z
    .array(
      z.object({
        subject: z.string().describe("a concept named in the passage"),
        relation: z
          .string()
          .describe("short verb phrase stated in the passage, e.g. uses, evaluated_on, compares_to, builds_on, measures, outperforms, proposes, part_of"),
        object: z.string().describe("the other concept the relation connects to"),
        subject_kind: z.enum(KINDS),
        object_kind: z.enum(KINDS),
        evidence_chunk: z.string().describe("the chunk id (from the passages below) where THIS relation is stated"),
      }),
    )
    .describe("relations EXPLICITLY stated in the passages; skip anything not actually in the text"),
})

function norm(label: string): string {
  return label.toLowerCase().trim().replace(/\s+/g, " ").replace(/[.,;:]+$/, "").slice(0, 80)
}

/* ------------------------------------------------------------------ *
 * Graph v2 canonicalization (S13): string-normalization alone splits
 * "LLM" and "large language model" into two nodes and dilutes every
 * centrality/shared-concept query. When an embedder is available, a NEW
 * label whose embedding sits within MERGE_THRESHOLD of an existing node
 * resolves to that node, and the surface form is kept as an alias.
 * Conservative by design: no embedder (or any failure) → v1 behavior.
 * ------------------------------------------------------------------ */

export type Embedder = (values: string[]) => Promise<number[][]>

/** high bar on purpose — a wrong merge corrupts the map, a missed merge only splits a node */
export const MERGE_THRESHOLD = 0.9

function cos(a: Float32Array, b: Float32Array): number {
  let dot = 0
  let na = 0
  let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1)
}

/**
 * Resolve labels to canonical node ids. Exact-norm hits and alias hits are
 * free; genuinely new labels are batch-embedded and merged into an existing
 * node when close enough (alias recorded), else registered as new nodes with
 * their vector stored. Returns norm(label) → canonical node id.
 */
export async function canonicalizeLabels(
  db: Database,
  labels: string[],
  embedder: Embedder | null,
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const unresolved: string[] = []
  const existing = new Set(
    (db.query("SELECT id FROM graph_nodes").all() as { id: string }[]).map((r) => r.id),
  )
  const aliases = new Map(
    (db.query("SELECT alias, node_id FROM graph_node_aliases").all() as { alias: string; node_id: string }[]).map(
      (r) => [r.alias, r.node_id],
    ),
  )
  for (const raw of labels) {
    const n = norm(raw)
    if (!n || out.has(n)) continue
    if (existing.has(n)) out.set(n, n)
    else if (aliases.has(n)) out.set(n, aliases.get(n)!)
    else unresolved.push(n)
  }
  if (unresolved.length === 0 || !embedder) {
    for (const n of unresolved) out.set(n, n) // v1 behavior: the norm IS the id
    return out
  }
  try {
    const nodeVecs = (
      db.query("SELECT node_id, embedding FROM graph_node_vecs").all() as { node_id: string; embedding: Uint8Array }[]
    ).map((r) => ({
      id: r.node_id,
      vec: new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4),
    }))
    const vecs = await embedder(unresolved)
    const insVec = db.query("INSERT OR REPLACE INTO graph_node_vecs (node_id, dim, embedding) VALUES (?, ?, ?)")
    const insAlias = db.query("INSERT OR IGNORE INTO graph_node_aliases (node_id, alias) VALUES (?, ?)")
    unresolved.forEach((n, i) => {
      const v = Float32Array.from(vecs[i]!)
      let best: { id: string; sim: number } | null = null
      for (const nv of nodeVecs) {
        const sim = cos(v, nv.vec)
        if (!best || sim > best.sim) best = { id: nv.id, sim }
      }
      if (best && best.sim >= MERGE_THRESHOLD) {
        out.set(n, best.id)
        insAlias.run(best.id, n)
      } else {
        out.set(n, n)
        insVec.run(n, v.length, Buffer.from(v.buffer))
        nodeVecs.push({ id: n, vec: v }) // later labels in this batch can merge into it
      }
    })
  } catch {
    for (const n of unresolved) if (!out.has(n)) out.set(n, n)
  }
  return out
}

/** resolve a queried concept through the alias table too */
export function resolveConcept(db: Database, concept: string): string {
  const n = norm(concept)
  const hit = db.query("SELECT node_id FROM graph_node_aliases WHERE alias = ?").get(n) as {
    node_id: string
  } | null
  return hit?.node_id ?? n
}

export interface GraphExtractResult {
  source: string
  nodes: number
  edges: number
  sample: { subject: string; relation: string; object: string }[]
}

/** EXTRACTED path: read a source's chunks into the graph, every edge chunk-anchored */
export async function extractGraph(
  db: Database,
  workspace: Workspace,
  opts: {
    sourcePath: string
    model: LanguageModel
    fromPage?: number
    toPage?: number
    /** enables embedding-based node canonicalization; null → v1 string keys */
    embedder?: Embedder | null
  },
): Promise<GraphExtractResult | { error: string }> {
  const rows = db
    .query(
      `SELECT c.id, c.page, c.text FROM chunks c JOIN sources s ON s.id = c.source_id
       WHERE s.path = ? ${opts.fromPage ? "AND c.page >= ?" : ""} ${opts.toPage ? "AND c.page <= ?" : ""}
       ORDER BY c.page, c.char_start`,
    )
    .all(
      ...([opts.sourcePath, opts.fromPage, opts.toPage].filter((v) => v !== undefined) as (string | number)[]),
    ) as { id: string; page: number | null; text: string }[]
  if (rows.length === 0) return { error: `no ingested chunks for ${opts.sourcePath} — ingest/read it first` }

  const allowed = new Set(rows.map((r) => r.id))
  const insNode = db.query(
    "INSERT OR IGNORE INTO graph_nodes (id, label, kind, created_at) VALUES (?, ?, ?, ?)",
  )
  const insEdge = db.query(
    "INSERT OR IGNORE INTO graph_edges (id, src, dst, relation, source_path, chunk_id, confidence, created_at) VALUES (?, ?, ?, ?, ?, ?, 'EXTRACTED', ?)",
  )

  let nodes = 0
  let edges = 0
  const sample: { subject: string; relation: string; object: string }[] = []
  const now = Date.now()

  // batch chunks to keep each extraction prompt focused
  const BATCH = 6
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH)
    const passages = batch
      .map((r) => `[${r.id}]${r.page ? ` (p.${r.page})` : ""} ${r.text.replace(/\s+/g, " ").slice(0, 700)}`)
      .join("\n\n")
    let object: z.infer<typeof Triples>
    try {
      const r = await generateObject({
        model: opts.model,
        schema: Triples,
        prompt:
          "Extract the explicit relationships between concepts in these passages, for a " +
          "knowledge graph. ONLY relations that are actually stated in the text — never infer " +
          "or add outside knowledge. Each relation must name the chunk id it came from.\n\n" +
          `PASSAGES:\n${passages}`,
      })
      object = r.object
    } catch {
      continue // a bad batch never blocks the rest
    }
    // canonicalize this batch's labels BEFORE inserting: same-meaning surface
    // forms resolve to one node (alias kept), so edges land on canonical ids
    const canon = await canonicalizeLabels(
      db,
      object.triples.flatMap((t) => [t.subject, t.object]),
      opts.embedder ?? null,
    )
    const tx = db.transaction(() => {
      for (const t of object.triples) {
        // structural gate: the evidence chunk must be one we actually showed
        if (!allowed.has(t.evidence_chunk)) continue
        const s = canon.get(norm(t.subject)) ?? norm(t.subject)
        const o = canon.get(norm(t.object)) ?? norm(t.object)
        if (!s || !o || s === o) continue
        insNode.run(s, t.subject.trim().slice(0, 80), t.subject_kind, now)
        insNode.run(o, t.object.trim().slice(0, 80), t.object_kind, now)
        nodes += 2
        const rel = t.relation.toLowerCase().trim().replace(/\s+/g, "_").slice(0, 40)
        const eid = createHash("sha256").update(`${s}|${rel}|${o}|${t.evidence_chunk}`).digest("hex").slice(0, 16)
        insEdge.run(eid, s, o, rel, opts.sourcePath, t.evidence_chunk, now)
        edges++
        if (sample.length < 5) sample.push({ subject: s, relation: rel, object: o })
      }
    })
    tx()
  }

  return { source: opts.sourcePath, nodes, edges, sample }
}

export interface RelatedHit {
  concept: string
  relation: string
  other: string
  source: string
  chunkId: string
  confidence: EdgeConfidence
}

/** neighbors of a concept — connected concepts + the passage each came from */
export function neighbors(db: Database, concept: string, k = 20): RelatedHit[] {
  const id = resolveConcept(db, concept) // an alias query finds its canonical node
  const rows = db
    .query(
      `SELECT src, dst, relation, source_path, chunk_id, confidence FROM graph_edges
       WHERE src = ? OR dst = ? ORDER BY created_at DESC LIMIT ?`,
    )
    .all(id, id, k) as {
    src: string; dst: string; relation: string; source_path: string; chunk_id: string; confidence: EdgeConfidence
  }[]
  return rows.map((r) => ({
    concept: id,
    relation: r.relation,
    other: r.src === id ? r.dst : r.src,
    source: r.source_path,
    chunkId: r.chunk_id,
    confidence: r.confidence,
  }))
}

/** INFERRED path: concepts that MULTIPLE sources both connect to — the cross-paper links.
 *  Pure graph logic (no LLM), so no fabrication is possible. */
export function sharedConcepts(
  db: Database,
  k = 20,
): { concept: string; label: string; sources: string[]; chunks: string[] }[] {
  const rows = db
    .query(
      `SELECT node, GROUP_CONCAT(DISTINCT source_path) srcs, GROUP_CONCAT(chunk_id) chunks, COUNT(DISTINCT source_path) n
       FROM (
         SELECT src AS node, source_path, chunk_id FROM graph_edges
         UNION ALL
         SELECT dst AS node, source_path, chunk_id FROM graph_edges
       ) GROUP BY node HAVING n >= 2 ORDER BY n DESC, node LIMIT ?`,
    )
    .all(k) as { node: string; srcs: string; chunks: string; n: number }[]
  const labels = new Map(
    (db.query("SELECT id, label FROM graph_nodes").all() as { id: string; label: string }[]).map((r) => [r.id, r.label]),
  )
  return rows.map((r) => ({
    concept: r.node,
    label: labels.get(r.node) ?? r.node,
    sources: [...new Set(r.srcs.split(","))],
    chunks: [...new Set(r.chunks.split(","))].slice(0, 6),
  }))
}

/** the most connected concepts across the whole library */
export function centralConcepts(db: Database, k = 15): { concept: string; label: string; degree: number }[] {
  const rows = db
    .query(
      `SELECT node, COUNT(*) degree FROM (
         SELECT src AS node FROM graph_edges UNION ALL SELECT dst AS node FROM graph_edges
       ) GROUP BY node ORDER BY degree DESC LIMIT ?`,
    )
    .all(k) as { node: string; degree: number }[]
  const labels = new Map(
    (db.query("SELECT id, label FROM graph_nodes").all() as { id: string; label: string }[]).map((r) => [r.id, r.label]),
  )
  return rows.map((r) => ({ concept: r.node, label: labels.get(r.node) ?? r.node, degree: r.degree }))
}

export function graphSize(db: Database): { nodes: number; edges: number; sources: number } {
  const n = (db.query("SELECT COUNT(*) c FROM graph_nodes").get() as { c: number }).c
  const e = (db.query("SELECT COUNT(*) c FROM graph_edges").get() as { c: number }).c
  const s = (db.query("SELECT COUNT(DISTINCT source_path) c FROM graph_edges").get() as { c: number }).c
  return { nodes: n, edges: e, sources: s }
}

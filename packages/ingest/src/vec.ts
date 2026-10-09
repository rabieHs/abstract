import type { Database } from "@abstract/core"
import { searchLibrary, type SearchHit } from "./index.ts"

/**
 * Semantic retrieval. Embeddings live in chunk_vecs (Float32 blobs); search is
 * brute-force cosine — exact, dependency-free, and fast at library scale
 * (10k chunks ≈ a few ms). No embedder configured → keyword-only, gracefully.
 */

export type Embedder = (values: string[]) => Promise<number[][]>

/** embed every chunk that doesn't have a vector yet (ingest + backfill path) */
export async function embedMissing(
  db: Database,
  embed: Embedder,
  limit = 400,
): Promise<number> {
  const rows = db
    .query(
      `SELECT c.id, c.text FROM chunks c
       LEFT JOIN chunk_vecs v ON v.chunk_id = c.id
       WHERE v.chunk_id IS NULL LIMIT ?`,
    )
    .all(limit) as { id: string; text: string }[]
  if (rows.length === 0) return 0
  const ins = db.query("INSERT OR REPLACE INTO chunk_vecs (chunk_id, dim, embedding) VALUES (?, ?, ?)")
  for (let i = 0; i < rows.length; i += 90) {
    const batch = rows.slice(i, i + 90)
    const vecs = await embed(batch.map((r) => r.text.slice(0, 6000)))
    batch.forEach((r, j) => {
      const v = Float32Array.from(vecs[j]!)
      ins.run(r.id, v.length, Buffer.from(v.buffer))
    })
  }
  return rows.length
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1)
}

export async function semanticSearch(
  db: Database,
  embed: Embedder,
  query: string,
  k: number,
): Promise<SearchHit[]> {
  const [qv] = await embed([query])
  const q = Float32Array.from(qv!)
  const rows = db
    .query("SELECT chunk_id, embedding FROM chunk_vecs")
    .all() as { chunk_id: string; embedding: Uint8Array }[]
  const scored = rows
    .map((r) => ({
      id: r.chunk_id,
      score: cosine(q, new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4)),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
  if (scored.length === 0) return []
  const placeholders = scored.map(() => "?").join(",")
  const chunkRows = db
    .query(
      `SELECT c.id, c.page, c.line_start, c.line_end, c.text, s.path, s.title, s.grade
       FROM chunks c JOIN sources s ON s.id = c.source_id WHERE c.id IN (${placeholders})`,
    )
    .all(...scored.map((s) => s.id)) as any[]
  const byId = new Map(chunkRows.map((r) => [r.id, r]))
  return scored
    .filter((s) => byId.has(s.id))
    .map((s) => {
      const r = byId.get(s.id)!
      return {
        chunkId: r.id,
        sourcePath: r.path,
        sourceTitle: r.title,
        grade: r.grade,
        page: r.page,
        lines: r.line_start ? `${r.line_start}-${r.line_end ?? r.line_start}` : null,
        text: r.text,
        score: s.score,
      }
    })
}

/** keyword (FTS/BM25) + semantic, fused by reciprocal rank */
export async function hybridSearch(
  db: Database,
  query: string,
  k: number,
  embed?: Embedder | null,
): Promise<SearchHit[]> {
  const kw = searchLibrary(db, query, k * 2)
  if (!embed) return kw.slice(0, k)
  let sem: SearchHit[] = []
  try {
    sem = await semanticSearch(db, embed, query, k * 2)
  } catch {
    return kw.slice(0, k) // embedder offline → keyword-only, never fail the search
  }
  const rrf = new Map<string, { hit: SearchHit; score: number }>()
  const add = (list: SearchHit[]) =>
    list.forEach((h, i) => {
      const cur = rrf.get(h.chunkId)
      const s = 1 / (60 + i)
      if (cur) cur.score += s
      else rrf.set(h.chunkId, { hit: h, score: s })
    })
  add(kw)
  add(sem)
  return [...rrf.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((x) => x.hit)
}

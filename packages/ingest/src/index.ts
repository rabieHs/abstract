import { readFileSync } from "node:fs"
import { extname, join } from "node:path"
import { createHash } from "node:crypto"
import { extractText, getDocumentProxy } from "unpdf"
import type { Database, Workspace } from "@abstract/core"
import { chunkText, type Chunk } from "./chunk.ts"
import { resolveMetadata, type Grade } from "./metadata.ts"

export { chunkText } from "./chunk.ts"
export * from "./metadata.ts"
export * from "./vec.ts"

export interface IngestResult {
  sourceId: string
  path: string
  kind: "pdf" | "md" | "txt"
  pages: number | null
  chunks: number
  alreadyIngested: boolean
  /** true when the text layer was empty and a vision model transcribed the pages */
  ocr?: boolean
  /** metadata gate outcome */
  grade: Grade
  title: string | null
  doi: string | null
  matched: "doi" | "title" | "none" | "skipped"
}

/** a scanned PDF has (almost) no text layer: most pages extract to nothing */
export function looksScanned(pageTexts: string[]): boolean {
  if (pageTexts.length === 0) return false
  const empty = pageTexts.filter((t) => t.trim().length < 40).length
  return empty / pageTexts.length > 0.6
}

function sha(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex").slice(0, 16)
}

/** Extract per-page text from a PDF (unpdf / pdf.js — the degraded-but-zero-setup path). */
async function pdfPages(absPath: string): Promise<string[]> {
  const buffer = readFileSync(absPath)
  const pdf = await getDocumentProxy(new Uint8Array(buffer))
  const { text } = await extractText(pdf, { mergePages: false })
  return text
}

export async function ingestFile(
  db: Database,
  workspace: Workspace,
  relPath: string,
  opts: {
    resolve?: boolean
    fetchImpl?: typeof fetch
    /** transcribes a scanned PDF (no text layer) page by page — vision model */
    ocr?: (absPath: string, pages: number) => Promise<string[]>
    /** authoritative DOI from the caller — beats extraction and title guessing */
    doiHint?: string | null
  } = {},
): Promise<IngestResult> {
  const absPath = join(workspace.root, relPath)
  const ext = extname(relPath).toLowerCase()
  const kind = ext === ".pdf" ? "pdf" : ext === ".md" || ext === ".markdown" ? "md" : "txt"

  const raw = readFileSync(absPath)
  const sourceId = sha(raw)

  const existing = db
    .query("SELECT status FROM sources WHERE id = ?")
    .get(sourceId) as { status: string } | null
  if (existing?.status === "ingested") {
    const n = db.query("SELECT COUNT(*) c FROM chunks WHERE source_id = ?").get(sourceId) as {
      c: number
    }
    const s = db
      .query("SELECT grade, title, doi FROM sources WHERE id = ?")
      .get(sourceId) as { grade: Grade; title: string | null; doi: string | null }
    return {
      sourceId, path: relPath, kind, pages: null, chunks: n.c, alreadyIngested: true,
      grade: s.grade, title: s.title, doi: s.doi, matched: "skipped",
    }
  }

  let chunks: Chunk[] = []
  let pages: number | null = null
  let headText: string
  let ocrUsed = false
  if (kind === "pdf") {
    let pageTexts = await pdfPages(absPath)
    if (looksScanned(pageTexts) && opts.ocr) {
      // image-only PDF: the text layer is empty — let a vision model read it
      const transcribed = await opts.ocr(absPath, pageTexts.length)
      if (transcribed.some((t) => t.trim().length >= 40)) {
        pageTexts = transcribed
        ocrUsed = true
      }
    }
    pages = pageTexts.length
    pageTexts.forEach((t, i) => chunks.push(...chunkText(t, i + 1)))
    headText = pageTexts.slice(0, 2).join("\n")
  } else {
    const text = raw.toString("utf8")
    chunks = chunkText(text)
    headText = text.slice(0, 6000)
    // line anchors: newline offsets -> line number per char position
    const nl: number[] = []
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) nl.push(i)
    const lineAt = (pos: number) => {
      let lo = 0, hi = nl.length
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (nl[mid]! < pos) lo = mid + 1
        else hi = mid
      }
      return lo + 1
    }
    for (const c of chunks) {
      c.lineStart = lineAt(c.charStart)
      c.lineEnd = lineAt(Math.max(c.charEnd - 1, c.charStart))
    }
  }

  // metadata gate: registry lookup — csl_json only ever holds a registry response
  let meta: { grade: Grade; title: string | null; doi: string | null; csl: unknown; matched: "doi" | "title" | "none" | "skipped" } =
    { grade: "note", title: null, doi: null, csl: null, matched: "skipped" }
  if (opts.resolve !== false) {
    const r = await resolveMetadata({ text: headText, filename: relPath, fetchImpl: opts.fetchImpl, doiHint: opts.doiHint })
    meta = r
  }

  const insertSource = db.query(
    `INSERT OR REPLACE INTO sources (id, path, kind, title, doi, csl_json, grade, status, added_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'ingested', ?)`,
  )
  const insertChunk = db.query(
    `INSERT OR REPLACE INTO chunks (id, source_id, page, char_start, char_end, line_start, line_end, text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )

  const tx = db.transaction(() => {
    db.query("DELETE FROM chunks WHERE source_id = ?").run(sourceId)
    insertSource.run(
      sourceId, relPath, kind,
      meta.title ?? relPath.split("/").pop() ?? relPath,
      meta.doi, meta.csl ? JSON.stringify(meta.csl) : null, meta.grade, Date.now(),
    )
    for (const c of chunks) {
      insertChunk.run(`${sourceId}:${c.page ?? 0}:${c.charStart}`, sourceId, c.page, c.charStart, c.charEnd, c.lineStart ?? null, c.lineEnd ?? null, c.text)
    }
  })
  tx()

  return {
    sourceId, path: relPath, kind, pages, chunks: chunks.length, alreadyIngested: false,
    ocr: ocrUsed || undefined,
    grade: meta.grade, title: meta.title, doi: meta.doi, matched: meta.matched,
  }
}

export interface SearchHit {
  chunkId: string
  sourcePath: string
  sourceTitle: string | null
  grade: Grade
  page: number | null
  /** "12-34" line range for text documents (md/txt) */
  lines: string | null
  text: string
  score: number
}

export function searchLibrary(db: Database, query: string, k = 6): SearchHit[] {
  // FTS5 BM25; escape each term as a quoted string to avoid syntax errors
  const ftsQuery = query
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replaceAll('"', "")}"`)
    .join(" OR ")
  if (!ftsQuery) return []
  const rows = db
    .query(
      `SELECT c.id, c.page, c.line_start, c.line_end, c.text, s.path, s.title, s.grade, bm25(chunks_fts) AS score
       FROM chunks_fts f
       JOIN chunks c ON c.rowid = f.rowid
       JOIN sources s ON s.id = c.source_id
       WHERE chunks_fts MATCH ?
       ORDER BY score LIMIT ?`,
    )
    .all(ftsQuery, k) as {
    id: string; page: number | null; line_start: number | null; line_end: number | null
    text: string; path: string; title: string | null; grade: Grade; score: number
  }[]
  return rows.map((r) => ({
    chunkId: r.id,
    sourcePath: r.path,
    sourceTitle: r.title,
    grade: r.grade,
    page: r.page,
    lines: r.line_start ? `${r.line_start}-${r.line_end ?? r.line_start}` : null,
    text: r.text,
    score: r.score,
  }))
}

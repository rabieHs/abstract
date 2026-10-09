import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Database, Workspace } from "@abstract/core"

/**
 * Per-source reading notes. Free-form markdown the agent writes INCREMENTALLY
 * while reading (never load a whole long paper at once). Hidden inside the
 * workspace data dir. Notes are navigation/understanding aids — NEVER citable
 * evidence; citations still go through retrieved passages + the verifier.
 */

const notesDir = (ws: Workspace) => join(ws.dataDir, "notes")
const slug = (sourcePath: string) => sourcePath.replace(/[\\/]/g, "__") + ".md"

export function saveNote(
  ws: Workspace,
  sourcePath: string,
  content: string,
  mode: "append" | "overwrite" = "append",
): { file: string; bytes: number } {
  mkdirSync(notesDir(ws), { recursive: true })
  const file = join(notesDir(ws), slug(sourcePath))
  let out = content.trim() + "\n"
  if (mode === "append" && existsSync(file)) {
    out = readFileSync(file, "utf8").trimEnd() + "\n\n" + out
  }
  writeFileSync(file, out)
  return { file: join(".openpaper/notes", slug(sourcePath)), bytes: out.length }
}

export function readNote(ws: Workspace, sourcePath: string): string | null {
  const file = join(notesDir(ws), slug(sourcePath))
  return existsSync(file) ? readFileSync(file, "utf8") : null
}

export function listNotes(ws: Workspace): string[] {
  const dir = notesDir(ws)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3).replace(/__/g, "/"))
}

/** Text of a page range from an ingested PDF — the incremental reading unit. */
export function pagesText(
  db: Database,
  sourcePath: string,
  fromPage: number,
  toPage: number,
): { pages: string; totalPages: number; text: string } | { error: string } {
  const rows = db
    .query(
      `SELECT c.text, c.page FROM chunks c JOIN sources s ON s.id = c.source_id
       WHERE s.path = ? AND c.page BETWEEN ? AND ? AND c.section IS NOT 'visual'
       ORDER BY c.page, c.char_start`,
    )
    .all(sourcePath, fromPage, toPage) as { text: string; page: number }[]
  const total = db
    .query(
      `SELECT MAX(c.page) m FROM chunks c JOIN sources s ON s.id = c.source_id WHERE s.path = ?`,
    )
    .get(sourcePath) as { m: number | null }
  if (!total.m) return { error: `not ingested (or has no pages): ${sourcePath} — run ingest_source first` }
  if (rows.length === 0) return { error: `no text on pages ${fromPage}-${toPage} (document has ${total.m} pages)` }
  let last = 0
  const parts: string[] = []
  for (const r of rows) {
    if (r.page !== last) {
      parts.push(`\n--- page ${r.page} ---\n`)
      last = r.page
    }
    parts.push(r.text)
  }
  return { pages: `${fromPage}-${toPage}`, totalPages: total.m, text: parts.join("\n") }
}

/** record a completed page-range read */
export function logRead(db: Database, sourcePath: string, fromPage: number, toPage: number): void {
  db.query(
    "INSERT INTO read_log (source_path, from_page, to_page, created_at) VALUES (?, ?, ?, ?)",
  ).run(sourcePath, fromPage, toPage, Date.now())
}

/** pages actually read vs total — the mechanical coverage record */
export function readingProgress(
  db: Database,
  sourcePath: string,
): { totalPages: number; readPages: number; unread: string } | null {
  const total = db
    .query("SELECT MAX(c.page) m FROM chunks c JOIN sources s ON s.id = c.source_id WHERE s.path = ?")
    .get(sourcePath) as { m: number | null }
  if (!total.m) return null
  const covered = new Set<number>()
  const rows = db
    .query("SELECT from_page, to_page FROM read_log WHERE source_path = ?")
    .all(sourcePath) as { from_page: number; to_page: number }[]
  for (const r of rows) for (let p = r.from_page; p <= r.to_page; p++) covered.add(p)
  const gaps: string[] = []
  let start: number | null = null
  for (let p = 1; p <= total.m; p++) {
    if (!covered.has(p)) {
      if (start === null) start = p
    } else if (start !== null) {
      gaps.push(start === p - 1 ? `${start}` : `${start}-${p - 1}`)
      start = null
    }
  }
  if (start !== null) gaps.push(start === total.m ? `${start}` : `${start}-${total.m}`)
  return { totalPages: total.m, readPages: covered.size, unread: gaps.join(", ") || "none" }
}

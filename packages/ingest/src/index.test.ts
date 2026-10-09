import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { openDb, openWorkspace } from "@abstract/core"
import { chunkText, ingestFile, searchLibrary } from "./index.ts"

/** Build a minimal valid one-page PDF containing real extractable text. */
function makePdf(text: string): Buffer {
  const lines: string[] = []
  for (let i = 0; i < text.length; i += 90) lines.push(text.slice(i, i + 90))
  const stream =
    "BT /F1 10 Tf 40 750 Td 14 TL " +
    lines.map((l) => `(${l.replace(/[()\\]/g, "")}) Tj T*`).join(" ") +
    " ET"
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]
  let out = "%PDF-1.4\n"
  const offs: number[] = []
  objs.forEach((o, i) => {
    offs.push(out.length)
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  out += offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return Buffer.from(out, "latin1")
}

const PDF_TEXT =
  "The parabolic cooker reached 180C in 22 minutes under clear skies, while the box cooker " +
  "needed 55 minutes to reach 120C. On cloudy days, neither design exceeded 90C, and cooking " +
  "times tripled. Both cookers pasteurized one liter of water in under 40 minutes on clear days."

describe("chunkText", () => {
  test("packs paragraphs and keeps offsets", () => {
    const text = "First paragraph about solar cookers and their efficiency in field trials.\n\nSecond paragraph with more detail on pasteurization times and safety margins."
    const chunks = chunkText(text, 3)
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks[0]!.page).toBe(3)
    expect(text.slice(chunks[0]!.charStart)).toContain("First paragraph")
  })
})

describe("ingest + search", () => {
  const dir = mkdtempSync(join(tmpdir(), "abstract-ingest-"))
  writeFileSync(join(dir, "solar.pdf"), makePdf(PDF_TEXT))
  writeFileSync(join(dir, "notes.md"), "# Notes\n\nThe box cooker is cheaper to build than the parabolic design and needs no tracking.\n")
  const ws = openWorkspace(dir)
  const db = openDb(ws.dbPath)

  test("ingests a PDF with page numbers", async () => {
    const r = await ingestFile(db, ws, "solar.pdf", { resolve: false })
    expect(r.kind).toBe("pdf")
    expect(r.pages).toBe(1)
    expect(r.chunks).toBeGreaterThan(0)
    expect(r.alreadyIngested).toBe(false)
  })

  test("ingests markdown", async () => {
    const r = await ingestFile(db, ws, "notes.md", { resolve: false })
    expect(r.kind).toBe("md")
    expect(r.chunks).toBeGreaterThan(0)
  })

  test("search returns hits with source path and page", () => {
    const hits = searchLibrary(db, "parabolic cooker minutes", 5)
    expect(hits.length).toBeGreaterThan(0)
    const pdfHit = hits.find((h) => h.sourcePath === "solar.pdf")
    expect(pdfHit).toBeDefined()
    expect(pdfHit!.page).toBe(1)
    expect(pdfHit!.text).toContain("parabolic")
  })

  test("re-ingest is idempotent", async () => {
    const r = await ingestFile(db, ws, "solar.pdf", { resolve: false })
    expect(r.alreadyIngested).toBe(true)
  })

  test("search misses gracefully", () => {
    expect(searchLibrary(db, "zzz-nonexistent-term-qqq", 3)).toHaveLength(0)
  })
})

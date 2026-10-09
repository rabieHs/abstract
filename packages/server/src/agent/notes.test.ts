import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDb, openWorkspace } from "@abstract/core"
import { listNotes, pagesText, readNote, saveNote } from "./notes.ts"

describe("reading notes", () => {
  const ws = openWorkspace(mkdtempSync(join(tmpdir(), "abstract-notes-")))

  test("append builds the note incrementally; overwrite replaces", () => {
    saveNote(ws, "sources/paper.pdf", "## p.1-3\nIntro defines frugal AI.")
    saveNote(ws, "sources/paper.pdf", "## p.4-6\nTable 2 (p.5): 65x energy spread.")
    expect(readNote(ws, "sources/paper.pdf")).toContain("Intro defines")
    expect(readNote(ws, "sources/paper.pdf")).toContain("65x energy spread")
    saveNote(ws, "sources/paper.pdf", "fresh start", "overwrite")
    expect(readNote(ws, "sources/paper.pdf")).not.toContain("Intro defines")
  })

  test("lists sources with notes; missing note is null", () => {
    expect(listNotes(ws)).toEqual(["sources/paper.pdf"])
    expect(readNote(ws, "sources/other.pdf")).toBeNull()
  })
})

describe("pagesText", () => {
  const db = openDb(":memory:")
  db.query(
    "INSERT INTO sources (id, path, kind, grade, status, added_at) VALUES ('s1','p.pdf','pdf','note','ingested',1)",
  ).run()
  const ins = db.query(
    "INSERT INTO chunks (id, source_id, section, page, text) VALUES (?, 's1', ?, ?, ?)",
  )
  ins.run("c1", null, 1, "page one text")
  ins.run("c2", null, 2, "page two text")
  ins.run("c3", null, 3, "page three text")
  ins.run("v1", "visual", 2, "[VISUAL] Figure 1 ...")

  test("returns page-marked text for the range, excluding visual chunks", () => {
    const r = pagesText(db, "p.pdf", 1, 2)
    if ("error" in r) throw new Error(r.error)
    expect(r.totalPages).toBe(3)
    expect(r.text).toContain("--- page 1 ---")
    expect(r.text).toContain("page two text")
    expect(r.text).not.toContain("[VISUAL]")
    expect(r.text).not.toContain("page three")
  })

  test("errors honestly for unknown sources and empty ranges", () => {
    expect("error" in pagesText(db, "nope.pdf", 1, 2)).toBe(true)
    expect("error" in pagesText(db, "p.pdf", 7, 9)).toBe(true)
  })
})

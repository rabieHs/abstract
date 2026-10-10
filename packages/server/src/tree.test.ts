import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDb, openWorkspace } from "@abstract/core"
import { buildTree, statEntry } from "./tree.ts"
import { listSourceFiles } from "./agent/tools.ts"

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "abstract-tree-"))
  mkdirSync(join(root, "sources"))
  writeFileSync(join(root, "sources", "paper.pdf"), "%PDF")
  // the shape that broke the panel: a link whose target doesn't exist
  symlinkSync(join(root, "missing", "App.app"), join(root, "sources", "Broken.app"))
  // a link to a file is listed; a link back to a parent folder must not be followed
  writeFileSync(join(root, "notes.md"), "# notes")
  symlinkSync(join(root, "notes.md"), join(root, "sources", "notes-link.md"))
  symlinkSync(root, join(root, "sources", "loop"))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe("file scanning skips what it can't safely follow", () => {
  test("statEntry: broken link → null, linked folder → null, linked file → stats", () => {
    expect(statEntry(join(root, "sources", "Broken.app"))).toBeNull()
    expect(statEntry(join(root, "sources", "loop"))).toBeNull()
    expect(statEntry(join(root, "sources", "notes-link.md"))?.isFile()).toBe(true)
  })

  test("the Files panel tree builds instead of throwing", () => {
    const ws = openWorkspace(root)
    const tree = buildTree(ws, openDb(ws.dbPath))
    const sources = tree.find((n) => n.name === "sources")!
    const names = (sources.children ?? []).map((n) => n.name).sort()
    expect(names).toEqual(["notes-link.md", "paper.pdf"])
  })

  test("the agent's file list skips the broken link and doesn't loop", () => {
    const files = listSourceFiles(openWorkspace(root)).map((f) => f.path).sort()
    expect(files).toEqual(["notes.md", "sources/notes-link.md", "sources/paper.pdf"])
  })
})

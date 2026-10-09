import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDb, openWorkspace } from "@abstract/core"
import { ingestFile } from "./index.ts"
import { embedMissing, hybridSearch, semanticSearch } from "./vec.ts"

// deterministic fake embedder: topic vectors so cosine is meaningful
const fake = async (values: string[]) =>
  values.map((v) => {
    const t = v.toLowerCase()
    return [
      /cook|heat|temperature|solar/.test(t) ? 1 : 0,
      /bird|migration|wing/.test(t) ? 1 : 0,
      /database|query|index/.test(t) ? 1 : 0,
      t.length % 7 / 10,
    ]
  })

describe("semantic + hybrid retrieval", () => {
  const dir = mkdtempSync(join(tmpdir(), "abstract-vec-"))
  writeFileSync(join(dir, "a.md"), "The solar cooker reached a high temperature quickly under clear skies.\n")
  writeFileSync(join(dir, "b.md"), "Bird migration routes shift with warming staging grounds.\n")
  const ws = openWorkspace(dir)
  const db = openDb(ws.dbPath)

  test("embedMissing embeds all chunks once", async () => {
    await ingestFile(db, ws, "a.md", { resolve: false })
    await ingestFile(db, ws, "b.md", { resolve: false })
    const n1 = await embedMissing(db, fake)
    const n2 = await embedMissing(db, fake)
    expect(n1).toBeGreaterThan(0)
    expect(n2).toBe(0)
  })

  test("semantic search finds meaning without keyword overlap", async () => {
    // query shares NO words with a.md but matches its topic vector
    const hits = await semanticSearch(db, fake, "heat from cooking", 1)
    expect(hits[0]!.sourcePath).toBe("a.md")
  })

  test("hybrid falls back to keyword-only without an embedder", async () => {
    const hits = await hybridSearch(db, "migration routes", 2, null)
    expect(hits[0]!.sourcePath).toBe("b.md")
  })

  test("hybrid fuses both and never fails when embedder throws", async () => {
    const broken = async () => {
      throw new Error("offline")
    }
    const hits = await hybridSearch(db, "solar cooker", 2, broken as never)
    expect(hits[0]!.sourcePath).toBe("a.md")
  })
})

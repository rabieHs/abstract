import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDb, type Workspace } from "@abstract/core"
import {
  candidateKey, funnel, logSearch, orphanedDownloads, prismaFlowMarkdown, recordScreening,
  renderLibraryState, upsertCandidates,
} from "./ledger.ts"

function setup() {
  const root = mkdtempSync(join(tmpdir(), "op-ledger-"))
  const db = openDb(join(root, "t.db"))
  return { db, ws: { root, name: "t" } as unknown as Workspace }
}

describe("screening ledger (S3b — the coverage record)", () => {
  test("search log rows persist query-as-run with hits (PRISMA-S)", () => {
    const { db } = setup()
    logSearch(db, "s1", "scholar", "frugal AI evaluation", "discovery", 12)
    logSearch(db, "s1", "snowball:both", "sources/kaur2024.pdf", "snowball", 31)
    const rows = db.query("SELECT source, query, mode, hits FROM searches ORDER BY id").all() as {
      source: string
      query: string
      mode: string
      hits: number
    }[]
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({ source: "scholar", query: "frugal AI evaluation", mode: "discovery", hits: 12 })
    expect(rows[1]!.source).toBe("snowball:both")
  })

  test("candidates upsert: decisions survive re-surfacing by another query", () => {
    const { db } = setup()
    const paper = { title: "Green AI", doi: "10.1/green", year: 2020, venue: "CACM", citedBy: 900 }
    const first = upsertCandidates(db, [paper], "query:green ai")
    expect(first).toEqual({ added: 1, known: 0 })
    recordScreening(db, [{ ref: "10.1/green", decision: "include", reason: "core: defines the agenda" }])
    // the same paper surfaces again via snowball — decision must survive
    const again = upsertCandidates(db, [{ ...paper, citedBy: 950 }], "snowball:seed:backward")
    expect(again).toEqual({ added: 0, known: 1 })
    const row = db.query("SELECT decision, reason, cited_by FROM candidates").get() as {
      decision: string
      reason: string
      cited_by: number
    }
    expect(row.decision).toBe("include")
    expect(row.cited_by).toBe(950) // metadata refreshed, decision intact
  })

  test("recordScreening matches by doi and by title fragment; unmatched reported", () => {
    const { db } = setup()
    upsertCandidates(
      db,
      [
        { title: "A Survey of TinyML Benchmarks", doi: "10.2/tiny" },
        { title: "Unrelated Paper", doi: null },
      ],
      "query:x",
    )
    const r = recordScreening(db, [
      { ref: "10.2/tiny", decision: "include", reason: "on-topic" },
      { ref: "Unrelated Paper", decision: "exclude", reason: "off-topic: no evaluation" },
      { ref: "does-not-exist-anywhere", decision: "exclude", reason: "x" },
    ])
    expect(r.updated).toBe(2)
    expect(r.unmatched).toEqual(["does-not-exist-anywhere"])
    const f = funnel(db)
    expect(f).toMatchObject({ identified: 2, screened: 2, included: 1, excluded: 1 })
  })

  test("candidateKey: doi wins; title normalization otherwise", () => {
    expect(candidateKey({ doi: "10.1/A", title: "x" })).toBe("doi:10.1/a")
    expect(candidateKey({ title: "The  Paper: A Story!" })).toBe("t:the paper a story")
  })

  test("library_state renders the funnel and flags unscreened candidates", () => {
    const { db, ws } = setup()
    upsertCandidates(db, [{ title: "P1", doi: "10.3/p1" }, { title: "P2", doi: "10.3/p2" }], "query:q")
    recordScreening(db, [{ ref: "10.3/p1", decision: "include", reason: "fits" }])
    const s = renderLibraryState(db, ws)
    expect(s).toContain("2 identified → 1 screened → 1 included")
    expect(s).toContain("1 candidates never screened")
  })

  test("orphaned downloads: a file in sources/ with no sources row is flagged (S14)", () => {
    const { db, ws } = setup()
    mkdirSync(join(ws.root, "sources"), { recursive: true })
    writeFileSync(join(ws.root, "sources", "never-ingested.pdf"), "%PDF-fake")
    expect(orphanedDownloads(db, ws)).toEqual(["sources/never-ingested.pdf"])
    expect(renderLibraryState(db, ws)).toContain("⚠ 1 downloaded-but-never-ingested")
  })

  test("PRISMA flow renders queries, counts and exclusion reasons from the record", () => {
    const { db } = setup()
    logSearch(db, "s1", "scholar", "energy benchmark edge", "discovery", 9)
    upsertCandidates(
      db,
      [
        { title: "K1", doi: "10.4/k1" },
        { title: "K2", doi: "10.4/k2" },
        { title: "K3", doi: "10.4/k3" },
      ],
      "query:energy benchmark edge",
    )
    recordScreening(db, [
      { ref: "10.4/k1", decision: "include", reason: "core" },
      { ref: "10.4/k2", decision: "exclude", reason: "off-topic: cloud only" },
      { ref: "10.4/k3", decision: "exclude", reason: "off-topic: cloud only" },
    ])
    const md = prismaFlowMarkdown(db)
    expect(md).toContain("| scholar | discovery | energy benchmark edge | 9 |")
    expect(md).toContain('Records identified (n=3)')
    expect(md).toContain('Included (n=1)')
    expect(md).toContain("off-topic: cloud only (n=2)")
    expect(md).toContain("```mermaid")
  })
})

import { gapCounterSearches, gapTokens } from "./synthesize.ts"

describe("gap counter-search gate (S6)", () => {
  test("a gap with matching logged searches is search-bounded", () => {
    const { db } = setup()
    logSearch(db, "s1", "scholar", "multilingual fairness evaluation datasets", "discovery", 4)
    logSearch(db, "s1", "scholar", "unrelated quantum entanglement", "discovery", 9)
    const hits = gapCounterSearches(db, "no study evaluates fairness on multilingual datasets")
    expect(hits).toHaveLength(1)
    expect(hits[0]!.query).toContain("multilingual fairness")
  })
  test("a gap nobody searched for gets zero counter-searches (the hunch case)", () => {
    const { db } = setup()
    logSearch(db, "s1", "scholar", "energy benchmark edge inference", "discovery", 12)
    expect(gapCounterSearches(db, "no work considers privacy leakage in federated updates")).toHaveLength(0)
  })
  test("gapTokens drops stopwords and short words", () => {
    const t = gapTokens("the corpus does not settle how multilingual fairness works")
    expect(t.has("multilingual")).toBe(true)
    expect(t.has("corpus")).toBe(false)
    expect(t.has("the")).toBe(false)
  })
})

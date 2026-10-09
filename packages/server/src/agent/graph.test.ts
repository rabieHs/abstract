import { beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDb, type Database } from "@abstract/core"
import { centralConcepts, graphSize, neighbors, sharedConcepts } from "./graph.ts"

let db: Database
beforeEach(() => {
  db = openDb(join(mkdtempSync(join(tmpdir(), "op-graph-")), "t.db"))
  // seed a source + chunks so edges have real chunk provenance (FK-satisfying)
  db.query("INSERT INTO sources (id, path, kind, added_at) VALUES ('s1','a.pdf','pdf',0)").run()
  db.query("INSERT INTO sources (id, path, kind, added_at) VALUES ('s2','b.pdf','pdf',0)").run()
  for (const [id, sid] of [["c1", "s1"], ["c2", "s2"]] as const)
    db.query("INSERT INTO chunks (id, source_id, text) VALUES (?, ?, 'x')").run(id, sid)
  const node = (id: string, label: string) =>
    db.query("INSERT OR IGNORE INTO graph_nodes (id,label,kind,created_at) VALUES (?,?,?,0)").run(id, label, "concept")
  const edge = (eid: string, s: string, d: string, rel: string, src: string, chunk: string) =>
    db
      .query("INSERT INTO graph_edges (id,src,dst,relation,source_path,chunk_id,confidence,created_at) VALUES (?,?,?,?,?,?,'EXTRACTED',0)")
      .run(eid, s, d, rel, src, chunk)
  ;["rapl", "codecarbon", "energy", "minicheck", "entailment"].forEach((n) => node(n, n.toUpperCase()))
  // paper a: rapl uses energy; codecarbon uses rapl
  edge("e1", "codecarbon", "rapl", "uses", "a.pdf", "c1")
  edge("e2", "rapl", "energy", "measures", "a.pdf", "c1")
  // paper b: minicheck uses entailment; minicheck relates to energy too (shared node)
  edge("e3", "minicheck", "entailment", "uses", "b.pdf", "c2")
  edge("e4", "minicheck", "energy", "mentions", "b.pdf", "c2")
})

describe("concept graph queries", () => {
  test("graphSize counts nodes, edges, sources", () => {
    expect(graphSize(db)).toEqual({ nodes: 5, edges: 4, sources: 2 })
  })

  test("neighbors returns connected concepts WITH chunk provenance", () => {
    const n = neighbors(db, "RAPL") // case-insensitive via norm
    const others = n.map((h) => h.other).sort()
    expect(others).toEqual(["codecarbon", "energy"])
    expect(n.every((h) => h.chunkId && h.source && h.confidence === "EXTRACTED")).toBe(true)
  })

  test("sharedConcepts finds the cross-paper link (energy, in both papers) — pure graph logic", () => {
    const shared = sharedConcepts(db)
    const energy = shared.find((s) => s.concept === "energy")
    expect(energy).toBeTruthy()
    expect(energy!.sources.sort()).toEqual(["a.pdf", "b.pdf"])
    // rapl is only in paper a — must NOT be reported as shared
    expect(shared.some((s) => s.concept === "rapl")).toBe(false)
  })

  test("centralConcepts ranks by degree", () => {
    const c = centralConcepts(db)
    expect(c[0]!.degree).toBe(2) // energy/rapl/minicheck tie at 2
    const top = c.filter((x) => x.degree === 2).map((x) => x.concept).sort()
    expect(top).toEqual(["energy", "minicheck", "rapl"])
    expect(c.at(-1)!.degree).toBe(1) // codecarbon/entailment at the bottom
  })

  test("neighbors of an unknown concept is empty, never throws", () => {
    expect(neighbors(db, "quantum-gravity")).toEqual([])
  })
})

import { canonicalizeLabels, resolveConcept, MERGE_THRESHOLD } from "./graph.ts"
import { mkdtempSync as mkdt } from "node:fs"
import { tmpdir as tdir } from "node:os"
import { join as pj } from "node:path"
import { openDb as odb } from "@abstract/core"

describe("graph v2 canonicalization (S13 — embedding merge with aliases)", () => {
  // fake embedder: 'llm'-family labels share a vector; others are orthogonal
  const fake = async (labels: string[]) =>
    labels.map((l) => (/llm|large language model/i.test(l) ? [1, 0.05, 0] : [0, 1, 0]))

  test("same-meaning surface forms merge into ONE canonical node with an alias", async () => {
    const db = odb(pj(mkdt(pj(tdir(), "op-g2-")), "t.db"))
    const first = await canonicalizeLabels(db, ["large language models"], fake)
    expect(first.get("large language models")).toBe("large language models")
    db.query("INSERT INTO graph_nodes (id, label, kind, created_at) VALUES (?,?,?,?)")
      .run("large language models", "large language models", "concept", Date.now())
    const second = await canonicalizeLabels(db, ["LLM"], fake)
    expect(second.get("llm")).toBe("large language models") // merged, not split
    expect(resolveConcept(db, "LLM")).toBe("large language models") // alias resolves
  })
  test("distinct concepts stay distinct (high threshold, no false merges)", async () => {
    const db = odb(pj(mkdt(pj(tdir(), "op-g3-")), "t.db"))
    await canonicalizeLabels(db, ["large language models"], fake)
    db.query("INSERT INTO graph_nodes (id, label, kind, created_at) VALUES (?,?,?,?)")
      .run("large language models", "large language models", "concept", Date.now())
    const r = await canonicalizeLabels(db, ["carbon accounting"], fake)
    expect(r.get("carbon accounting")).toBe("carbon accounting")
    expect(MERGE_THRESHOLD).toBeGreaterThanOrEqual(0.9)
  })
  test("no embedder → v1 behavior (norm is the id), never a crash", async () => {
    const db = odb(pj(mkdt(pj(tdir(), "op-g4-")), "t.db"))
    const r = await canonicalizeLabels(db, ["Some New Concept"], null)
    expect(r.get("some new concept")).toBe("some new concept")
  })
})

import { describe, expect, test } from "bun:test"
import { openDb } from "@abstract/core"
import { searchLibrary } from "@abstract/ingest"
import { storeVisuals } from "./visuals.ts"

describe("visual inventory", () => {
  const db = openDb(":memory:")
  db.query(
    "INSERT INTO sources (id, path, kind, title, grade, status, added_at) VALUES ('src1', 'paper.pdf', 'pdf', 'A Paper', 'preprint', 'ingested', 1)",
  ).run()

  test("stored visuals become searchable chunks with page numbers", () => {
    const n = storeVisuals(db, "src1", [
      {
        kind: "figure",
        label: "Figure 3",
        page: 5,
        description: "Energy per query across eight models; DeepSeek-R1 highest at 29 Wh.",
      },
      {
        kind: "table",
        label: "Table 1",
        page: 2,
        description: "Accuracy and latency per quantization level, INT8 best trade-off.",
      },
    ])
    expect(n).toBe(2)
    const hits = searchLibrary(db, "energy per query models", 5)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.text).toContain("[VISUAL] Figure 3")
    expect(hits[0]!.page).toBe(5)
    expect(hits[0]!.sourcePath).toBe("paper.pdf")
  })

  test("re-storing is idempotent by chunk id", () => {
    storeVisuals(db, "src1", [
      { kind: "figure", label: "Figure 3", page: 5, description: "updated description." },
    ])
    const rows = db.query("SELECT COUNT(*) c FROM chunks WHERE id LIKE 'src1:vis:%'").get() as {
      c: number
    }
    expect(rows.c).toBe(2)
  })
})

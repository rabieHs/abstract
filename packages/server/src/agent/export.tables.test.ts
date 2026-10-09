import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDb, type Workspace } from "@abstract/core"
import { exportDraft } from "./export.ts"
import { tableToMarkdown } from "./draft.ts"

const okDoiFetch = (async (url: string) => {
  if (url.includes("doi.org/api/handles"))
    return new Response(JSON.stringify({ responseCode: 1 }), { status: 200 })
  if (url.includes("api.crossref.org"))
    return new Response(JSON.stringify({ message: { title: ["A paper"] } }), { status: 200 })
  return new Response("{}", { status: 200 })
}) as unknown as typeof fetch

describe("tableToMarkdown", () => {
  test("renders a GFM pipe table with caption and escapes pipes", () => {
    const md = tableToMarkdown({
      caption: "Tools compared",
      columns: ["Tool", "Metric"],
      rows: [[{ text: "MLPerf" }, { text: "energy | power" }]],
    })
    expect(md).toContain("*Tools compared*")
    expect(md).toContain("| Tool | Metric |")
    expect(md).toContain("| --- | --- |")
    expect(md).toContain("energy \\| power") // pipe escaped inside a cell
  })
})

describe("exportDraft with a verified table", () => {
  function setup() {
    const root = mkdtempSync(join(tmpdir(), "op-exp-"))
    mkdirSync(join(root, "drafts"), { recursive: true })
    const db = openDb(join(root, "test.db"))
    db.query(
      "INSERT INTO sources (id, path, kind, title, doi, csl_json, grade, status, added_at) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run(
      "s1", "sources/a.pdf", "pdf", "Paper A", "10.1/a",
      JSON.stringify({ DOI: "10.1/a", title: ["Paper A"], author: [{ family: "Smith" }], issued: { "date-parts": [[2024]] } }),
      "peer_reviewed", "ingested", Date.now(),
    )
    db.query("INSERT INTO chunks (id, source_id, page, text) VALUES (?,?,?,?)").run(
      "c1", "s1", 3, "MLPerf Power measures energy at the wall.",
    )
    const draft = {
      file: "drafts/d.md",
      dataFile: "drafts/d.json",
      version: 1,
      sentences: [
        { text: "The field measures energy several ways.", cites: [], verdict: "uncited", quotes: [], invalidCites: [], heading: "Measurement" },
      ],
      tables: [
        {
          heading: "Measurement",
          caption: "Tools",
          columns: ["Tool", "What it measures"],
          rows: [
            [
              { text: "MLPerf Power", cites: [], verdict: "uncited", quotes: [], invalidCites: [] },
              { text: "wall energy", cites: ["c1"], verdict: "supported", quotes: ["energy at the wall"], invalidCites: [] },
            ],
          ],
        },
      ],
      sources: [{ chunkId: "c1", path: "sources/a.pdf", page: 3, grade: "peer_reviewed" }],
      summary: { supported: 1, partial: 0, unsupported: 0, uncited: 1 },
    }
    writeFileSync(join(root, "drafts/d.json"), JSON.stringify(draft))
    return { root, db, ws: { root } as Workspace }
  }

  test("table appears in the final markdown with a numbered citation", async () => {
    const { root, db, ws } = setup()
    const r = await exportDraft(db, ws, "drafts/d.json", { fetchImpl: okDoiFetch })
    expect("files" in r).toBe(true)
    if (!("files" in r)) return
    const finalMd = readFileSync(join(root, r.files.document), "utf8")
    expect(finalMd).toContain("| Tool | What it measures |")
    expect(finalMd).toContain("wall energy [1]") // table cell cite numbered like prose
    expect(finalMd).toContain("[1] Smith") // reference from the table-only source
    expect(r.references).toBe(1)
  })

  test("table renders as a LaTeX tabular", async () => {
    const { root, db, ws } = setup()
    const r = await exportDraft(db, ws, "drafts/d.json", { fetchImpl: okDoiFetch })
    if (!("files" in r)) throw new Error("export failed")
    const tex = readFileSync(join(root, r.files.latex), "utf8")
    expect(tex).toContain("\\begin{tabular}")
    expect(tex).toContain("\\cite{ref1}")
  })

  test("audit records per-cell verdicts", async () => {
    const { root, db, ws } = setup()
    const r = await exportDraft(db, ws, "drafts/d.json", { fetchImpl: okDoiFetch })
    if (!("files" in r)) throw new Error("export failed")
    const audit = JSON.parse(readFileSync(join(root, r.files.audit), "utf8"))
    expect(audit.tables).toHaveLength(1)
    expect(audit.tables[0].rows[0][1].verdict).toBe("supported")
  })

  test("an unsupported table cell blocks export unless acknowledged", async () => {
    const { root, db, ws } = setup()
    const draft = JSON.parse(readFileSync(join(root, "drafts/d.json"), "utf8"))
    draft.tables[0].rows[0][1].verdict = "unsupported"
    draft.summary.unsupported = 1
    writeFileSync(join(root, "drafts/d.json"), JSON.stringify(draft))
    const blocked = await exportDraft(db, ws, "drafts/d.json", { fetchImpl: okDoiFetch })
    expect("error" in blocked).toBe(true)
    const forced = await exportDraft(db, ws, "drafts/d.json", { acknowledge: true, fetchImpl: okDoiFetch })
    expect("files" in forced).toBe(true)
  })
})

describe("exportDraft on a PLAIN document (verified:false)", () => {
  test("returns the md/html as final artifacts — no gates, no author-position warning", async () => {
    const root = mkdtempSync(join(tmpdir(), "op-plain-"))
    mkdirSync(join(root, "drafts"), { recursive: true })
    const db = openDb(join(root, "t.db"))
    writeFileSync(
      join(root, "drafts/roadmap.json"),
      JSON.stringify({
        file: "drafts/roadmap.md",
        dataFile: "drafts/roadmap.json",
        version: 1,
        sentences: [
          { text: "Phase 1 grounds the concept.", cites: [], verdict: "uncited", quotes: [], invalidCites: [], heading: "Roadmap" },
        ],
        tables: [],
        sources: [],
        summary: { supported: 0, partial: 0, unsupported: 0, uncited: 1 },
        verified: false,
      }),
    )
    const r = await exportDraft(db, { root } as Workspace, "drafts/roadmap.json", { fetchImpl: okDoiFetch })
    expect("files" in r).toBe(true)
    if (!("files" in r)) return
    expect(r.files.document).toBe("drafts/roadmap.md")
    expect((r.files as Record<string, string>).html).toBe("drafts/roadmap.html")
    expect(JSON.stringify(r)).not.toContain("author's own position")
    expect(JSON.stringify(r)).toContain("plain document")
  })
})

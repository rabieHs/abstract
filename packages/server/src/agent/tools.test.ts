import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDb, type Workspace } from "@abstract/core"
import { makeTools } from "./tools.ts"

function setup() {
  const root = mkdtempSync(join(tmpdir(), "op-tools-"))
  const db = openDb(join(root, "t.db"))
  const ws = { root, name: "t" } as unknown as Workspace
  return {
    db,
    ws,
    tools: makeTools(ws, db, "s1") as unknown as Record<
      string,
      { execute: (i: never, o: unknown) => Promise<Record<string, unknown>> }
    >,
  }
}
const opts = { toolCallId: "t1" }

describe("run_code (S9 — computed numbers, jailed env)", () => {
  test("runs analysis on a workspace file; artifacts listed; credentials stripped", async () => {
    const { ws, tools } = setup()
    writeFileSync(join(ws.root, "results.csv"), "method,acc\nA,0.91\nB,0.87\n")
    process.env["ANTHROPIC_API_KEY"] = process.env["ANTHROPIC_API_KEY"] ?? "test-secret"
    const r = await tools["run_code"]!.execute(
      {
        script:
          "import csv, os, json\n" +
          "rows = list(csv.DictReader(open('results.csv')))\n" +
          "best = max(rows, key=lambda r: float(r['acc']))\n" +
          "open('analysis/best.json','w').write(json.dumps(best))\n" +
          "print('best', best['method'], best['acc'])\n" +
          "print('leak', 'ANTHROPIC_API_KEY' in os.environ)\n",
        timeout_s: 30,
      } as never,
      opts,
    )
    expect(r["exit_code"]).toBe(0)
    expect(String(r["stdout"])).toContain("best A 0.91")
    expect(String(r["stdout"])).toContain("leak False") // credentials stripped
    expect((r["artifacts"] as string[])).toContain("analysis/best.json")
    expect(JSON.parse(readFileSync(join(ws.root, "analysis/best.json"), "utf8")).method).toBe("A")
  })
  test("wall-clock cap kills a runaway script with a teaching error", async () => {
    const { tools } = setup()
    const r = await tools["run_code"]!.execute(
      { script: "import time\ntime.sleep(30)\n", timeout_s: 2 } as never,
      opts,
    )
    expect(String(r["error"])).toContain("wall-clock cap")
  }, 15_000)
})

describe("save_protocol (S8 — versioned methodology contract)", () => {
  test("creates v1, updates to v2 with history; post-hoc hypotheses labeled", async () => {
    const { ws, tools } = setup()
    const base = {
      slug: "fate-eval",
      rqs: [{ id: "RQ1", question: "How can fairness and energy be jointly scored on edge models?", outcome: "composite score validity" }],
      hypotheses: [{ id: "H1", h0: "no rank change vs accuracy-only", h1: "ranking changes materially", primary_outcome: "rank correlation", declared_before_data: true }],
      design: "5 edge vision models, 3 seeds, fairness (DP diff) + energy (J/inference) on fixed hardware; Spearman vs accuracy-only ranking.",
      threats: [{ category: "external", name: "hardware mono-operation", status: "accepted", how: "single MCU class; scoped claims" }],
    }
    const v1 = await tools["save_protocol"]!.execute(base as never, opts)
    expect(v1["version"]).toBe(1)
    const v2 = await tools["save_protocol"]!.execute(
      { ...base, hypotheses: [...base.hypotheses, { id: "H2", h0: "x", h1: "y", primary_outcome: "z", declared_before_data: false }] } as never,
      opts,
    )
    expect(v2["version"]).toBe(2)
    expect(String(v2["exploratory_note"])).toContain("post-hoc")
    const stored = JSON.parse(readFileSync(join(ws.root, "drafts/protocol-fate-eval.json"), "utf8"))
    expect(stored.version).toBe(2)
    expect(stored.history).toHaveLength(1)
    expect(stored.history[0].version).toBe(1)
    const md = readFileSync(join(ws.root, "drafts/protocol-fate-eval.md"), "utf8")
    expect(md).toContain("| external | hardware mono-operation | accepted |")
    expect(md).toContain("*(post-hoc — exploratory)*")
  })
})

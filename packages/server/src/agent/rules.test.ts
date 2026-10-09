import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { evaluateRules, loadRules, type ToolRule } from "./rules.ts"

describe("hooks v1 — PreToolUse rules as data (C10)", () => {
  test("exact, glob and wildcard tool matching with optional input regex", () => {
    const rules: ToolRule[] = [
      { name: "no-arxiv", tool: "fetch_paper", input_matches: "arxiv\\.org", action: "block", message: "no arXiv mirrors" },
      { name: "no-exports", tool: "export_*", action: "block", message: "exports are off this week" },
    ]
    expect(evaluateRules(rules, "fetch_paper", { pdfUrl: "https://arxiv.org/pdf/1" })?.rule).toBe("no-arxiv")
    expect(evaluateRules(rules, "fetch_paper", { doi: "10.1/x" })).toBeNull() // regex not matched
    expect(evaluateRules(rules, "export_draft", {})?.message).toBe("exports are off this week")
    expect(evaluateRules(rules, "read_pages", {})).toBeNull()
  })
  test("a bad regex disables the rule, never the tool", () => {
    const rules: ToolRule[] = [
      { name: "broken", tool: "fetch_paper", input_matches: "([", action: "block", message: "x" },
    ]
    expect(evaluateRules(rules, "fetch_paper", { doi: "10.1/x" })).toBeNull()
  })
  test("loadRules reads json files (object or array), skips malformed", () => {
    const dir = mkdtempSync(join(tmpdir(), "op-rules-"))
    process.env["ABSTRACT_RULES_DIR"] = dir
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "one.json"), JSON.stringify({ tool: "fetch_paper", action: "block", message: "m1" }))
    writeFileSync(join(dir, "many.json"), JSON.stringify([
      { name: "a", tool: "snowball", action: "block", message: "m2" },
      { tool: "nope" }, // invalid — skipped
    ]))
    writeFileSync(join(dir, "broken.json"), "{ not json")
    const rules = loadRules()
    expect(rules).toHaveLength(2)
    expect(rules.find((r) => r.name === "one")?.message).toBe("m1")
    expect(rules.find((r) => r.name === "a")?.tool).toBe("snowball")
    delete process.env["ABSTRACT_RULES_DIR"]
  })
  test("no rules dir → empty, zero overhead path", () => {
    process.env["ABSTRACT_RULES_DIR"] = join(tmpdir(), "does-not-exist-xyz")
    expect(loadRules()).toEqual([])
    delete process.env["ABSTRACT_RULES_DIR"]
  })
})

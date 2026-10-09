import { existsSync, readdirSync, readFileSync } from "node:fs"
import { GLOBAL_DIR } from "@abstract/core"
import { join } from "node:path"

/**
 * Hooks v1 (C10, scoped to the audit's spec): USER-AUTHORED PreToolUse
 * rules as data — the hookify pattern. Each rule can BLOCK a tool call
 * before it runs, and the message is fed back to the model as the tool
 * result, so the agent routes around it instead of stalling.
 *
 * Rules live in ~/.abstract/rules/*.json — one rule object or an array:
 *   { "name": "no-arxiv-fetch",
 *     "tool": "fetch_paper",              // exact name or trailing * glob
 *     "input_matches": "arxiv\\.org",     // optional regex over the JSON input
 *     "action": "block",
 *     "message": "this project forbids fetching from arXiv mirrors" }
 *
 * No default rules ship. Rules can never GRANT anything — they only
 * narrow; the code-level integrity gates stay authoritative either way.
 */

export interface ToolRule {
  name: string
  tool: string
  input_matches?: string
  action: "block"
  message: string
}

function rulesDir(): string {
  return process.env["ABSTRACT_RULES_DIR"] || join(GLOBAL_DIR, "rules")
}

export function loadRules(): ToolRule[] {
  const dir = rulesDir()
  if (!existsSync(dir)) return []
  const out: ToolRule[] = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue
    try {
      const parsed = JSON.parse(readFileSync(join(dir, f), "utf8")) as ToolRule | ToolRule[]
      for (const r of Array.isArray(parsed) ? parsed : [parsed]) {
        if (r && typeof r.tool === "string" && r.action === "block" && typeof r.message === "string") {
          out.push({ ...r, name: r.name || f.replace(/\.json$/, "") })
        }
      }
    } catch {
      // a malformed rule file must never break the agent — it is skipped
    }
  }
  return out
}

function toolMatches(pattern: string, toolName: string): boolean {
  if (pattern === "*") return true
  if (pattern.endsWith("*")) return toolName.startsWith(pattern.slice(0, -1))
  return pattern === toolName
}

/** first matching block rule, or null to proceed */
export function evaluateRules(
  rules: ToolRule[],
  toolName: string,
  input: unknown,
): { rule: string; message: string } | null {
  if (rules.length === 0) return null
  const inputStr = JSON.stringify(input ?? {})
  for (const r of rules) {
    if (!toolMatches(r.tool, toolName)) continue
    if (r.input_matches) {
      try {
        if (!new RegExp(r.input_matches, "i").test(inputStr)) continue
      } catch {
        continue // a bad regex disables the rule, never the tool
      }
    }
    return { rule: r.name, message: r.message }
  }
  return null
}

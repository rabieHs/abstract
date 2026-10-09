import { homedir } from "node:os"
import { join } from "node:path"
import { mkdirSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { z } from "zod"

/** app-wide folder: settings and keys, ChatGPT sign-in, skills, rules */
export const GLOBAL_DIR = join(homedir(), ".abstract")
/** its name before the open-source release */
const LEGACY_GLOBAL_DIR = join(homedir(), ".openpaper")

/**
 * One-time move of ~/.openpaper to ~/.abstract, run by the CLI before anything
 * reads settings. Never merges and never overwrites: if both exist, both are
 * left alone and ~/.abstract wins. Workspace .openpaper folders are untouched.
 */
export function migrateLegacyGlobalDir(
  from: string = LEGACY_GLOBAL_DIR,
  to: string = GLOBAL_DIR,
): { result: "moved" | "none" | "both-exist" | "failed"; error?: string } {
  if (!existsSync(from)) return { result: "none" }
  if (existsSync(to)) return { result: "both-exist" }
  try {
    renameSync(from, to)
    return { result: "moved" }
  } catch (err) {
    return { result: "failed", error: err instanceof Error ? err.message : String(err) }
  }
}

const ProviderConfig = z.object({
  apiKey: z.string().optional(),
  baseURL: z.string().optional(),
})

/**
 * Per-turn spend budget — a task budget the
 * MODEL is made aware of so it paces and lands the plane, plus a hard stop.
 * Nothing here is hardcoded at the loop: these are user settings with
 * calibrated defaults (soft = above any normal single task observed live;
 * hard = 2× soft, the ceiling of one turn's damage). 0 disables a line.
 */
const BudgetConfig = z.object({
  /** cumulative input tokens per budget segment before a one-time wrap-up steer */
  turnSoftInputTokens: z.number().default(1_500_000),
  /** cumulative input tokens per budget segment before the segment ends */
  turnHardInputTokens: z.number().default(3_000_000),
  /**
   * LONG-TASK auto-continuation (the ralph-loop pattern): when the hard line
   * hits with the plan still open, the harness compacts the turn's own steps
   * and continues in a fresh budget segment instead of stalling half-done —
   * up to this many extra segments per user message. Completion condition is
   * an empty plan. 0 = stop at the hard line and wait for the user; raise it
   * for overnight research runs.
   */
  maxAutoContinues: z.number().default(2),
  /**
   * Mid-turn AUTO-COMPACT trigger (ideally derived from the model's
   * context window, minus headroom). We route to
   * five providers without a per-model window catalog yet, so this is a
   * setting: 110K is safe under the smallest common window (200K) with
   * tools + system + output headroom. Raise it on long-context models;
   * per-model derivation is the planned upgrade once the model catalog lands.
   */
  compactAtInputTokens: z.number().default(110_000),
  /**
   * NATIVE Anthropic task budget (output_config.task_budget): the API itself
   * injects a token countdown the model paces against — the first-class
   * version of our wrap-up steer. OPT-IN and Anthropic-only: 0 (default)
   * sends nothing; a value > 0 is injected into every /messages request.
   */
  nativeTaskBudgetTokens: z.number().default(0),
})

export const Config = z.object({
  /** provider id -> credentials. Env vars take precedence; this is the fallback. */
  providers: z.record(ProviderConfig).default({}),
  /** role -> "provider/model-id", e.g. orchestrator: "anthropic/claude-sonnet-5" */
  roles: z.record(z.string()).default({}),
  port: z.number().default(4477),
  /** most recently opened workspace roots, newest first */
  recentWorkspaces: z.array(z.string()).default([]),
  budgets: BudgetConfig.default({}),
})
export type Config = z.infer<typeof Config>

export function loadConfig(): Config {
  const file = join(GLOBAL_DIR, "config.json")
  if (!existsSync(file)) return Config.parse({})
  try {
    const config = Config.parse(JSON.parse(readFileSync(file, "utf8")))
    // "abstract/…" roles pointed at the retired hosted-credits gateway — drop
    // them so each role falls back to the user's own providers
    for (const [role, spec] of Object.entries(config.roles)) {
      if (spec.startsWith("abstract/")) delete config.roles[role]
    }
    return config
  } catch (err) {
    console.error(`warning: could not parse ${file}, using defaults —`, err)
    return Config.parse({})
  }
}

export function saveConfig(config: Config): void {
  mkdirSync(GLOBAL_DIR, { recursive: true })
  writeFileSync(join(GLOBAL_DIR, "config.json"), JSON.stringify(config, null, 2))
}

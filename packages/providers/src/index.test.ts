import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { Config } from "@abstract/core"
import { anthropicBudgetFetch, ollamaBaseURL, recentModels, roleSpec } from "./index.ts"

const ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "OPENROUTER_API_KEY",
  "OLLAMA_HOST",
  "ABSTRACT_CHATGPT_STORE",
]
let saved: Record<string, string | undefined> = {}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  for (const k of ENV_KEYS) delete process.env[k]
  // never read the developer's real ChatGPT sign-in
  process.env["ABSTRACT_CHATGPT_STORE"] = join(tmpdir(), `no-chatgpt-${process.pid}.json`)
})
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

const cfg = (roles: Record<string, string>, providers: Config["providers"]): Config =>
  ({ roles, providers, recentWorkspaces: [] }) as unknown as Config

describe("one chat model for every role", () => {
  test("the model picked in the chat box wins while its provider is active", () => {
    const c = cfg({ orchestrator: "openai/gpt-5.1" }, { openai: { apiKey: "sk-x" } })
    expect(roleSpec("orchestrator", c)).toBe("openai/gpt-5.1")
  })

  test("verifier and screener run on that same model; old per-role choices are ignored", () => {
    const c = cfg(
      { orchestrator: "openai/gpt-5.5", verifier: "openai/gpt-5.4-mini", screener: "openai/gpt-5.4-nano" },
      { openai: { apiKey: "sk-x" } },
    )
    expect(roleSpec("verifier", c)).toBe("openai/gpt-5.5")
    expect(roleSpec("screener", c)).toBe("openai/gpt-5.5")
  })

  test("a pick on a provider with NO key falls back to an active provider's default", () => {
    // the exact incident: saved as google/... but only an OpenAI key exists
    const c = cfg({ orchestrator: "google/gemini-3.5-flash" }, { openai: { apiKey: "sk-x" } })
    expect(roleSpec("orchestrator", c)).toBe("openai/gpt-5.5")
  })

  test("no active provider at all resolves to undefined (503 path, not a crash)", () => {
    const c = cfg({ orchestrator: "google/gemini-3.5-flash" }, {})
    expect(roleSpec("orchestrator", c)).toBeUndefined()
  })

  test("a malformed pick self-heals to the default", () => {
    const c = cfg({ orchestrator: "not-a-spec" }, { openai: { apiKey: "sk-x" } })
    expect(roleSpec("orchestrator", c)).toBe("openai/gpt-5.5")
  })

  test("defaults come from a family, not the first listed model (Sonnet, not Haiku)", () => {
    const c = cfg({}, { anthropic: { apiKey: "sk-ant-x" } })
    expect(roleSpec("orchestrator", c)).toBe("anthropic/claude-sonnet-5-5")
  })

  test("embeddings resolve separately and are never the chat model", () => {
    const c = cfg({ orchestrator: "openai/gpt-5.5" }, { openai: { apiKey: "sk-x" } })
    expect(roleSpec("embeddings", c)).toBe("openai/text-embedding-3-small")
  })
})

describe("recentModels keeps the newest version of each family", () => {
  // the live lists as the providers returned them on 2026-10-09
  const anthropic = [
    "claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1", "claude-opus-5",
    "claude-sonnet-5", "claude-fable-5", "claude-opus-4-8", "claude-opus-4-7", "claude-sonnet-4-6",
    "claude-opus-4-6", "claude-opus-4-5-20251101", "claude-haiku-4-5-20251001", "claude-sonnet-4-5-20250929",
  ]
  const openai = [
    "o4-mini-2025-04-16", "o4-mini", "o3", "o1-pro", "gpt-live-1", "gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna",
    "gpt-6-astra", "gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.5-pro-2026-04-23", "gpt-5.5-pro",
    "gpt-5.5-2026-04-23", "gpt-5.5", "gpt-5.4-nano", "gpt-5.4-mini-2026-03-17", "gpt-5.4-mini", "gpt-5.4",
    "gpt-5.3-chat-latest", "gpt-5.2", "gpt-5.1", "gpt-5-mini", "gpt-5", "gpt-4o-mini", "gpt-4o", "gpt-4.1",
    "gpt-4-turbo", "gpt-4", "gpt-3.5-turbo-0125", "gpt-3.5-turbo",
  ]

  test("Anthropic: one model per family", () => {
    expect(recentModels("anthropic", anthropic).sort()).toEqual(
      ["claude-fable-5-1", "claude-haiku-5-5", "claude-opus-5-5", "claude-sonnet-5-5"],
    )
  })

  test("OpenAI: no snapshots, no aliases, nothing a generation behind", () => {
    expect(recentModels("openai", openai).sort()).toEqual(
      ["gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.5", "gpt-5.5-pro", "gpt-5.6-terra", "gpt-6-astra", "gpt-6-luna", "gpt-6.1-sol"],
    )
  })

  test("ChatGPT plan list", () => {
    const plan = ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]
    expect(recentModels("chatgpt", plan)).toEqual(["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna", "gpt-5.6-terra"])
  })

  test("Google: a GA release beats a preview of the same version", () => {
    expect(recentModels("google", ["gemini-3.5-flash", "gemini-3.1-flash", "gemini-3.5-pro-preview", "gemini-3.5-pro"]).sort())
      .toEqual(["gemini-3.5-flash", "gemini-3.5-pro"])
  })

  test("unknown naming schemes pass through instead of vanishing", () => {
    expect(recentModels("ollama", ["llama4:8b", "qwen3:14b"])).toEqual(["llama4:8b", "qwen3:14b"])
  })
})

describe("Ollama base URL", () => {
  test("the Settings value works with or without /v1 and a trailing slash", () => {
    for (const v of ["http://localhost:11434", "http://localhost:11434/", "http://localhost:11434/v1", "http://localhost:11434/v1/"]) {
      expect(ollamaBaseURL(cfg({}, { ollama: { baseURL: v } }))).toBe("http://localhost:11434/v1")
    }
  })
  test("OLLAMA_HOST wins over the Settings value; default is localhost", () => {
    process.env["OLLAMA_HOST"] = "http://gpu-box:11434"
    expect(ollamaBaseURL(cfg({}, { ollama: { baseURL: "http://localhost:11434" } }))).toBe("http://gpu-box:11434/v1")
    delete process.env["OLLAMA_HOST"]
    expect(ollamaBaseURL(cfg({}, {}))).toBe("http://localhost:11434/v1")
  })
})

describe("native task_budget injection (opt-in, Anthropic-only)", () => {
  test("adds output_config.task_budget to /messages bodies, preserving the rest", async () => {
    let sent: any
    const stub = (async (_url: any, init: any) => {
      sent = JSON.parse(init.body)
      return new Response("{}")
    }) as unknown as typeof fetch
    const f = anthropicBudgetFetch(500_000, stub)
    await f("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "claude-haiku-4-5", messages: [] }),
    })
    expect(sent.output_config.task_budget).toEqual({ type: "tokens", total: 500_000 })
    expect(sent.model).toBe("claude-haiku-4-5")
  })
  test("non-messages endpoints and unparseable bodies pass through untouched", async () => {
    let body: any
    const stub = (async (_url: any, init: any) => {
      body = init?.body
      return new Response("{}")
    }) as unknown as typeof fetch
    const f = anthropicBudgetFetch(1000, stub)
    await f("https://api.anthropic.com/v1/models", { body: "not json" })
    expect(body).toBe("not json")
  })
})

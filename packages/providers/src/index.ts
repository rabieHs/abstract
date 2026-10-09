import { createAnthropic } from "@ai-sdk/anthropic"
import { createOpenAI } from "@ai-sdk/openai"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { defaultSettingsMiddleware, wrapLanguageModel, type LanguageModel } from "ai"
import { loadConfig, type Config } from "@abstract/core"
import { chatgptFetch, chatgptModelSlugs, chatgptStatus, refreshChatGPTModels } from "./chatgpt.ts"

export {
  CALLBACK_PATH, ChatGPTAuthError, chatgptSignOut, chatgptStatus, completeChatGPTLogin,
  markChatGPTWelcomed, refreshChatGPTModels, startChatGPTLogin, type ChatGPTStatus,
} from "./chatgpt.ts"

/**
 * What a model is used for. ONE chat model — the one picked in the chat box —
 * runs every role except embeddings (which is picked automatically and only
 * powers semantic search). The role names stay as call-site labels.
 */
export type Role = "orchestrator" | "verifier" | "screener" | "embeddings"

export interface ProviderInfo {
  id: string
  name: string
  envKey: string
  /** recent models only — the live list when reachable, else this offline fallback */
  models: string[]
  available: boolean
}

const PROVIDERS: Omit<ProviderInfo, "available">[] = [
  {
    // signed in via "Continue with ChatGPT" — the user's Plus/Pro plan pays.
    // First in line: signing in is an explicit choice to use it.
    id: "chatgpt",
    name: "ChatGPT plan",
    envKey: "",
    models: [],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    envKey: "ANTHROPIC_API_KEY",
    models: ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"],
  },
  {
    id: "openai",
    name: "OpenAI",
    envKey: "OPENAI_API_KEY",
    models: ["gpt-5.5", "gpt-5.4-mini"],
  },
  {
    id: "google",
    name: "Google",
    envKey: "GOOGLE_GENERATIVE_AI_API_KEY",
    models: ["gemini-3.5-flash", "gemini-3.1-pro-preview", "gemini-3.1-flash-lite"],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    envKey: "OPENROUTER_API_KEY",
    models: [],
  },
  {
    id: "ollama",
    name: "Ollama (local)",
    envKey: "OLLAMA_HOST",
    models: [],
  },
]

/** embedding model per provider — chosen automatically, never shown in a picker */
const EMBEDDING_DEFAULTS: Partial<Record<string, string>> = {
  google: "gemini-embedding-001",
  openai: "text-embedding-3-small",
  ollama: "nomic-embed-text",
}

/** the family a provider's default chat model comes from (its newest version is used) */
const DEFAULT_FAMILY: Partial<Record<string, string>> = { anthropic: "sonnet", openai: "gpt", google: "flash" }

// ---------- recent models: the newest version of each family ----------

interface ParsedModel {
  id: string
  family: string
  version: number[]
}

const compareVersions = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** family + version from a model id; null for snapshots, aliases, and unknown shapes */
function parseModel(providerId: string, id: string): ParsedModel | null {
  let m: RegExpMatchArray | null
  if (providerId === "anthropic") {
    // claude-sonnet-5-5, claude-opus-5, claude-haiku-4-5-20251001 (some ids only exist dated)
    m = id.match(/^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/)
    return m ? { id, family: m[1]!, version: [Number(m[2]), Number(m[3] ?? 0)] } : null
  }
  if (providerId === "openai" || providerId === "chatgpt") {
    // gpt-5.5, gpt-5.4-mini, gpt-6.1-sol — dated snapshots (-2025-08-07) and
    // aliases (-chat-latest) don't match; neither do retired o-series ids
    m = id.match(/^gpt-(\d+)(?:\.(\d+))?(?:-([a-z]+))?$/)
    return m && m[3] !== "chat" ? { id, family: m[3] ?? "gpt", version: [Number(m[1]), Number(m[2] ?? 0)] } : null
  }
  if (providerId === "google") {
    // gemini-3.5-flash, gemini-3.1-flash-lite, gemini-3.1-pro-preview (a GA release beats a preview)
    m = id.match(/^gemini-(\d+)(?:\.(\d+))?-(pro|flash-lite|flash)(-preview)?(?:-.+)?$/)
    return m ? { id, family: m[3]!, version: [Number(m[1]), Number(m[2] ?? 0), m[4] ? 0 : 1] } : null
  }
  return null
}

/**
 * Keep the newest version of each model family, and drop families a whole
 * major version behind the provider's newest (gpt-4o when gpt-6 exists).
 * Unknown naming schemes pass through untouched rather than hiding everything.
 */
export function recentModels(providerId: string, ids: string[]): string[] {
  const parsed = ids.map((id) => parseModel(providerId, id)).filter((p): p is ParsedModel => p !== null)
  if (parsed.length === 0) return ids
  const newestMajor = Math.max(...parsed.map((p) => p.version[0]!))
  const newest = new Map<string, ParsedModel>()
  for (const p of parsed) {
    const cur = newest.get(p.family)
    if (!cur || compareVersions(p.version, cur.version) > 0) newest.set(p.family, p)
  }
  return [...newest.values()]
    .filter((p) => p.version[0]! >= newestMajor - 1)
    .sort((a, b) => compareVersions(b.version, a.version))
    .map((p) => p.id)
}

/** a provider's default chat model: newest of its preferred family, else its first listed */
function defaultChatModel(p: ProviderInfo): string | undefined {
  const family = DEFAULT_FAMILY[p.id]
  const hit = family ? p.models.find((id) => parseModel(p.id, id)?.family === family) : undefined
  return hit ?? p.models[0]
}

/** how many of OpenRouter's newest models to list */
const OPENROUTER_RECENT = 30

/** live model lists per provider, refreshed every 10 minutes */
const liveCache = new Map<string, { at: number; models: string[] }>()
const LIVE_TTL_MS = 10 * 60 * 1000

function apiKey(config: Config, provider: string, envKey: string): string | undefined {
  return process.env[envKey] ?? config.providers[provider]?.apiKey
}

export function listProviders(config: Config = loadConfig()): ProviderInfo[] {
  return PROVIDERS.map((p) =>
    p.id === "chatgpt"
      ? { ...p, models: recentModels("chatgpt", chatgptModelSlugs()), available: chatgptStatus().planUsage }
      : {
          ...p,
          models: liveCache.get(p.id)?.models ?? p.models,
          available:
            p.id === "ollama"
              ? Boolean(process.env["OLLAMA_HOST"] ?? config.providers["ollama"]?.baseURL)
              : Boolean(apiKey(config, p.id, p.envKey)),
        },
  )
}

/** the chat model the user picked — only while its provider is ACTIVE here:
 *  a saved spec whose key lives on some other machine must fall back, not
 *  fail every request with a missing-key error */
function activeChoice(config: Config): string | undefined {
  const chosen = config.roles["orchestrator"]
  if (!chosen) return undefined
  const providerId = chosen.slice(0, chosen.indexOf("/"))
  const p = listProviders(config).find((x) => x.id === providerId)
  return p?.available ? chosen : undefined
}

function embeddingSpec(providers: ProviderInfo[], config: Config): string | undefined {
  const set = config.roles["embeddings"]
  if (set && providers.find((p) => p.id === set.slice(0, set.indexOf("/")))?.available) return set
  for (const p of providers) {
    const model = p.available ? EMBEDDING_DEFAULTS[p.id] : undefined
    if (model) return `${p.id}/${model}`
  }
  return undefined
}

/** Resolve a role to "provider/model": the chosen chat model, else the first active provider's default. */
export function roleSpec(role: Role, config: Config = loadConfig()): string | undefined {
  if (role === "embeddings") return embeddingSpec(listProviders(config), config)
  const chosen = activeChoice(config)
  if (chosen) return chosen
  for (const p of listProviders(config)) {
    const model = p.available ? defaultChatModel(p) : undefined
    if (model) return `${p.id}/${model}`
  }
  return undefined
}

/**
 * Anthropic-only, OPT-IN: inject the native `output_config.task_budget`
 * (a server-side token countdown the model paces against — the first-class
 * form of the harness's wrap-up steer) into /messages requests. The AI SDK
 * does not expose this parameter, so it rides a fetch wrapper; with the
 * config at 0 (default) no wrapper is installed at all.
 */
export function anthropicBudgetFetch(total: number, base: typeof fetch = fetch): typeof fetch {
  const wrapped: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response> = async (input, init) => {
    try {
      if (init?.body && typeof init.body === "string" && String(input).includes("/messages")) {
        const body = JSON.parse(init.body) as Record<string, unknown>
        body["output_config"] = {
          ...((body["output_config"] as Record<string, unknown> | undefined) ?? {}),
          task_budget: { type: "tokens", total },
        }
        init = { ...init, body: JSON.stringify(body) }
      }
    } catch {
      /* malformed/streaming body — send untouched */
    }
    return base(input, init)
  }
  // Bun's fetch type carries extras (preconnect) irrelevant to the SDK's use
  return wrapped as unknown as typeof fetch
}

export function resolveModel(spec: string, config: Config = loadConfig()): LanguageModel {
  const slash = spec.indexOf("/")
  if (slash === -1) throw new Error(`model spec must be "provider/model", got "${spec}"`)
  const provider = spec.slice(0, slash)
  const model = spec.slice(slash + 1)
  switch (provider) {
    case "chatgpt":
      // Responses API through the plan route; store:false makes the SDK send
      // full items (no server-side references) and keep encrypted reasoning
      return wrapLanguageModel({
        model: createOpenAI({ apiKey: "chatgpt-plan", fetch: chatgptFetch() }).responses(model),
        middleware: defaultSettingsMiddleware({ settings: { providerOptions: { openai: { store: false } } } }),
      })
    case "anthropic": {
      const budget = config.budgets?.nativeTaskBudgetTokens ?? 0
      return createAnthropic({
        apiKey: apiKey(config, provider, "ANTHROPIC_API_KEY"),
        ...(budget > 0 ? { fetch: anthropicBudgetFetch(budget) } : {}),
      })(model)
    }
    case "openai":
      return createOpenAI({ apiKey: apiKey(config, provider, "OPENAI_API_KEY") })(model)
    case "google":
      return createGoogleGenerativeAI({
        apiKey: apiKey(config, provider, "GOOGLE_GENERATIVE_AI_API_KEY"),
      })(model)
    case "openrouter":
      return createOpenAICompatible({
        name: "openrouter",
        baseURL: "https://openrouter.ai/api/v1",
        apiKey: apiKey(config, provider, "OPENROUTER_API_KEY"),
      })(model)
    case "ollama":
      return createOpenAICompatible({
        name: "ollama",
        baseURL:
          config.providers["ollama"]?.baseURL ??
          `${process.env["OLLAMA_HOST"] ?? "http://localhost:11434"}/v1`,
      })(model)
    default:
      throw new Error(`unknown provider "${provider}"`)
  }
}

/** embedding function for the embeddings role; null when no provider supports it */
export async function embedderForRole(
  config: Config = loadConfig(),
): Promise<((values: string[]) => Promise<number[][]>) | null> {
  const chosen = roleSpec("embeddings", config)
  if (!chosen) return null
  const slash = chosen.indexOf("/")
  const provider = chosen.slice(0, slash)
  const model = chosen.slice(slash + 1)
  const key = (envKey: string) => process.env[envKey] ?? config.providers[provider]?.apiKey
  let em
  switch (provider) {
    case "google":
      em = createGoogleGenerativeAI({ apiKey: key("GOOGLE_GENERATIVE_AI_API_KEY") }).textEmbeddingModel(model)
      break
    case "openai":
      em = createOpenAI({ apiKey: key("OPENAI_API_KEY") }).textEmbeddingModel(model)
      break
    case "ollama":
      em = createOpenAICompatible({
        name: "ollama",
        baseURL:
          config.providers["ollama"]?.baseURL ??
          `${process.env["OLLAMA_HOST"] ?? "http://localhost:11434"}/v1`,
      }).textEmbeddingModel(model)
      break
    default:
      return null
  }
  const { embedMany } = await import("ai")
  return async (values: string[]) => {
    const { embeddings } = await embedMany({ model: em, values })
    return embeddings
  }
}

// ---------------------------------------------------------------------------
// Live model discovery — never trust a hardcoded list; ask the provider.
// The static lists above are only the offline fallback.
// ---------------------------------------------------------------------------

/** recent models only: newest per family; OpenRouter (every vendor's naming) by release date; Ollama as pulled */
async function fetchLiveModels(providerId: string, config: Config): Promise<string[]> {
  const ids = await fetchProviderModels(providerId, config)
  return providerId === "openrouter" || providerId === "ollama" ? ids : recentModels(providerId, ids)
}

async function fetchProviderModels(providerId: string, config: Config): Promise<string[]> {
  const key = (envKey: string) => process.env[envKey] ?? config.providers[providerId]?.apiKey
  try {
    switch (providerId) {
      case "chatgpt":
        return (await refreshChatGPTModels()).map((m) => m.slug)
      case "google": {
        const k = key("GOOGLE_GENERATIVE_AI_API_KEY")
        if (!k) return []
        const r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${k}`,
        )
        if (!r.ok) return []
        const d = (await r.json()) as {
          models?: { name: string; supportedGenerationMethods?: string[] }[]
        }
        return (d.models ?? [])
          .filter((m) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
          .map((m) => m.name.replace(/^models\//, ""))
          // keep only the CURRENT generation (gemini-3.x) general chat models;
          // drop older 2.x/1.x, and special-purpose ones (tts, image, robotics,
          // computer-use, embeddings, etc.) that don't belong in a role picker
          .filter(
            (id) =>
              /^gemini-3(\.|-)/.test(id) &&
              !/(tts|image|audio|live|embed|translate|omni|aqa|computer|robot|vision|guard|learnlm)/.test(id),
          )
          .sort()
          .reverse()
      }
      case "anthropic": {
        const k = key("ANTHROPIC_API_KEY")
        if (!k) return []
        const r = await fetch("https://api.anthropic.com/v1/models?limit=100", {
          headers: { "x-api-key": k, "anthropic-version": "2023-06-01" },
        })
        if (!r.ok) return []
        const d = (await r.json()) as { data?: { id: string }[] }
        return (d.data ?? []).map((m) => m.id)
      }
      case "openai": {
        const k = key("OPENAI_API_KEY")
        if (!k) return []
        const r = await fetch("https://api.openai.com/v1/models", {
          headers: { authorization: `Bearer ${k}` },
        })
        if (!r.ok) return []
        const d = (await r.json()) as { data?: { id: string }[] }
        return (d.data ?? [])
          .map((m) => m.id)
          .filter(
            (id) =>
              /^(gpt-|o\d)/.test(id) &&
              !/(audio|realtime|image|tts|transcribe|embed|moderation|search|dall|codex)/.test(id),
          )
          .sort()
          .reverse()
      }
      case "openrouter": {
        const k = key("OPENROUTER_API_KEY")
        if (!k) return []
        const r = await fetch("https://openrouter.ai/api/v1/models")
        if (!r.ok) return []
        const d = (await r.json()) as { data?: { id: string; created?: number }[] }
        // hundreds of models across vendors whose names don't share a scheme:
        // the 30 newest releases fit a scrolling picker
        return (d.data ?? [])
          .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
          .slice(0, OPENROUTER_RECENT)
          .map((m) => m.id)
      }
      case "ollama": {
        const base =
          config.providers["ollama"]?.baseURL ??
          process.env["OLLAMA_HOST"] ??
          "http://localhost:11434"
        const r = await fetch(`${base.replace(/\/v1\/?$/, "")}/api/tags`)
        if (!r.ok) return []
        const d = (await r.json()) as { models?: { name: string }[] }
        return (d.models ?? []).map((m) => m.name)
      }
      default:
        return []
    }
  } catch {
    return []
  }
}

/** Provider list with LIVE model ids from each provider's API (cached 10 min). */
export async function listProvidersLive(config: Config = loadConfig()): Promise<ProviderInfo[]> {
  return Promise.all(
    listProviders(config).map(async (p) => {
      if (!p.available) return p
      const cached = liveCache.get(p.id)
      if (cached && Date.now() - cached.at < LIVE_TTL_MS) return { ...p, models: cached.models }
      const live = await fetchLiveModels(p.id, config)
      if (live.length > 0) {
        liveCache.set(p.id, { at: Date.now(), models: live })
        return { ...p, models: live }
      }
      return p // offline / API down → static fallback
    }),
  )
}

/**
 * Resolve a role against the LIVE model lists: the chat model picked in the
 * chat box, else the first active provider's default. Embeddings resolve
 * separately — the live lists deliberately exclude embedding models.
 */
export async function effectiveRoleSpec(
  role: Role,
  config: Config = loadConfig(),
): Promise<string | undefined> {
  const providers = await listProvidersLive(config)
  if (role === "embeddings") return embeddingSpec(providers, config)
  const chosen = activeChoice(config)
  if (chosen) return chosen
  for (const p of providers) {
    const model = p.available ? defaultChatModel(p) : undefined
    if (model) return `${p.id}/${model}`
  }
  return undefined
}

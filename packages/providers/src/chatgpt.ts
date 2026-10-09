import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose"
import { GLOBAL_DIR } from "@abstract/core"

/**
 * "Continue with ChatGPT" — OpenAI's Sign in with ChatGPT, plan-usage flavor
 * for open-source, locally run apps (developers.openai.com/siwc). The user's
 * ChatGPT Plus/Pro plan pays for model calls: no API key, no client secret.
 *
 * Registration is self-serve: the first sign-in uses client_id
 * dynamic_agent_client and the callback hands back an issued oaiapp_ id, which
 * every later sign-in, refresh and revocation must use. Inference goes to the
 * Responses API only, with store:false + stream:true and a short list of
 * unsupported parameters — chatgptFetch adapts the AI SDK's requests so no
 * call site has to know which provider it is talking to.
 */

export const CHATGPT_ISSUER = "https://auth.openai.com"
const AUTHORIZE_URL = `${CHATGPT_ISSUER}/api/accounts/authorize`
const TOKEN_URL = `${CHATGPT_ISSUER}/api/accounts/oauth/token`
const JWKS_URL = `${CHATGPT_ISSUER}/.well-known/jwks.json`
const DISCOVERY_URL = `${CHATGPT_ISSUER}/.well-known/openid-configuration`
const CHATGPT_RESOURCE = "https://api.openai.com/v1"
const MANAGE_USAGE_URL = "https://chatgpt.com/settings/usage"
/** fixed from registration onward — only the port may change between sign-ins */
export const CALLBACK_PATH = "/auth/callback"
const DYNAMIC_CLIENT = "dynamic_agent_client"
const PLAN_SCOPE = "chatgpt.tokens.use.direct"
const SCOPES = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`
const APP_NAME = "abstract"
/** refresh this long before the 1-hour access token expires */
const REFRESH_MARGIN_MS = 5 * 60 * 1000
const PENDING_TTL_MS = 10 * 60 * 1000

// ---------- local credential store (~/.abstract/chatgpt-auth.json, 0600) ----------

interface ChatGPTAccount {
  clientId: string
  subject: string
  email?: string
  idToken: string
  /** absent when the user signed in but declined plan usage */
  accessToken?: string
  refreshToken?: string
  /** epoch ms */
  expiresAt: number
  scopes: string[]
  savedAt: string
  /** when this sign-in completed (savedAt also moves on every refresh) */
  signedInAt: string
}

export interface ChatGPTModel {
  slug: string
  name: string
}

interface ChatGPTStore {
  /** stable per-install id sent as ext_agent_host_id */
  hostId: string
  account?: ChatGPTAccount
  /** issued client id per ChatGPT subject — kept across sign-outs so re-sign-in reuses it */
  clients: Record<string, { clientId: string; email?: string; idToken?: string }>
  lastSubject?: string
  models?: ChatGPTModel[]
  /** the one-time "You're using your ChatGPT plan" notice was dismissed */
  welcomed?: boolean
}

function storeFile(): string {
  return process.env["ABSTRACT_CHATGPT_STORE"] ?? join(GLOBAL_DIR, "chatgpt-auth.json")
}

function loadStore(): ChatGPTStore {
  const file = storeFile()
  if (existsSync(file)) {
    try {
      const s = JSON.parse(readFileSync(file, "utf8")) as ChatGPTStore
      if (s.hostId) return { ...s, clients: s.clients ?? {} }
    } catch {
      /* unreadable — start a fresh store below (keeps the app usable) */
    }
  }
  // not persisted until a sign-in starts — merely reading status writes nothing
  return { hostId: `urn:uuid:${crypto.randomUUID()}`, clients: {} }
}

/** atomic, owner-only write — tokens are credentials */
function saveStore(store: ChatGPTStore): void {
  const file = storeFile()
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 })
  renameSync(tmp, file)
}

// ---------- errors ----------

export class ChatGPTAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

/** refresh failures that mean the grant is gone — anything else (network, 5xx) keeps credentials */
const TERMINAL_REFRESH = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
])

// ---------- sign-in ----------

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url")
const randomToken = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)))

interface Pending {
  verifier: string
  nonce: string
  redirectUri: string
  clientId: string
  createdAt: number
}
const pending = new Map<string, Pending>()

export interface Deps {
  fetchImpl?: typeof fetch
  /** ID-token key resolver; defaults to OpenAI's published JWKS */
  jwks?: JWTVerifyGetKey
  now?: () => number
}

let remoteJwks: JWTVerifyGetKey | undefined
const defaultJwks = () => (remoteJwks ??= createRemoteJWKSet(new URL(JWKS_URL)))

/**
 * Build the authorize URL. `redirectUri` must be http://127.0.0.1:<port>/auth/callback
 * on the running local server. A known account re-authorizes with its issued
 * client id; `newAccount` (or no prior sign-in) self-registers a new one.
 */
export async function startChatGPTLogin(opts: { redirectUri: string; newAccount?: boolean }): Promise<string> {
  const store = loadStore()
  const now = Date.now()
  for (const [k, p] of pending) if (now - p.createdAt > PENDING_TTL_MS) pending.delete(k)

  const prior = opts.newAccount ? undefined : store.lastSubject ? store.clients[store.lastSubject] : undefined
  const clientId = prior?.clientId ?? DYNAMIC_CLIENT
  const verifier = randomToken()
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))))
  const state = randomToken(24)
  const nonce = randomToken(24)
  pending.set(state, { verifier, nonce, redirectUri: opts.redirectUri, clientId, createdAt: now })
  saveStore(store) // pins hostId: ext_agent_host_id must stay stable for this install

  const q = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: opts.redirectUri,
    scope: SCOPES,
    resource: CHATGPT_RESOURCE,
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
    ext_agent_host_id: store.hostId,
  })
  if (clientId === DYNAMIC_CLIENT) {
    q.set("agent_name_hint", APP_NAME)
  } else {
    if (prior?.idToken) q.set("id_token_hint", prior.idToken)
    if (prior?.email) q.set("login_hint", prior.email)
  }
  return `${AUTHORIZE_URL}?${q.toString()}`
}

interface TokenResponse {
  access_token?: string
  refresh_token?: string
  id_token?: string
  expires_in?: number
  scope?: string
  error?: string
  error_description?: string
}

async function tokenRequest(fields: Record<string, string>, fetchImpl: typeof fetch): Promise<TokenResponse> {
  const r = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(fields).toString(),
  })
  const d = (await r.json().catch(() => ({}))) as TokenResponse
  if (!r.ok) {
    throw new ChatGPTAuthError(d.error ?? `http_${r.status}`, d.error_description ?? d.error ?? `token endpoint returned ${r.status}`)
  }
  return d
}

/** finish the browser round-trip: validate, exchange, verify the ID token, save */
export async function completeChatGPTLogin(params: URLSearchParams, deps: Deps = {}): Promise<ChatGPTStatus> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const state = params.get("state") ?? ""
  const p = pending.get(state)
  if (!p || Date.now() - p.createdAt > PENDING_TTL_MS) {
    throw new ChatGPTAuthError("bad_state", "This sign-in link expired or was already used — start again from Settings.")
  }
  pending.delete(state)

  const error = params.get("error")
  if (error) {
    throw new ChatGPTAuthError(
      error,
      error === "access_denied" ? "Sign-in was cancelled." : `ChatGPT sign-in failed: ${params.get("error_description") ?? error}`,
    )
  }
  const code = params.get("code")
  if (!code) throw new ChatGPTAuthError("no_code", "ChatGPT did not return an authorization code.")

  const returned = params.get("client_id") ?? undefined
  let clientId: string
  if (p.clientId === DYNAMIC_CLIENT) {
    if (!returned || returned === DYNAMIC_CLIENT) {
      throw new ChatGPTAuthError("no_client_id", "ChatGPT did not issue a client id for this install — try again.")
    }
    clientId = returned
  } else {
    if (returned && returned !== p.clientId) {
      throw new ChatGPTAuthError("client_mismatch", "The sign-in came back for a different app registration — start again.")
    }
    clientId = p.clientId
  }

  const t = await tokenRequest(
    {
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: p.verifier,
      redirect_uri: p.redirectUri,
      resource: CHATGPT_RESOURCE,
    },
    fetchImpl,
  )
  if (!t.id_token) throw new ChatGPTAuthError("no_id_token", "ChatGPT did not return an ID token.")

  const { payload } = await jwtVerify(t.id_token, deps.jwks ?? defaultJwks(), {
    issuer: CHATGPT_ISSUER,
    audience: clientId,
  })
  if (payload["nonce"] !== p.nonce) throw new ChatGPTAuthError("bad_nonce", "ID token nonce mismatch — sign-in rejected.")
  if (typeof payload.sub !== "string") throw new ChatGPTAuthError("no_subject", "ID token has no subject.")
  const email = typeof payload["email"] === "string" ? (payload["email"] as string) : undefined

  const scopes = (t.scope ?? params.get("scope") ?? "").split(/\s+/).filter(Boolean)
  const planUsage = scopes.includes(PLAN_SCOPE) && Boolean(t.access_token && t.refresh_token)

  const store = loadStore()
  store.account = {
    clientId,
    subject: payload.sub,
    email,
    idToken: t.id_token,
    ...(planUsage ? { accessToken: t.access_token, refreshToken: t.refresh_token } : {}),
    expiresAt: Date.now() + (t.expires_in ?? 3600) * 1000,
    scopes,
    savedAt: new Date().toISOString(),
    signedInAt: new Date().toISOString(),
  }
  store.clients[payload.sub] = { clientId, email, idToken: t.id_token }
  store.lastSubject = payload.sub
  saveStore(store)

  if (planUsage) await refreshChatGPTModels(deps).catch(() => {})
  return chatgptStatus()
}

// ---------- tokens ----------

let refreshing: Promise<string> | null = null

/** a valid access token, refreshed near expiry; refreshes are serialized (the refresh token rotates) */
export async function chatgptAccessToken(deps: Deps = {}): Promise<string> {
  const a = loadStore().account
  if (!a?.accessToken) {
    throw new ChatGPTAuthError(
      "chatgpt_not_signed_in",
      "Not signed in to ChatGPT (chatgpt_not_signed_in) — use Continue with ChatGPT in Settings.",
    )
  }
  if (a.expiresAt - Date.now() > REFRESH_MARGIN_MS) return a.accessToken
  refreshing ??= refreshAccess(deps).finally(() => {
    refreshing = null
  })
  return refreshing
}

async function refreshAccess(deps: Deps): Promise<string> {
  // re-read: another abstract process may have rotated the token already
  const store = loadStore()
  const a = store.account
  if (!a?.accessToken || !a.refreshToken) throw new ChatGPTAuthError("chatgpt_not_signed_in", "Not signed in to ChatGPT.")
  if (a.expiresAt - Date.now() > REFRESH_MARGIN_MS) return a.accessToken
  try {
    const t = await tokenRequest(
      { grant_type: "refresh_token", client_id: a.clientId, refresh_token: a.refreshToken, resource: CHATGPT_RESOURCE },
      deps.fetchImpl ?? fetch,
    )
    if (!t.access_token) throw new ChatGPTAuthError("no_access_token", "ChatGPT refresh returned no access token.")
    a.accessToken = t.access_token
    if (t.refresh_token) a.refreshToken = t.refresh_token
    a.expiresAt = Date.now() + (t.expires_in ?? 3600) * 1000
    if (t.scope) a.scopes = t.scope.split(/\s+/).filter(Boolean)
    a.savedAt = new Date().toISOString()
    saveStore(store)
    return a.accessToken
  } catch (err) {
    if (err instanceof ChatGPTAuthError && TERMINAL_REFRESH.has(err.code)) {
      delete store.account // keep clients + hostId: the next sign-in reuses the registration
      saveStore(store)
      throw new ChatGPTAuthError(
        "chatgpt_signed_out",
        "Your ChatGPT session ended (chatgpt_signed_out) — sign in again with Continue with ChatGPT in Settings.",
      )
    }
    throw err
  }
}

/** revoke the refresh token at OpenAI, then forget the tokens (registration is kept) */
export async function chatgptSignOut(deps: Deps = {}): Promise<{ revoked: boolean }> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const store = loadStore()
  const a = store.account
  let revoked = !a?.refreshToken // nothing to revoke counts as done
  if (a?.refreshToken) {
    for (let attempt = 0; attempt < 3 && !revoked; attempt++) {
      try {
        const disc = (await (await fetchImpl(DISCOVERY_URL)).json()) as { revocation_endpoint?: string }
        if (!disc.revocation_endpoint) break
        const r = await fetchImpl(disc.revocation_endpoint, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            token: a.refreshToken,
            token_type_hint: "refresh_token",
            client_id: a.clientId,
          }).toString(),
        })
        if (r.ok) revoked = true
        else if (r.status < 500) break
      } catch {
        /* network — retry with backoff */
      }
      if (!revoked) await Bun.sleep(400 * 2 ** attempt)
    }
  }
  delete store.account
  saveStore(store)
  return { revoked }
}

// ---------- status + models ----------

export interface ChatGPTStatus {
  connected: boolean
  email?: string
  /** plan usage granted AND token present — sign-in alone can't run models */
  planUsage: boolean
  models: ChatGPTModel[]
  welcomed: boolean
  signedInAt?: string
  manageUsageUrl: string
}

export function chatgptStatus(): ChatGPTStatus {
  const s = loadStore()
  const a = s.account
  return {
    connected: Boolean(a),
    email: a?.email,
    planUsage: Boolean(a?.accessToken && a.scopes.includes(PLAN_SCOPE)),
    models: s.models ?? [],
    welcomed: Boolean(s.welcomed),
    signedInAt: a?.signedInAt,
    manageUsageUrl: MANAGE_USAGE_URL,
  }
}

export function markChatGPTWelcomed(): void {
  const s = loadStore()
  s.welcomed = true
  saveStore(s)
}

/** model slugs this account may use (cached in the store for sync callers) */
export function chatgptModelSlugs(): string[] {
  return (loadStore().models ?? []).map((m) => m.slug)
}

/** ask OpenAI which models this token may use; never hardcode them */
export async function refreshChatGPTModels(deps: Deps = {}): Promise<ChatGPTModel[]> {
  const token = await chatgptAccessToken(deps)
  const r = await (deps.fetchImpl ?? fetch)(`${CHATGPT_RESOURCE}/models`, {
    headers: { authorization: `Bearer ${token}` },
  })
  if (!r.ok) return chatgptStatus().models
  const d = (await r.json()) as {
    models?: { slug: string; display_name?: string; visibility?: string }[]
    data?: { id: string }[]
  }
  const models: ChatGPTModel[] = d.models
    ? d.models
        .filter((m) => !m.visibility || m.visibility === "list")
        .map((m) => ({ slug: m.slug, name: m.display_name ?? m.slug }))
    : (d.data ?? []).map((m) => ({ slug: m.id, name: m.id }))
  if (models.length > 0) {
    const s = loadStore()
    s.models = models
    saveStore(s)
  }
  return models
}

// ---------- inference adapter ----------

/** Responses parameters the ChatGPT plan route rejects (preview limitations) */
const UNSUPPORTED = [
  "background",
  "conversation",
  "max_output_tokens",
  "max_tool_calls",
  "metadata",
  "moderation",
  "multi_agent",
  "previous_response_id",
  "prompt",
  "prompt_cache_retention",
  "safety_identifier",
  "service_tier",
  "temperature",
  "top_logprobs",
  "top_p",
  "truncation",
  "user",
]

/** plan-route error codes → status + a message the UI and turn classifier recognize */
const PLAN_ERRORS: Record<string, { status: number; message: string }> = {
  subscription_sharing_usage_limit_exceeded: {
    status: 429,
    message: `ChatGPT plan usage limit reached (chatgpt_usage_limit) — manage usage at ${MANAGE_USAGE_URL}`,
  },
  subscription_sharing_user_not_eligible: {
    status: 403,
    message: "This ChatGPT account can't use its plan here (chatgpt_not_eligible) — plan usage needs ChatGPT Plus or Pro.",
  },
  subscription_sharing_invalid_user: {
    status: 401,
    message: "ChatGPT didn't accept this sign-in (chatgpt_invalid_user) — sign out and Continue with ChatGPT again in Settings.",
  },
  subscription_sharing_usage_unavailable: {
    status: 503,
    message: "ChatGPT plan usage is temporarily unavailable — service unavailable, retrying.",
  },
  subscription_sharing_user_unavailable: {
    status: 503,
    message: "ChatGPT plan usage is temporarily unavailable — service unavailable, retrying.",
  },
  subscription_sharing_unsupported_capability: {
    status: 400,
    message: "The ChatGPT plan route doesn't support part of this request (chatgpt_unsupported)",
  },
}

function planError(code: string | undefined, fallback: string, param?: string | null) {
  const known = code ? PLAN_ERRORS[code] : undefined
  const message = known ? `${known.message}${param ? ` [${param}]` : ""}` : fallback
  return { status: known?.status ?? 500, code: code ?? "chatgpt_error", message }
}

function errorJson(status: number, code: string, message: string): Response {
  return Response.json({ error: { type: "chatgpt_error", code, message, param: null } }, { status })
}

/** rewrite a /responses body into what the plan route accepts */
export function adaptResponsesBody(body: Record<string, unknown>): Record<string, unknown> {
  const out = { ...body }
  for (const k of UNSUPPORTED) delete out[k]
  out["store"] = false
  out["stream"] = true
  // stateless mode: reasoning must travel with the request, encrypted
  const include = new Set((out["include"] as string[] | undefined) ?? [])
  include.add("reasoning.encrypted_content")
  out["include"] = [...include]
  if (Array.isArray(out["input"])) {
    out["input"] = (out["input"] as Record<string, unknown>[]).map((item) =>
      item && item["role"] === "system" ? { ...item, role: "developer" } : item,
    )
  }
  return out
}

/** split an SSE body into parsed `data:` events */
async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let i: number
    while ((i = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, i)
      buf = buf.slice(i + 2)
      const data = block
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n")
      if (!data || data === "[DONE]") continue
      try {
        yield JSON.parse(data) as Record<string, unknown>
      } catch {
        /* keep-alive or partial noise */
      }
    }
  }
}

type FailedEvent = { response?: { error?: { code?: string; message?: string } } }

/** non-streaming callers (generateText/generateObject): rebuild the JSON response from the stream.
 *  The plan route's final event carries an EMPTY `output` (observed live 2026-10-09) — the
 *  items only arrive as response.output_item.done events, so collect them along the way. */
async function collectCompleted(res: Response): Promise<Response> {
  const items: { index: number; item: unknown }[] = []
  for await (const ev of sseEvents(res.body!)) {
    if (ev["type"] === "response.output_item.done") {
      items.push({ index: Number(ev["output_index"] ?? items.length), item: ev["item"] })
    }
    if (ev["type"] === "response.completed" || ev["type"] === "response.incomplete") {
      const response = { ...(ev["response"] as Record<string, unknown>) }
      const output = response["output"] as unknown[] | undefined
      if (!output || output.length === 0) response["output"] = items.sort((a, b) => a.index - b.index).map((x) => x.item)
      return Response.json(response)
    }
    if (ev["type"] === "response.failed") {
      const e = (ev as FailedEvent).response?.error
      const pe = planError(e?.code, `ChatGPT response failed: ${e?.message ?? e?.code ?? "unknown_error"}`)
      return errorJson(pe.status, pe.code, pe.message)
    }
    if (ev["type"] === "error") {
      const e = ev as { code?: string; message?: string; error?: { code?: string; message?: string } }
      const code = e.error?.code ?? e.code
      const pe = planError(code, `ChatGPT stream error: ${e.error?.message ?? e.message ?? code}`)
      return errorJson(pe.status, pe.code, pe.message)
    }
  }
  return errorJson(502, "chatgpt_stream_incomplete", "ChatGPT stream ended before response.completed — connection closed unexpectedly.")
}

/** streaming callers: pass events through, but turn response.failed (which the
 *  AI SDK ignores) into an `error` event it surfaces — otherwise a usage-limit
 *  hit mid-answer would look like a silent empty reply */
function surfaceFailures(res: Response): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let seq = 0
      try {
        for await (const ev of sseEvents(res.body!)) {
          seq = typeof ev["sequence_number"] === "number" ? (ev["sequence_number"] as number) : seq + 1
          let out = ev
          if (ev["type"] === "response.failed") {
            const e = (ev as FailedEvent).response?.error
            const pe = planError(e?.code, `ChatGPT response failed: ${e?.message ?? e?.code ?? "unknown_error"}`)
            out = { type: "error", sequence_number: seq, error: { type: "chatgpt_error", code: pe.code, message: pe.message } }
          }
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(out)}\n\n`))
        }
        controller.close()
      } catch (err) {
        controller.error(err)
      }
    },
  })
  return new Response(stream, { status: res.status, headers: res.headers })
}

/** fetch for the AI SDK's OpenAI provider: auth + body adaptation + error mapping */
export function chatgptFetch(deps: Deps = {}): typeof fetch {
  const base = deps.fetchImpl ?? fetch
  const wrapped = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    let token: string
    try {
      token = await chatgptAccessToken(deps)
    } catch (err) {
      const code = err instanceof ChatGPTAuthError ? err.code : "chatgpt_auth_error"
      return errorJson(401, code, err instanceof Error ? err.message : String(err))
    }
    const headers = new Headers(init?.headers)
    headers.set("authorization", `Bearer ${token}`)
    const url = input instanceof Request ? input.url : String(input)
    const isResponses = init?.method === "POST" && new URL(url).pathname.endsWith("/responses")
    if (!isResponses || typeof init?.body !== "string") return base(input, { ...init, headers })

    const original = JSON.parse(init.body) as Record<string, unknown>
    const wantsStream = original["stream"] === true
    const res = await base(url, { ...init, headers, body: JSON.stringify(adaptResponsesBody(original)) })
    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string; param?: string }; detail?: string }
      // a bare 401 on this route means the signed identity wasn't accepted —
      // never let it read as "check your API key" (there is no key)
      const code = d.error?.code && PLAN_ERRORS[d.error.code] ? d.error.code : res.status === 401 ? "subscription_sharing_invalid_user" : d.error?.code
      const pe = planError(code, d.error?.message ?? d.detail ?? `ChatGPT request failed (${res.status})`, d.error?.param)
      return errorJson(code && PLAN_ERRORS[code] ? pe.status : res.status, pe.code, pe.message)
    }
    return wantsStream ? surfaceFailures(res) : collectCompleted(res)
  }
  return wrapped as unknown as typeof fetch
}

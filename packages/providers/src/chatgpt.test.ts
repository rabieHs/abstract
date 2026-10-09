import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, statSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose"
import { createOpenAI } from "@ai-sdk/openai"
import { defaultSettingsMiddleware, generateText, streamText, wrapLanguageModel } from "ai"
import {
  adaptResponsesBody,
  CHATGPT_ISSUER,
  chatgptAccessToken,
  chatgptFetch,
  chatgptSignOut,
  chatgptStatus,
  completeChatGPTLogin,
  startChatGPTLogin,
} from "./chatgpt.ts"

const REDIRECT = "http://127.0.0.1:4477/auth/callback"
let dir: string
let jwks: JWTVerifyGetKey
let privateKey: CryptoKey

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "chatgpt-test-"))
  process.env["ABSTRACT_CHATGPT_STORE"] = join(dir, "chatgpt-auth.json")
  const kp = await generateKeyPair("RS256", { extractable: true })
  privateKey = kp.privateKey as CryptoKey
  jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(kp.publicKey)), kid: "k1", alg: "RS256" }] })
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env["ABSTRACT_CHATGPT_STORE"]
})

const idToken = (claims: Record<string, unknown>, aud: string) =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(CHATGPT_ISSUER)
    .setAudience(aud)
    .setSubject("user-sub-1")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey)

type Call = { url: string; init?: RequestInit; form?: URLSearchParams; json?: Record<string, unknown> }

/** a fake OpenAI: token endpoint, models list, revocation, and a scripted /responses */
function fakeOpenAI(opts: { tokens?: (form: URLSearchParams) => Response | Promise<Response>; sse?: string; revokeStatus?: number } = {}) {
  const calls: Call[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    const call: Call = { url, init }
    if (typeof init?.body === "string") {
      if (String(new Headers(init.headers).get("content-type")).includes("form")) call.form = new URLSearchParams(init.body)
      else call.json = JSON.parse(init.body)
    }
    calls.push(call)
    if (url.endsWith("/api/accounts/oauth/token")) return opts.tokens!(call.form!)
    if (url.endsWith("/v1/models")) {
      return Response.json({
        models: [
          { slug: "gpt-6.1-sol", display_name: "GPT-6.1 Sol", visibility: "list" },
          { slug: "gpt-6.1-sol-mini", display_name: "GPT-6.1 Sol mini", visibility: "list" },
          { slug: "internal-x", display_name: "hidden", visibility: "hide" },
        ],
      })
    }
    if (url.endsWith("/.well-known/openid-configuration")) {
      return Response.json({ revocation_endpoint: `${CHATGPT_ISSUER}/oauth/revoke` })
    }
    if (url.endsWith("/oauth/revoke")) return new Response("", { status: opts.revokeStatus ?? 200 })
    if (url.endsWith("/v1/responses")) {
      return new Response(opts.sse ?? "", { headers: { "content-type": "text/event-stream" } })
    }
    return new Response("not found", { status: 404 })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

function tokenEndpoint(scope = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct") {
  let n = 0
  return async (form: URLSearchParams) => {
    n++
    if (form.get("grant_type") === "refresh_token") {
      return Response.json({ access_token: `at-${n}`, refresh_token: `rt-${n}`, expires_in: 3600 })
    }
    return Response.json({
      access_token: "at-0",
      refresh_token: "rt-0",
      id_token: await idToken({ email: "ada@example.com", nonce: pendingNonce }, form.get("client_id")!),
      expires_in: 3600,
      scope,
    })
  }
}
// the nonce the server must echo in the ID token — captured from the authorize URL
let pendingNonce = ""

describe("sign-in", () => {
  test("first sign-in self-registers: dynamic client, app name, stable host id, plan scopes", async () => {
    const q = new URL(await startChatGPTLogin({ redirectUri: REDIRECT })).searchParams
    expect(q.get("client_id")).toBe("dynamic_agent_client")
    expect(q.get("agent_name_hint")).toBe("abstract")
    expect(q.get("ext_agent_host_id")).toMatch(/^urn:uuid:[0-9a-f-]{36}$/)
    expect(q.get("scope")).toContain("chatgpt.tokens.use.direct")
    expect(q.get("scope")).toContain("offline_access")
    expect(q.get("resource")).toBe("https://api.openai.com/v1")
    expect(q.get("code_challenge_method")).toBe("S256")
    expect(q.get("redirect_uri")).toBe(REDIRECT)
    // the host id must survive: the store is written owner-only
    const file = process.env["ABSTRACT_CHATGPT_STORE"]!
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const again = new URL(await startChatGPTLogin({ redirectUri: REDIRECT })).searchParams
    expect(again.get("ext_agent_host_id")).toBe(q.get("ext_agent_host_id"))
  })

  test("status reads never create the credential file", () => {
    expect(chatgptStatus().connected).toBe(false)
    expect(() => statSync(process.env["ABSTRACT_CHATGPT_STORE"]!)).toThrow()
  })

  test("callback exchanges the code with the ISSUED client id and verifies the ID token", async () => {
    const fake = fakeOpenAI({ tokens: tokenEndpoint() })
    const url = new URL(await startChatGPTLogin({ redirectUri: REDIRECT }))
    pendingNonce = url.searchParams.get("nonce")!
    const status = await completeChatGPTLogin(
      new URLSearchParams({ code: "auth-code", state: url.searchParams.get("state")!, client_id: "oaiapp_test" }),
      { fetchImpl: fake.fetchImpl, jwks },
    )
    const tokenCall = fake.calls.find((c) => c.url.endsWith("/oauth/token"))!
    expect(tokenCall.form!.get("grant_type")).toBe("authorization_code")
    expect(tokenCall.form!.get("client_id")).toBe("oaiapp_test")
    expect(tokenCall.form!.get("code_verifier")).toBeTruthy()
    expect(tokenCall.form!.get("redirect_uri")).toBe(REDIRECT)
    expect(tokenCall.form!.get("resource")).toBe("https://api.openai.com/v1")
    expect(status).toMatchObject({ connected: true, planUsage: true, email: "ada@example.com" })
    // models come from the account's own list; hidden ones are dropped
    expect(status.models.map((m) => m.slug)).toEqual(["gpt-6.1-sol", "gpt-6.1-sol-mini"])
    expect(readFileSync(process.env["ABSTRACT_CHATGPT_STORE"]!, "utf8")).not.toContain("dynamic_agent_client\"")
  })

  test("a replayed or unknown state is rejected before any token request", async () => {
    const fake = fakeOpenAI({ tokens: tokenEndpoint() })
    await expect(
      completeChatGPTLogin(new URLSearchParams({ code: "x", state: "forged" }), { fetchImpl: fake.fetchImpl, jwks }),
    ).rejects.toThrow(/expired or was already used/)
    expect(fake.calls).toHaveLength(0)
  })

  test("an ID token with the wrong nonce is rejected", async () => {
    const fake = fakeOpenAI({ tokens: tokenEndpoint() })
    const url = new URL(await startChatGPTLogin({ redirectUri: REDIRECT }))
    pendingNonce = "someone-elses-nonce"
    await expect(
      completeChatGPTLogin(
        new URLSearchParams({ code: "c", state: url.searchParams.get("state")!, client_id: "oaiapp_test" }),
        { fetchImpl: fake.fetchImpl, jwks },
      ),
    ).rejects.toThrow(/nonce/)
    expect(chatgptStatus().connected).toBe(false)
  })

  test("declining plan usage keeps the sign-in but marks plan usage off", async () => {
    const fake = fakeOpenAI({ tokens: tokenEndpoint("openid profile email") })
    const url = new URL(await startChatGPTLogin({ redirectUri: REDIRECT }))
    pendingNonce = url.searchParams.get("nonce")!
    const status = await completeChatGPTLogin(
      new URLSearchParams({ code: "c", state: url.searchParams.get("state")!, client_id: "oaiapp_test" }),
      { fetchImpl: fake.fetchImpl, jwks },
    )
    expect(status).toMatchObject({ connected: true, planUsage: false })
  })

  test("re-sign-in reuses the issued client id with id_token_hint, and rejects a different one", async () => {
    const fake = fakeOpenAI({ tokens: tokenEndpoint() })
    let url = new URL(await startChatGPTLogin({ redirectUri: REDIRECT }))
    pendingNonce = url.searchParams.get("nonce")!
    await completeChatGPTLogin(
      new URLSearchParams({ code: "c", state: url.searchParams.get("state")!, client_id: "oaiapp_test" }),
      { fetchImpl: fake.fetchImpl, jwks },
    )
    url = new URL(await startChatGPTLogin({ redirectUri: "http://127.0.0.1:5000/auth/callback" }))
    expect(url.searchParams.get("client_id")).toBe("oaiapp_test")
    expect(url.searchParams.get("agent_name_hint")).toBeNull()
    expect(url.searchParams.get("id_token_hint")).toBeTruthy()
    expect(url.searchParams.get("login_hint")).toBe("ada@example.com")
    await expect(
      completeChatGPTLogin(
        new URLSearchParams({ code: "c", state: url.searchParams.get("state")!, client_id: "oaiapp_other" }),
        { fetchImpl: fake.fetchImpl, jwks },
      ),
    ).rejects.toThrow(/different app registration/)
    // "use a different account" starts a fresh registration
    const fresh = new URL(await startChatGPTLogin({ redirectUri: REDIRECT, newAccount: true }))
    expect(fresh.searchParams.get("client_id")).toBe("dynamic_agent_client")
  })
})

describe("tokens", () => {
  async function signedIn(tokens = tokenEndpoint()) {
    const fake = fakeOpenAI({ tokens })
    const url = new URL(await startChatGPTLogin({ redirectUri: REDIRECT }))
    pendingNonce = url.searchParams.get("nonce")!
    await completeChatGPTLogin(
      new URLSearchParams({ code: "c", state: url.searchParams.get("state")!, client_id: "oaiapp_test" }),
      { fetchImpl: fake.fetchImpl, jwks },
    )
    return fake
  }
  const expireSoon = () => {
    const file = process.env["ABSTRACT_CHATGPT_STORE"]!
    const s = JSON.parse(readFileSync(file, "utf8"))
    s.account.expiresAt = Date.now() + 60_000
    Bun.write(file, JSON.stringify(s))
  }

  test("a fresh token is used as-is; near expiry it refreshes once, with the issued client id", async () => {
    const fake = await signedIn()
    expect(await chatgptAccessToken({ fetchImpl: fake.fetchImpl })).toBe("at-0")
    expireSoon()
    await Bun.sleep(5)
    const [a, b] = await Promise.all([
      chatgptAccessToken({ fetchImpl: fake.fetchImpl }),
      chatgptAccessToken({ fetchImpl: fake.fetchImpl }),
    ])
    expect(a).toBe(b)
    const refreshes = fake.calls.filter((c) => c.form?.get("grant_type") === "refresh_token")
    expect(refreshes).toHaveLength(1) // concurrent callers share one rotation
    expect(refreshes[0]!.form!.get("client_id")).toBe("oaiapp_test")
    expect(refreshes[0]!.form!.get("refresh_token")).toBe("rt-0")
    expect(refreshes[0]!.form!.get("resource")).toBe("https://api.openai.com/v1")
  })

  test("a dead refresh token signs out but keeps the registration", async () => {
    let first = true
    const base = tokenEndpoint()
    const fake = await signedIn(async (form) =>
      form.get("grant_type") === "refresh_token"
        ? Response.json({ error: "invalid_grant" }, { status: 400 })
        : first
          ? ((first = false), base(form))
          : base(form),
    )
    expireSoon()
    await Bun.sleep(5)
    await expect(chatgptAccessToken({ fetchImpl: fake.fetchImpl })).rejects.toThrow(/chatgpt_signed_out/)
    expect(chatgptStatus().connected).toBe(false)
    const again = new URL(await startChatGPTLogin({ redirectUri: REDIRECT })).searchParams
    expect(again.get("client_id")).toBe("oaiapp_test")
  })

  test("sign-out revokes the refresh token at OpenAI's revocation endpoint", async () => {
    const fake = await signedIn()
    expect(await chatgptSignOut({ fetchImpl: fake.fetchImpl })).toEqual({ revoked: true })
    const revoke = fake.calls.find((c) => c.url.endsWith("/oauth/revoke"))!
    expect(revoke.form!.get("token")).toBe("rt-0")
    expect(revoke.form!.get("token_type_hint")).toBe("refresh_token")
    expect(revoke.form!.get("client_id")).toBe("oaiapp_test")
    expect(chatgptStatus().connected).toBe(false)
  })

  test("an unconfirmed revocation still clears local tokens and says so", async () => {
    const fake = await signedIn()
    const failing = fakeOpenAI({ revokeStatus: 400 })
    expect(await chatgptSignOut({ fetchImpl: failing.fetchImpl })).toEqual({ revoked: false })
    expect(chatgptStatus().connected).toBe(false)
    expect(fake.calls.length).toBeGreaterThan(0)
  })
})

describe("inference adapter", () => {
  test("request bodies are rewritten for the plan route", () => {
    const out = adaptResponsesBody({
      model: "gpt-6.1-sol",
      input: [
        { role: "system", content: "be precise" },
        { role: "user", content: [{ type: "input_text", text: "hi" }] },
      ],
      temperature: 0.2,
      max_output_tokens: 500,
      top_p: 1,
      previous_response_id: "resp_1",
      store: true,
      include: ["web_search_call.action.sources"],
    })
    expect(out["store"]).toBe(false)
    expect(out["stream"]).toBe(true)
    for (const k of ["temperature", "max_output_tokens", "top_p", "previous_response_id"]) expect(out[k]).toBeUndefined()
    expect(out["include"]).toEqual(["web_search_call.action.sources", "reasoning.encrypted_content"])
    expect((out["input"] as { role: string }[])[0]!.role).toBe("developer")
  })
})

// Realistic Responses API stream — drives the REAL AI SDK through chatgptFetch
const sse = (events: Record<string, unknown>[]) => events.map((e) => `event: ${e["type"]}\ndata: ${JSON.stringify(e)}\n\n`).join("")
const completedResponse = {
  id: "resp_1",
  object: "response",
  created_at: 1790000000,
  status: "completed",
  model: "gpt-6.1-sol",
  incomplete_details: null,
  output: [
    {
      type: "message",
      id: "msg_1",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: "Hello from the plan.", annotations: [] }],
    },
  ],
  usage: { input_tokens: 12, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 } },
}
const OK_STREAM = sse([
  { type: "response.created", sequence_number: 0, response: { ...completedResponse, status: "in_progress", output: [], usage: null } },
  { type: "response.output_item.added", sequence_number: 1, output_index: 0, item: { type: "message", id: "msg_1", status: "in_progress", role: "assistant", content: [] } },
  { type: "response.output_text.delta", sequence_number: 2, item_id: "msg_1", output_index: 0, content_index: 0, delta: "Hello from ", logprobs: [] },
  { type: "response.output_text.delta", sequence_number: 3, item_id: "msg_1", output_index: 0, content_index: 0, delta: "the plan.", logprobs: [] },
  { type: "response.output_item.done", sequence_number: 4, output_index: 0, item: completedResponse.output[0] },
  // as the real plan route sends it: the final event's output is EMPTY
  { type: "response.completed", sequence_number: 5, response: { ...completedResponse, output: [] } },
])
const LIMIT_STREAM = sse([
  { type: "response.created", sequence_number: 0, response: { ...completedResponse, status: "in_progress", output: [], usage: null } },
  {
    type: "response.failed",
    sequence_number: 1,
    response: { ...completedResponse, status: "failed", error: { code: "subscription_sharing_usage_limit_exceeded", message: "limit" } },
  },
])

describe("AI SDK through the adapter", () => {
  async function model(stream: string) {
    const fake = fakeOpenAI({ tokens: tokenEndpoint(), sse: stream })
    const url = new URL(await startChatGPTLogin({ redirectUri: REDIRECT }))
    pendingNonce = url.searchParams.get("nonce")!
    await completeChatGPTLogin(
      new URLSearchParams({ code: "c", state: url.searchParams.get("state")!, client_id: "oaiapp_test" }),
      { fetchImpl: fake.fetchImpl, jwks },
    )
    const m = wrapLanguageModel({
      model: createOpenAI({ apiKey: "chatgpt-plan", fetch: chatgptFetch({ fetchImpl: fake.fetchImpl }) }).responses("gpt-6.1-sol"),
      middleware: defaultSettingsMiddleware({ settings: { providerOptions: { openai: { store: false } } } }),
    })
    return { m, fake }
  }

  test("generateText (non-streaming) is served from the stream's response.completed", async () => {
    const { m, fake } = await model(OK_STREAM)
    const r = await generateText({ model: m, system: "be precise", prompt: "hi", temperature: 0.3, maxOutputTokens: 100 })
    expect(r.text).toBe("Hello from the plan.")
    const sent = fake.calls.find((c) => c.url.endsWith("/v1/responses"))!
    expect(new Headers(sent.init!.headers).get("authorization")).toBe("Bearer at-0")
    expect(sent.json).toMatchObject({ store: false, stream: true })
    expect(sent.json!["temperature"]).toBeUndefined()
    expect(sent.json!["max_output_tokens"]).toBeUndefined()
  })

  test("streamText passes text deltas through", async () => {
    const { m } = await model(OK_STREAM)
    const r = streamText({ model: m, prompt: "hi" })
    let text = ""
    for await (const t of r.textStream) text += t
    expect(text).toBe("Hello from the plan.")
  })

  test("a usage limit fails non-streaming calls with the recognizable message", async () => {
    const { m } = await model(LIMIT_STREAM)
    await expect(generateText({ model: m, prompt: "hi", maxRetries: 0 })).rejects.toThrow(/chatgpt_usage_limit/)
  })

  test("a bare 401 reads as a sign-in problem, never as a bad API key", async () => {
    const fake = fakeOpenAI({ tokens: tokenEndpoint() })
    const url = new URL(await startChatGPTLogin({ redirectUri: REDIRECT }))
    pendingNonce = url.searchParams.get("nonce")!
    await completeChatGPTLogin(
      new URLSearchParams({ code: "c", state: url.searchParams.get("state")!, client_id: "oaiapp_test" }),
      { fetchImpl: fake.fetchImpl, jwks },
    )
    const deny = (async (input: string | URL | Request, init?: RequestInit) =>
      String(input).endsWith("/v1/responses")
        ? Response.json({ error: { code: "invalid_api_key", message: "Incorrect API key provided" } }, { status: 401 })
        : fake.fetchImpl(input, init)) as unknown as typeof fetch
    const r = await chatgptFetch({ fetchImpl: deny })("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-6.1-sol", input: "hi" }),
    })
    expect(r.status).toBe(401)
    const body = (await r.json()) as { error: { message: string } }
    expect(body.error.message).toContain("chatgpt_invalid_user")
    expect(body.error.message).not.toContain("API key")
  })

  test("a usage limit mid-stream surfaces as an error, not a silent empty reply", async () => {
    const { m } = await model(LIMIT_STREAM)
    const errors: unknown[] = []
    const r = streamText({ model: m, prompt: "hi", onError: ({ error }) => void errors.push(error) })
    for await (const _ of r.textStream) {
      /* drain */
    }
    expect(JSON.stringify(errors)).toContain("chatgpt_usage_limit")
  })
})

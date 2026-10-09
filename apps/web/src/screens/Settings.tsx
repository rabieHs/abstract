import { useEffect, useState } from "react"
import { getJson, MANAGE_USAGE_URL, send, type ChatGPTStatus, type ModelsInfo } from "../api"

export default function Settings() {
  const [models, setModels] = useState<ModelsInfo>()
  const [adding, setAdding] = useState(false)
  const [picked, setPicked] = useState<string | null>(null)
  const [key, setKey] = useState("")
  const [managing, setManaging] = useState<string | null>(null)
  const [rotate, setRotate] = useState("")

  const [gpt, setGpt] = useState<ChatGPTStatus>()
  /** the sign-in we're waiting on, keyed by the status it started from */
  const [gptWaiting, setGptWaiting] = useState<{ from?: string; at: number } | null>(null)
  const [gptNote, setGptNote] = useState<string | null>(null)

  const refresh = () => getJson<ModelsInfo>("/api/models").then(setModels).catch(() => {})
  const loadGpt = () => getJson<ChatGPTStatus>("/api/chatgpt").then(setGpt).catch(() => {})
  useEffect(() => {
    void refresh()
    void loadGpt()
  }, [])

  // ChatGPT has its own card below — it signs in, it doesn't take a key
  const connected = models?.providers.filter((p) => p.available && p.id !== "chatgpt") ?? []
  const available = models?.providers.filter((p) => !p.available && p.id !== "chatgpt") ?? []

  async function continueWithChatGPT(newAccount = false) {
    setGptNote(null)
    const r = await send("/api/chatgpt/login", "POST", { newAccount })
    const { url } = (await r.json()) as { url: string }
    window.open(url, "_blank")
    setGptWaiting({ from: gpt?.signedInAt, at: Date.now() })
  }

  // the browser round-trip finishes in the other tab — poll until it lands
  useEffect(() => {
    if (!gptWaiting) return
    const iv = setInterval(async () => {
      const s = await getJson<ChatGPTStatus>("/api/chatgpt").catch(() => null)
      if (s?.signedInAt && s.signedInAt !== gptWaiting.from) {
        setGpt(s)
        setGptWaiting(null)
        await refresh()
      } else if (Date.now() - gptWaiting.at > 5 * 60 * 1000) {
        setGptWaiting(null)
      }
    }, 1500)
    return () => clearInterval(iv)
  }, [gptWaiting])

  async function signOutChatGPT() {
    const r = await send("/api/chatgpt/logout", "POST")
    const { revoked } = (await r.json()) as { revoked: boolean }
    setGptNote(
      revoked
        ? null
        : "Signed out here, but OpenAI didn't confirm the revocation — you can also disconnect abstract in ChatGPT settings.",
    )
    await loadGpt()
    await refresh()
  }

  async function dismissWelcome() {
    await send("/api/chatgpt/welcomed", "POST")
    await loadGpt()
  }

  async function saveProvider(id: string, value: string) {
    const body = id === "ollama" ? { id, baseURL: value } : { id, apiKey: value }
    await send("/api/providers", "PUT", body)
    setAdding(false)
    setPicked(null)
    setKey("")
    setManaging(null)
    setRotate("")
    await refresh()
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-paper">
      <div className="mx-auto max-w-[var(--container-chat)] px-6 py-10">
        <h1 className="font-serif text-2xl font-semibold">Settings</h1>

        <span className="steplabel mb-1 mt-8 block font-bold">use your chatgpt plan</span>
        <div className="mb-8 border border-linec bg-surface">
          {!gpt?.connected ? (
            <div className="px-4 py-4">
              <p className="text-[13px] text-muted">
                Run abstract on your ChatGPT Plus or Pro plan — no API key. You sign in on
                openai.com in a new tab; usage counts toward your plan.
              </p>
              <div className="mt-3 flex items-center gap-3">
                <button
                  onClick={() => void continueWithChatGPT()}
                  disabled={Boolean(gptWaiting)}
                  className="bg-ink px-4 py-2 text-[13px] font-medium text-paper disabled:opacity-60"
                >
                  Continue with ChatGPT
                </button>
                {gptWaiting && (
                  <>
                    <span className="op-shimmer text-[12.5px] text-muted">waiting for sign-in in the other tab…</span>
                    <button onClick={() => setGptWaiting(null)} className="px-2 py-1 text-[12px] text-muted hover:bg-paper">
                      cancel
                    </button>
                  </>
                )}
              </div>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2.5 px-4 py-3">
                <span className="text-sm font-medium">ChatGPT plan</span>
                {gpt.planUsage ? (
                  <span className="font-mono text-[10px] uppercase text-ok">active</span>
                ) : (
                  <span className="font-mono text-[10px] uppercase text-warn">plan usage off</span>
                )}
                {gpt.email && <span className="font-mono text-[11px] text-muted">{gpt.email}</span>}
                {gpt.planUsage && (
                  <span className="font-mono text-[11px] text-muted">
                    {models?.providers.find((p) => p.id === "chatgpt")?.models.length ?? gpt.models.length} models
                  </span>
                )}
                <span className="ml-auto flex items-center gap-1">
                  <a
                    href={MANAGE_USAGE_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="px-2 py-1 text-[12px] text-muted no-underline hover:bg-paper hover:text-ink"
                  >
                    Manage usage ↗
                  </a>
                  <button onClick={() => void signOutChatGPT()} className="px-2 py-1 text-[12px] text-muted hover:bg-paper">
                    Sign out
                  </button>
                </span>
              </div>
              <div className="border-t border-linec bg-paper px-4 py-3 text-[12px] text-muted">
                {!gpt.planUsage ? (
                  <div className="flex flex-wrap items-center gap-3">
                    <span>
                      Plan usage wasn't allowed, so abstract can't run models on this account.
                    </span>
                    <button
                      onClick={() => void continueWithChatGPT()}
                      className="border border-linec bg-surface px-3 py-1 text-[12px] text-ink hover:border-accent"
                    >
                      Continue with ChatGPT
                    </button>
                  </div>
                ) : (
                  <span>
                    ChatGPT plans don't include embeddings — library search uses keywords unless
                    OpenAI, Google, or Ollama is also connected below.
                  </span>
                )}
                <button
                  onClick={() => void continueWithChatGPT(true)}
                  className="mt-1.5 block text-[11.5px] text-faint underline hover:text-ink"
                >
                  use a different ChatGPT account
                </button>
              </div>
            </>
          )}
          {gptNote && <div className="border-t border-linec px-4 py-2 text-[12px] text-warn">{gptNote}</div>}
        </div>

        {gpt?.connected && gpt.planUsage && !gpt.welcomed && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 px-6">
            <div className="w-full max-w-sm border border-linec bg-surface p-6">
              <h2 className="font-serif text-lg font-semibold">You're using your ChatGPT plan</h2>
              <p className="mt-2 text-[13px] text-muted">
                abstract now runs its models on your ChatGPT plan, and its requests count toward your
                plan's limits. You can see usage and set a cap for abstract in ChatGPT settings.
              </p>
              <div className="mt-5 flex items-center gap-3">
                <button onClick={() => void dismissWelcome()} className="bg-ink px-4 py-1.5 text-[13px] font-medium text-paper">
                  Got it
                </button>
                <a
                  href={MANAGE_USAGE_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[12.5px] text-muted hover:text-ink"
                >
                  Manage usage ↗
                </a>
              </div>
            </div>
          </div>
        )}

        <span className="steplabel mb-1 block font-bold">api keys</span>
        <p className="mb-3 text-[13px] text-muted">
          Keys live in <code className="font-mono text-[11.5px]">~/.abstract/config.json</code>{" "}
          and never leave your machine. Environment variables take precedence.
        </p>

        <div className="divide-y divide-linec border border-linec">
          {connected.map((p) => (
            <div key={p.id} className="bg-surface">
              <div className="flex items-center gap-2.5 px-4 py-3">
                <span className="text-sm font-medium">{p.name}</span>
                <span className="font-mono text-[10px] uppercase text-ok">active</span>
                <span className="font-mono text-[11px] text-muted">{p.models.length} models</span>
                <button
                  onClick={() => setManaging(managing === p.id ? null : p.id)}
                  className="ml-auto px-2 py-1 text-[12px] text-muted hover:bg-paper"
                >
                  {managing === p.id ? "close" : "manage"}
                </button>
              </div>
              {managing === p.id && (
                <div className="flex items-center gap-2 border-t border-linec bg-paper px-4 py-3">
                  <input
                    type={p.id === "ollama" ? "text" : "password"}
                    placeholder={p.id === "ollama" ? "base URL" : "rotate API key"}
                    value={rotate}
                    onChange={(e) => setRotate(e.target.value)}
                    className="min-w-0 flex-1 border border-linec bg-surface px-3 py-1.5 font-mono text-[12px] outline-none focus:border-accent"
                  />
                  <button
                    onClick={() => rotate.trim() && void saveProvider(p.id, rotate.trim())}
                    className="border border-linec bg-surface px-3 py-1.5 text-[12px] hover:border-accent"
                  >
                    Save
                  </button>
                  <button
                    onClick={() => void saveProvider(p.id, "")}
                    className="px-2 py-1.5 text-[12px] text-bad hover:bg-surface"
                  >
                    remove
                  </button>
                </div>
              )}
            </div>
          ))}

          {!adding ? (
            <button
              onClick={() => setAdding(true)}
              className="bg-surface px-4 py-2.5 text-center text-sm text-muted hover:text-ink"
            >
              + Add provider
            </button>
          ) : (
            <div className="border-t border-dashed border-faint bg-surface p-4">
              <div className="flex items-center">
                <span className="steplabel font-bold">add a provider</span>
                <button
                  onClick={() => {
                    setAdding(false)
                    setPicked(null)
                    setKey("")
                  }}
                  className="ml-auto px-2 py-1 text-[12px] text-muted hover:bg-paper"
                >
                  cancel
                </button>
              </div>
              <div className="mt-3 grid grid-cols-3 gap-1.5">
                {available.map((p) => (
                  <button
                    key={p.id}
                    className={"provtile" + (picked === p.id ? " on" : "")}
                    onClick={() => setPicked(p.id)}
                  >
                    <span className="text-[13px] font-medium">{p.name}</span>
                    <span className="font-mono text-[9.5px] uppercase text-faint">
                      {p.id === "ollama" ? "local" : p.id === "openrouter" ? "aggregator" : "api key"}
                    </span>
                  </button>
                ))}
              </div>
              {picked && (
                <form
                  className="mt-3 flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault()
                    if (key.trim()) void saveProvider(picked, key.trim())
                  }}
                >
                  <input
                    autoFocus
                    type={picked === "ollama" ? "text" : "password"}
                    placeholder={picked === "ollama" ? "http://localhost:11434" : "paste API key"}
                    value={key}
                    onChange={(e) => setKey(e.target.value)}
                    className="min-w-0 flex-1 border border-linec bg-paper px-3 py-1.5 font-mono text-[12px] outline-none focus:border-accent"
                  />
                  <button className="bg-ink px-4 py-1.5 text-[12px] font-medium text-paper">
                    Connect
                  </button>
                </form>
              )}
            </div>
          )}
        </div>

        <p className="mt-6 text-[12.5px] text-muted">
          Pick the model from the chat box — abstract uses it for every task.
        </p>
      </div>
    </div>
  )
}

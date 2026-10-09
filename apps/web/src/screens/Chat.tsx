import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useChat } from "@ai-sdk/react"
import { DefaultChatTransport } from "ai"
import type { UIMessage } from "ai"
import { getJson, MANAGE_USAGE_URL, send as apiSend, type ModelsInfo, type SourceFile } from "../api"
import { HeroLogo } from "../logos"
import { Explorer } from "../explorer"
import {
  CropFrame, DraftView, Escapement, FilePane, GradeChip, Icon, Md, PlanView, SourcePane, StepRow,
  SubagentsView,
  type DraftOutput, type SourceRequest, type SubagentReport, type ToolPartLike,
} from "../ui"

const Assistant = memo(function Assistant({
  message,
  onShowSource,
}: {
  message: UIMessage
  onShowSource: (r: SourceRequest) => void
}) {
  const blocks: { kind: "text" | "steps"; parts: unknown[] }[] = []
  for (const part of message.parts) {
    const isTool = part.type.startsWith("tool-") || part.type === "dynamic-tool"
    const isText = part.type === "text"
    if (!isTool && !isText) continue
    const last = blocks[blocks.length - 1]
    const kind = isTool ? "steps" : "text"
    if (last && last.kind === kind) last.parts.push(part)
    else blocks.push({ kind, parts: [part] })
  }
  return (
    <div className="grid gap-2.5">
      {blocks.map((b, bi) =>
        b.kind === "text" ? (
          (b.parts as { text: string }[]).map((p, i) => (
            <Md key={`${bi}:${i}`} text={p.text} />
          ))
        ) : (
          <div key={bi} className="py-1">
            {(b.parts as ToolPartLike[]).map((p, i) => (
              <div key={i}>
                {p.type === "tool-update_plan" ? (
                  <PlanView
                    todos={
                      ((p.input as { todos?: { content: string; status: string }[] })?.todos) ?? []
                    }
                  />
                ) : p.type === "tool-delegate" &&
                  p.state === "output-available" &&
                  (p.output as { subagents?: SubagentReport[] })?.subagents ? (
                  <>
                    <StepRow part={p} last={false} />
                    <SubagentsView subagents={(p.output as { subagents: SubagentReport[] }).subagents} />
                  </>
                ) : (
                  <StepRow part={p} last={i === b.parts.length - 1} />
                )}
                {p.type === "tool-draft_section" &&
                  p.state === "output-available" &&
                  (p.output as DraftOutput)?.sentences && (
                    <DraftView out={p.output as DraftOutput} onShowSource={onShowSource} />
                  )}
              </div>
            ))}
          </div>
        ),
      )}
    </div>
  )
})

export default function Chat({
  session,
  title,
  onIdle,
}: {
  session: { id: string; fresh: boolean }
  title: string
  onIdle: () => void
}) {
  const [models, setModels] = useState<ModelsInfo>()
  const [sources, setSources] = useState<SourceFile[]>([])
  const [sourceReq, setSourceReq] = useState<SourceRequest | null>(null)
  const [fileView, setFileView] = useState<string | null>(null)
  const showSource = (r: SourceRequest) => {
    setFileView(null)
    setSourceReq(r)
  }
  const showFile = (path: string) => {
    setSourceReq(null)
    setFileView(path)
  }
  const [input, setInput] = useState("")
  const [menu, setMenu] = useState<"attach" | "model" | null>(null)
  const [attached, setAttached] = useState<File[]>([])
  const attachInputRef = useRef<HTMLInputElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const composerRef = useRef<HTMLFormElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const sessionIdRef = useRef(session.id)

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/chat",
        prepareSendMessagesRequest: ({ messages }) => ({
          body: { messages, sessionId: sessionIdRef.current },
        }),
        // reattach to a live run (a refreshed browser used to stare at a blank
        // thread until the whole turn ended); the server replies 204 when idle
        prepareReconnectToStreamRequest: () => ({
          api: `/api/chat/${sessionIdRef.current}/live`,
        }),
      }),
    [],
  )
  // experimental_throttle batches UI repaints to ~11/sec so a fast model's token
  // stream can't saturate the main thread (the markdown re-parse was quadratic).
  // Generation speed is untouched — this only paces client-side painting.
  const { messages, sendMessage, status, error, setMessages, stop, clearError, resumeStream } = useChat({
    transport,
    experimental_throttle: 90,
  })
  const busy = status === "submitted" || status === "streaming"
  // live status for callbacks — `busy`/`status` consts go stale inside closures
  const statusRef = useRef(status)
  statusRef.current = status
  // messages the user typed WHILE the agent works — shown as transient pills and
  // never injected into useChat's streaming state (that desynced it and doubled
  // the tool rows). The post-turn refetch brings in the true interleaved thread.
  const [pendingSteers, setPendingSteers] = useState<string[]>([])
  // steers whose interject arrived after the run ended (server 409) — resent as
  // a normal message once the client stream settles
  const steerQueueRef = useRef<string[]>([])
  // the user pressed Stop: auto-continue must NOT restart the run they killed
  const suppressContinueRef = useRef(false)
  // which session the in-flight run belongs to — a session switch mid-stream
  // must never auto-continue the session we switched TO
  const busySessionRef = useRef<string | null>(null)

  async function stopRun() {
    // kill the client stream AND the server-side generation (the drain keeps
    // runs alive across disconnects by design, so the server must be told)
    suppressContinueRef.current = true
    void stop()
    try {
      await apiSend("/api/chat/stop", "POST", { sessionId: sessionIdRef.current })
    } catch {
      /* server unreachable — client stream is already stopped */
    }
  }

  const fetchSources = () =>
    getJson<{ files: SourceFile[] }>("/api/sources").then((d) => setSources(d.files ?? [])).catch(() => {})
  const fetchModels = () => getJson<ModelsInfo>("/api/models").then(setModels).catch(() => {})

  useEffect(() => {
    sessionIdRef.current = session.id
    // detach from any stream still attached to the previous session — otherwise
    // its next chunk pushes the old session's partial reply into this thread.
    // (server-side the run keeps going and persists via the drain, by design)
    void stop()
    clearError()
    setPendingSteers([])
    steerQueueRef.current = []
    pinnedRef.current = true // every session opens pinned to its latest message
    if (session.fresh) setMessages([])
    else
      getJson<{ messages: UIMessage[] }>(`/api/sessions/${session.id}/messages`)
        .then((d) => {
          if (sessionIdRef.current !== session.id) return
          setMessages(d.messages ?? [])
          // a run may still be LIVE for this session (opened after a refresh
          // or from another tab) — reattach and stream its progress; the
          // server answers 204 when idle and this is a clean no-op
          void resumeStream()
        })
        .catch(() => {})
  }, [session])

  useEffect(() => {
    void fetchModels()
    void fetchSources()
  }, [])

  useEffect(() => {
    if (busy) {
      busySessionRef.current = sessionIdRef.current
      suppressContinueRef.current = false // a new run makes future continues legitimate
      return
    }
    void fetchSources()
    onIdle()
    // a steer that missed its run (server 409'd the interject) becomes the
    // next normal message the moment the stream settles
    const queued = steerQueueRef.current.splice(0)
    if (queued.length > 0) {
      // drop only the queued steers' own pills — delivered ones stay visible
      // until a refetch brings them back interleaved in the thread
      setPendingSteers((p) => p.filter((x) => !queued.includes(x)))
      void sendMessage({ text: queued.join("\n\n") })
      statusRef.current = "submitted" // close the same-tick double-send window
      return
    }
    // sync with the server-side snapshot: interleaved steering segments,
    // error messages and tool-only-turn summaries exist only server-side
    if (messages.length > 0) {
      const sid = sessionIdRef.current
      const ranSession = busySessionRef.current
      const t = setTimeout(() => {
        if (sessionIdRef.current !== sid) return
        getJson<{ messages: UIMessage[] }>(`/api/sessions/${sid}/messages`)
          .then((d) => {
            if (sessionIdRef.current !== sid || !d.messages?.length) return
            // a new run is already streaming — this snapshot is stale
            if (statusRef.current === "submitted" || statusRef.current === "streaming") return
            setMessages(d.messages)
            // only now do the pills come back interleaved in the thread
            setPendingSteers([])
            // a steer that was never delivered mid-run is persisted as a
            // trailing user message — continue the run so it gets ANSWERED
            // (sendMessage with no argument re-submits the current history).
            // Never after Stop, and never for a session the run didn't belong to.
            if (
              statusRef.current === "ready" &&
              !suppressContinueRef.current &&
              ranSession === sid &&
              d.messages[d.messages.length - 1]?.role === "user"
            ) {
              void sendMessage()
              statusRef.current = "submitted"
            }
          })
          .catch(() => {}) // keep the pills — better stale than vanished
      }, 1200)
      return () => clearTimeout(t)
    }
    setPendingSteers([])
  }, [busy])

  // keep pinned to the bottom while streaming, but don't yank the view if the
  // user has scrolled up to read; instant (not smooth) so it can't queue layout.
  // Pinnedness comes from scroll INTENT (the onScroll handler below), not from
  // post-commit geometry — one big appended block (a table, a draft panel) would
  // otherwise push the bottom >200px away in a single tick and silently unpin.
  // the composer grows with its content like a normal chat input — up to a
  // cap, then it scrolls internally (covers typing AND programmatic setInput)
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = Math.min(el.scrollHeight, 200) + "px"
  }, [input])

  const pinnedRef = useRef(true)
  useEffect(() => {
    if (pinnedRef.current) bottomRef.current?.scrollIntoView({ behavior: "auto", block: "end" })
  }, [messages, status, pendingSteers])

  useEffect(() => {
    if (!menu) return
    const close = (e: MouseEvent) => {
      if (composerRef.current && !composerRef.current.contains(e.target as Node)) setMenu(null)
    }
    document.addEventListener("mousedown", close)
    return () => document.removeEventListener("mousedown", close)
  }, [menu])

  // the picker lists connected providers only, each under its own heading
  const groups = useMemo(
    () => models?.providers.filter((p) => p.available && p.models.length > 0) ?? [],
    [models],
  )
  const currentModel = models?.roles["orchestrator"] ?? ""

  async function pickModel(spec: string) {
    setMenu(null)
    await apiSend("/api/models", "PUT", { role: "orchestrator", spec })
    await fetchModels()
  }

  async function uploadFiles(list: FileList | null) {
    if (!list?.length) return
    const form = new FormData()
    for (const f of Array.from(list)) form.append("files", f)
    await fetch("/api/sources/upload", { method: "POST", body: form })
    void fetchSources()
  }

  function say(text: string) {
    if (busy || !text.trim()) return
    void sendMessage({ text })
  }

  function submit(e: React.FormEvent) {
    e.preventDefault()
    const t = input.trim()
    if (!t && attached.length === 0) return
    if (busy) {
      // steering: talk to the agent while it works — delivered at its next step.
      // Do NOT touch useChat's streaming messages; show a transient pill instead.
      if (!t) return
      setInput("")
      setPendingSteers((p) => [...p, t])
      void apiSend("/api/chat/interject", "POST", { sessionId: sessionIdRef.current, text: t })
        .then(async (r) => {
          const d = await r.json().catch(() => ({ error: "bad response" }))
          if (d.error) {
            // the run just ended — resend as a normal message. Queue it: the
            // !busy effect flushes once the stream settles (`busy` here is a
            // stale closure, so never gate a direct send on it).
            steerQueueRef.current.push(t)
            if (statusRef.current !== "submitted" && statusRef.current !== "streaming") {
              const queued = steerQueueRef.current.splice(0)
              if (queued.length > 0) {
                setPendingSteers((p) => p.filter((x) => !queued.includes(x)))
                void sendMessage({ text: queued.join("\n\n") })
                // sendMessage's status write reaches statusRef only at the next
                // render — stamp it now so a second 409 callback in the same
                // tick queues instead of firing a concurrent request
                statusRef.current = "submitted"
              }
            }
          }
        })
        .catch(() => {
          // never reached the server — an honest pill must not say "sent"
          setPendingSteers((p) => p.filter((x) => x !== t))
          setInput((cur) => cur || t)
        })
      return
    }
    setInput("")
    if (attached.length > 0) {
      const dt = new DataTransfer()
      for (const f of attached) dt.items.add(f)
      setAttached([])
      void sendMessage({ text: t || "See the attached file(s).", files: dt.files })
    } else {
      say(t)
    }
  }


  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* header */}
        <div className="flex items-center gap-2.5 border-b border-linec bg-surface px-6 py-[11px]">
          <span className="truncate text-[13px] font-medium">{title}</span>
          <span className="steplabel ml-auto border border-linec px-1.5 py-0.5 !text-[9px]">
            audit on export
          </span>
        </div>
        <div className="hatch" />

        <div
          ref={scrollRef}
          onScroll={() => {
            const el = scrollRef.current
            if (el) pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 200
          }}
          className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
        >
          <div className="msgcol mx-auto grid w-full max-w-[var(--container-chat)] gap-6 px-6 py-6">
            {messages.length === 0 && (
              <CropFrame className="mt-14 text-center">
                <div className="mb-5 flex justify-center">
                  <HeroLogo />
                </div>
                <p className="font-serif text-2xl">What are we working on?</p>
                <p className="mt-2 text-sm text-muted">
                  Ask about your sources, search the literature, or request a verified draft.
                </p>
              </CropFrame>
            )}
            {messages.map((m) =>
              m.role === "user" ? (
                <div key={m.id} className="flex justify-end">
                  <div className="max-w-[80%] border border-linec bg-surface px-4 py-2.5 text-[15px] leading-[1.6]">
                    {m.parts.map((p, i) => {
                      if (p.type === "text")
                        return (
                          <div key={i} className="whitespace-pre-wrap">
                            {p.text}
                          </div>
                        )
                      if (p.type === "file") {
                        const fp = p as { mediaType?: string; url?: string; filename?: string }
                        if (fp.mediaType?.startsWith("image/"))
                          return (
                            <img
                              key={i}
                              src={fp.url}
                              alt={fp.filename ?? "attached image"}
                              className="my-1.5 max-h-72 max-w-full border border-linec"
                            />
                          )
                        return (
                          <span key={i} className="my-1 inline-flex items-center gap-1.5 border border-linec bg-paper px-2 py-0.5 font-mono text-[10.5px]">
                            <Icon name="clip" className="flex-none" /> {fp.filename ?? "attachment"}
                          </span>
                        )
                      }
                      return null
                    })}
                  </div>
                </div>
              ) : (
                <Assistant key={m.id} message={m} onShowSource={showSource} />
              ),
            )}
            {pendingSteers.map((t, i) => (
              <div key={`steer-${i}`} className="flex justify-end">
                <div className="max-w-[80%] border border-dashed border-linec bg-surface px-4 py-2.5 text-[15px] leading-[1.6]">
                  <div className="whitespace-pre-wrap">{t}</div>
                  <div className="steplabel mt-1 text-faint">sent · the agent reads it at its next step</div>
                </div>
              </div>
            ))}
            {busy && (
              <div className="flex items-center gap-2.5">
                <Escapement />
                <span className="op-shimmer steplabel">working</span>
              </div>
            )}
            {error && /chatgpt\.com\/settings\/usage/.test(error.message) ? (
              <div className="border border-linec bg-surface px-5 py-4">
                <div className="steplabel text-faint">chatgpt plan</div>
                <div className="mt-1 text-[15px] font-medium">Usage limit reached</div>
                <p className="mt-1 text-sm text-muted">
                  The limit may cover your whole plan or only abstract. Everything so far is saved —
                  raise the cap or wait for it to reset, or switch models, then resend.
                </p>
                <div className="mt-3 flex items-center gap-2">
                  <a
                    href={MANAGE_USAGE_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="bg-ink px-3 py-1.5 text-[12.5px] font-medium text-paper no-underline"
                  >
                    Manage usage
                  </a>
                  <button
                    onClick={() => {
                      clearError()
                      setMenu("model")
                    }}
                    className="px-3 py-1.5 text-[12.5px] text-muted hover:bg-paper"
                  >
                    Switch model
                  </button>
                </div>
              </div>
            ) : error ? (
              <div className="border border-bad/40 bg-badsoft px-4 py-2 text-sm text-bad">
                {error.message}
              </div>
            ) : null}
            <div ref={bottomRef} />
          </div>
        </div>

        {/* composer — input on top, controls below */}
        <div className="px-6 pb-5">
          <form
            ref={composerRef}
            onSubmit={submit}
            className="relative mx-auto max-w-[var(--container-chat)] border border-linec bg-surface px-3 pb-2 pt-2.5"
          >
            <textarea
              ref={inputRef}
              value={input}
              rows={1}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                // Enter sends, Shift+Enter makes a new line — standard chat UX
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault()
                  composerRef.current?.requestSubmit()
                }
              }}
              placeholder={busy ? "message the agent while it works…" : "Ask a follow up…"}
              className="block max-h-[200px] w-full resize-none bg-transparent px-0.5 pb-2.5 pt-1 text-[15px] leading-[1.55] outline-none placeholder:text-faint"
            />
            {attached.length > 0 && (
              <div className="flex flex-wrap gap-1.5 px-0.5 pb-2">
                {attached.map((f, i) => (
                  <span key={i} className="flex items-center gap-1.5 border border-linec bg-paper px-2 py-0.5 font-mono text-[10.5px]">
                    <Icon name={f.type.startsWith("image/") ? "image" : "clip"} className="flex-none" />
                    {f.name}
                    <button type="button" onClick={() => setAttached((a) => a.filter((_, j) => j !== i))} className="text-muted hover:text-bad">✕</button>
                  </span>
                ))}
              </div>
            )}
            <div className="flex items-center gap-1.5">
              <span className="relative inline-flex">
                <button
                  type="button"
                  onClick={() => setMenu(menu === "attach" ? null : "attach")}
                  className="flex h-7 w-7 items-center justify-center border border-linec text-muted hover:border-accent hover:text-accent"
                >
                  +
                </button>
                {menu === "attach" && (
                  <div className="absolute bottom-[calc(100%+8px)] left-0 z-30 min-w-[210px] border border-linec bg-surface p-1">
                    <button
                      type="button"
                      onClick={() => {
                        setMenu(null)
                        attachInputRef.current?.click()
                      }}
                      className="block w-full px-2.5 py-[7px] text-left text-[12.5px] hover:bg-paper"
                    >
                      Attach to this message <span className="text-faint">(not saved)</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setMenu(null)
                        fileInputRef.current?.click()
                      }}
                      className="block w-full px-2.5 py-[7px] text-left text-[12.5px] hover:bg-paper"
                    >
                      Save files to workspace
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setMenu(null)
                        const url = window.prompt("Paper URL, DOI, or arXiv id:")
                        if (url?.trim()) say(`Fetch this paper into the library: ${url.trim()}`)
                      }}
                      className="block w-full px-2.5 py-[7px] text-left text-[12.5px] hover:bg-paper"
                    >
                      Import from URL
                    </button>
                  </div>
                )}
              </span>

              <span className="relative inline-flex">
                <button
                  type="button"
                  onClick={() => setMenu(menu === "model" ? null : "model")}
                  className="inline-flex max-w-60 items-center gap-1.5 px-2 py-[5px] font-mono text-[11px] text-muted hover:bg-paper hover:text-ink"
                >
                  <span className="truncate">{currentModel || "no model"}</span>
                  <span className="text-[9px]">⌄</span>
                </button>
                {currentModel.startsWith("chatgpt/") && (
                  <span className="hidden items-center gap-1 whitespace-nowrap font-mono text-[10.5px] text-faint sm:inline-flex">
                    Using ChatGPT plan ·
                    <a href={MANAGE_USAGE_URL} target="_blank" rel="noreferrer" className="text-faint hover:text-ink">
                      Manage usage
                    </a>
                  </span>
                )}
                {menu === "model" && (
                  <div className="absolute bottom-[calc(100%+8px)] left-0 z-30 max-h-[min(60vh,420px)] min-w-[230px] overflow-y-auto border border-linec bg-surface p-1">
                    {groups.length === 0 && (
                      <div className="px-2.5 py-2 text-[12px] text-muted">No model connected — open Settings.</div>
                    )}
                    {groups.map((g) => (
                      <div key={g.id}>
                        <div className="steplabel px-2.5 pb-1 pt-2 text-faint">{g.name}</div>
                        {g.models.map((m) => {
                          const spec = `${g.id}/${m}`
                          return (
                            <button
                              key={spec}
                              type="button"
                              onClick={() => void pickModel(spec)}
                              className={`block w-full whitespace-nowrap px-2.5 py-[7px] text-left font-mono text-[11px] ${
                                spec === currentModel ? "bg-accentsoft text-accent" : "hover:bg-paper"
                              }`}
                            >
                              {m}
                            </button>
                          )
                        })}
                      </div>
                    ))}
                  </div>
                )}
              </span>

              <span className="flex-1" />
              {busy ? (
                <span className="flex gap-1.5">
                  {input.trim() && (
                    <button
                      type="submit"
                      title="send to the agent now — read at its next step"
                      className="flex h-[30px] w-[30px] items-center justify-center border border-linec bg-surface text-ink hover:border-accent"
                    >
                      ↑
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void stopRun()}
                    title="stop the agent"
                    className="flex h-[30px] w-[30px] items-center justify-center bg-ink text-paper hover:bg-bad"
                  >
                    <span className="block h-[10px] w-[10px] bg-paper" />
                  </button>
                </span>
              ) : (
                <button
                  type="submit"
                  disabled={!input.trim() && attached.length === 0}
                  className="flex h-[30px] w-[30px] items-center justify-center bg-ink text-paper disabled:opacity-30"
                >
                  ↑
                </button>
              )}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".pdf,.md,.markdown,.txt,.tex,.bib,.png,.jpg,.jpeg"
              className="hidden"
              onChange={(e) => void uploadFiles(e.target.files)}
            />
            <input
              ref={attachInputRef}
              type="file"
              multiple
              accept=".pdf,.md,.markdown,.txt,.png,.jpg,.jpeg"
              className="hidden"
              onChange={(e) => {
                const list = e.target.files
                if (list) setAttached((a) => [...a, ...Array.from(list)].slice(0, 6))
                e.target.value = ""
              }}
            />
          </form>
        </div>
      </main>

      <Explorer onAdd={() => fileInputRef.current?.click()} onOpenFile={showFile} />

      {sourceReq && <SourcePane req={sourceReq} onClose={() => setSourceReq(null)} />}
      {!sourceReq && fileView && <FilePane path={fileView} onClose={() => setFileView(null)} />}
    </div>
  )
}

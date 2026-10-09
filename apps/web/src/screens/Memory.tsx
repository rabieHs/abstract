import { useEffect, useState } from "react"
import { getJson, send, type MemoryNote } from "../api"

export default function Memory() {
  const [notes, setNotes] = useState<MemoryNote[]>([])
  const [kind, setKind] = useState("preference")
  const [content, setContent] = useState("")

  const refresh = () =>
    getJson<{ notes: MemoryNote[] }>("/api/memory").then((d) => setNotes(d.notes ?? [])).catch(() => {})
  useEffect(() => {
    void refresh()
  }, [])

  async function add(e: React.FormEvent) {
    e.preventDefault()
    if (!content.trim()) return
    await send("/api/memory", "POST", { kind, content: content.trim() })
    setContent("")
    await refresh()
  }

  const pending = notes.filter((n) => !n.approved)
  const active = notes.filter((n) => n.approved)

  const Note = ({ n }: { n: MemoryNote }) => (
    <div className={`border px-4 py-3 ${n.approved ? "border-linec bg-surface" : "border-warn/40 bg-warnsoft/40"}`}>
      <div className="flex items-center gap-2">
        <span className="font-mono text-[10px] uppercase text-muted">{n.kind}</span>
        {!n.approved && <span className="font-mono text-[10px] text-warn">pending your approval</span>}
        <span className="ml-auto flex gap-2 text-sm">
          <button
            onClick={() => void send(`/api/memory/${n.id}`, "PUT", { approved: !n.approved }).then(refresh)}
            className="px-2 py-0.5 hover:bg-paper"
          >
            {n.approved ? "pause" : "approve"}
          </button>
          <button
            onClick={() => void send(`/api/memory/${n.id}`, "DELETE").then(refresh)}
            className="px-2 py-0.5 text-bad hover:bg-paper"
          >
            delete
          </button>
        </span>
      </div>
      <p className="mt-1 text-[14px]">{n.content}</p>
    </div>
  )

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-paper">
      <div className="mx-auto max-w-[var(--container-chat)] px-6 py-10">
        <h1 className="font-serif text-2xl font-semibold">Memory</h1>
        <p className="mt-1 text-sm text-muted">
          Approved notes shape every reply. Nothing is learned silently — what the agent proposes
          waits here for you.
        </p>

        <form onSubmit={add} className="mt-6 flex gap-2">
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            className="border border-linec bg-surface px-2 py-2 font-mono text-[12px]"
          >
            {["preference", "style", "project", "lesson"].map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
          <input
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder='e.g. "Always use IEEE citation style"'
            className="flex-1 border border-linec bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
          />
          <button className="bg-ink px-4 text-sm font-medium text-paper">Add</button>
        </form>

        {pending.length > 0 && (
          <>
            <div className="steplabel mb-2 mt-8 font-bold">pending — the agent proposed these</div>
            <div className="space-y-2">{pending.map((n) => <Note key={n.id} n={n} />)}</div>
          </>
        )}
        <div className="steplabel mb-2 mt-8 font-bold">active</div>
        <div className="space-y-2">
          {active.length === 0 && <p className="text-sm text-muted">Nothing yet.</p>}
          {active.map((n) => (
            <Note key={n.id} n={n} />
          ))}
        </div>
      </div>
    </div>
  )
}

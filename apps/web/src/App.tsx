import { useEffect, useState } from "react"
import { getJson, send, type SessionInfo, type WorkspaceInfo } from "./api"
import { Icon } from "./ui"
import Chat from "./screens/Chat"
import Memory from "./screens/Memory"
import Settings from "./screens/Settings"
import Skills from "./screens/Skills"
import Workspaces from "./screens/Workspaces"

type Screen = "chat" | "memory" | "skills" | "settings" | "workspaces"

const NAV: { label: string; target: Screen }[] = [
  { label: "Memory", target: "memory" },
  { label: "Skills", target: "skills" },
  { label: "Settings", target: "settings" },
  { label: "Workspaces", target: "workspaces" },
]

export default function App() {
  // boots straight into chat — the product IS the platform
  const [screen, setScreen] = useState<Screen>("chat")
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null)
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  // survive refresh: restore the last open conversation
  const [session, setSession] = useState<{ id: string; fresh: boolean }>(() => {
    const saved = localStorage.getItem("abstract.session")
    return saved ? { id: saved, fresh: false } : { id: crypto.randomUUID(), fresh: true }
  })

  useEffect(() => {
    localStorage.setItem("abstract.session", session.id)
  }, [session.id])

  const fetchSessions = () =>
    getJson<{ sessions: SessionInfo[] }>("/api/sessions")
      .then((d) => setSessions(d.sessions ?? []))
      .catch(() => {})

  useEffect(() => {
    getJson<WorkspaceInfo>("/api/workspace").then(setWorkspace).catch(() => {})
    void fetchSessions()
  }, [])

  const sessionTitle = sessions.find((s) => s.id === session.id)?.title ?? "New chat"

  function newChat() {
    setSession({ id: crypto.randomUUID(), fresh: true })
    setScreen("chat")
  }

  return (
    <div className="flex h-full min-h-0 bg-paper text-ink">
      {/* sidebar */}
      <aside className="flex w-[var(--w-sidebar)] flex-none flex-col border-r border-linec bg-surface">
        <div className="flex items-center gap-2 px-4 py-3.5">
          <img src="/logo.png" alt="abstract" className="h-[19px] w-auto select-none" />
          <span
            className="ml-auto truncate font-mono text-[10px] text-muted"
            title={workspace?.root}
          >
            {workspace?.name}
          </span>
        </div>

        <div className="px-3">
          <button className="op-newchat" onClick={newChat}>
            + New chat
          </button>
        </div>

        <span className="steplabel block px-4 pb-1 pt-4 font-bold">sessions</span>
        <div className="min-h-0 flex-1 overflow-y-auto px-3">
          {sessions.length === 0 && (
            <p className="px-1 py-2 text-xs text-muted">No conversations yet.</p>
          )}
          {sessions.map((s) => (
            <div
              key={s.id}
              className={
                "rowbtn group flex cursor-pointer items-center gap-1" +
                (session.id === s.id && screen === "chat" ? " active" : "")
              }
              onClick={() => {
                setSession({ id: s.id, fresh: false })
                setScreen("chat")
              }}
              title={s.title ?? s.id}
            >
              <span className="min-w-0 flex-1 truncate">{s.title ?? s.id.slice(0, 8)}</span>
              <button
                title="delete conversation"
                className="hidden flex-none px-0.5 text-muted hover:text-bad group-hover:block"
                onClick={(e) => {
                  e.stopPropagation()
                  if (!window.confirm("Delete this conversation? This cannot be undone.")) return
                  void send(`/api/sessions/${s.id}`, "DELETE").then(() => {
                    if (session.id === s.id) newChat()
                    void fetchSessions()
                  })
                }}
              >
                <Icon name="trash" />
              </button>
            </div>
          ))}
        </div>

        <div className="border-t border-linec p-3">
          {NAV.map((n) => (
            <button
              key={n.target}
              className={"bracketlink" + (screen === n.target ? " active" : "")}
              onClick={() => setScreen(n.target)}
            >
              [ {n.label} ]
            </button>
          ))}
        </div>
      </aside>

      {/* main area */}
      {screen === "chat" && (
        <Chat session={session} title={sessionTitle} onIdle={() => void fetchSessions()} />
      )}
      {screen === "memory" && <Memory />}
      {screen === "skills" && <Skills />}
      {screen === "settings" && <Settings />}
      {screen === "workspaces" && (
        <Workspaces
          onOpened={(w) => {
            setWorkspace(w)
            newChat()
            void fetchSessions()
          }}
        />
      )}
    </div>
  )
}

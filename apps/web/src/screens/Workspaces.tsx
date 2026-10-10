import { useEffect, useState } from "react"
import { getJson, send, type WorkspaceInfo } from "../api"
import { Icon } from "../ui"

/** In-shell workspace manager: switch, open by path, create, or delete one. */
export default function Workspaces({ onOpened }: { onOpened: (w: WorkspaceInfo) => void }) {
  const [current, setCurrent] = useState<WorkspaceInfo | null>(null)
  const [recent, setRecent] = useState<WorkspaceInfo[]>([])
  const [path, setPath] = useState("")
  const [name, setName] = useState("")
  const [error, setError] = useState<string | null>(null)

  const refresh = () =>
    getJson<{ current: WorkspaceInfo; recent: WorkspaceInfo[] }>("/api/workspaces")
      .then((d) => {
        setCurrent(d.current)
        setRecent(d.recent)
      })
      .catch(() => {})

  useEffect(() => {
    void refresh()
  }, [])

  async function deleteWorkspace(w: WorkspaceInfo) {
    if (
      !window.confirm(
        `Delete the workspace "${w.name}" and EVERYTHING in it?\n\n${w.root}\n\nAll sources, drafts, references, notes, memory, and conversations inside are permanently removed. This cannot be undone.`,
      )
    )
      return
    setError(null)
    const d = await (await send("/api/workspaces/delete", "POST", { path: w.root })).json()
    if (d.error) setError(d.error)
    await refresh()
  }

  async function call(url: string, body: unknown) {
    setError(null)
    const d = await (await send(url, "POST", body)).json()
    if (d.error) setError(d.error)
    else onOpened(d)
  }

  const rows = [
    ...(current ? [{ ...current, tag: "current" }] : []),
    ...recent.filter((r) => r.root !== current?.root).map((r) => ({ ...r, tag: "" })),
  ]

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-paper">
      <div className="mx-auto max-w-[var(--container-chat)] px-6 py-10">
        <h1 className="font-serif text-2xl font-semibold">Workspaces</h1>
        <p className="mt-1 text-sm text-muted">
          A workspace is a folder you own — sources, drafts, and the library live inside it.
        </p>

        <span className="steplabel mb-2 mt-8 block font-bold">create a new workspace</span>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (name.trim()) void call("/api/workspaces/create", { name: name.trim() })
          }}
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. thesis, ictai-2026"
            className="min-w-0 flex-1 border border-linec bg-surface px-4 py-2.5 text-sm outline-none focus:border-accent"
          />
          <button className="bg-ink px-5 py-2.5 text-sm font-medium text-paper">Create</button>
        </form>
        <p className="mt-1.5 text-[11.5px] text-muted">
          Starts empty in <code className="font-mono">~/Abstract/</code> — add sources anytime.
        </p>

        <span className="steplabel mb-2 mt-8 block font-bold">open</span>
        <div className="grid gap-1.5">
          {rows.map((r) => (
            <div
              key={r.root}
              className="wsrow group cursor-pointer"
              onClick={() =>
                r.tag === "current" ? onOpened(r) : void call("/api/workspaces/open", { path: r.root })
              }
            >
              <span className="font-medium">{r.name}</span>
              <span className="min-w-0 flex-1 truncate text-right font-mono text-[10.5px] text-faint">
                {r.root}
              </span>
              {r.tag ? (
                <span className="font-mono text-[10px] uppercase text-ok">{r.tag}</span>
              ) : (
                <button
                  title="delete workspace and everything in it"
                  className="invisible flex-none px-1 text-muted hover:text-bad group-hover:visible"
                  onClick={(e) => {
                    e.stopPropagation()
                    void deleteWorkspace(r)
                  }}
                >
                  <Icon name="trash" />
                </button>
              )}
            </div>
          ))}
        </div>
        <form
          className="mt-2 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (path.trim()) void call("/api/workspaces/open", { path: path.trim() })
          }}
        >
          <input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="…or type a path: ~/papers"
            className="min-w-0 flex-1 border border-linec bg-surface px-4 py-2.5 text-sm outline-none focus:border-accent"
          />
          <button className="border border-linec bg-surface px-4 py-2.5 text-sm hover:border-accent">
            Open
          </button>
        </form>
        {error && <p className="mt-3 text-sm text-bad">{error}</p>}

        <p className="steplabel mt-10 !tracking-[0.18em]">
          local-first · your files are stored on this machine
        </p>
      </div>
    </div>
  )
}

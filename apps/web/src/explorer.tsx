import { useEffect, useState } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { getJson, send } from "./api"
import { GradeChip, Icon, Md } from "./ui"

export interface TreeNode {
  name: string
  path: string
  kind: "folder" | "file"
  status?: string
  grade?: string | null
  children?: TreeNode[]
}

async function doMove(from: string, toFolder: string, refresh: () => void) {
  const r = await send("/api/files/move", "POST", { from, to: toFolder })
  const d = await r.json()
  if (d.error) window.alert(d.error)
  refresh()
}

async function doDelete(node: TreeNode, refresh: () => void) {
  const what =
    node.kind === "folder"
      ? `the folder "${node.name}" and EVERYTHING in it`
      : `"${node.name}"`
  if (!window.confirm(`Delete ${what}? This cannot be undone.`)) return
  const r = await send("/api/files/delete", "POST", { path: node.path })
  const d = await r.json()
  if (d.error) window.alert(d.error)
  refresh()
}

function iconFor(n: TreeNode): string {
  if (n.kind === "folder") return "folder"
  if (n.path.endsWith(".pdf")) return "file"
  return "filetext"
}

/** folder open/closed choices survive refreshes */
const FOLDERS_KEY = "abstract.folders"
function loadFolderState(): Record<string, boolean> {
  try {
    // fallback: folder state saved before the rename lives under the old key
    return JSON.parse(localStorage.getItem(FOLDERS_KEY) ?? "{}")
  } catch {
    return {}
  }
}
function saveFolderState(path: string, open: boolean) {
  const m = loadFolderState()
  m[path] = open
  localStorage.setItem(FOLDERS_KEY, JSON.stringify(m))
}

/** open a print window with the rendered markdown → user saves as PDF */
async function printAsPdf(path: string) {
  const text = await fetch(`/api/file?path=${encodeURIComponent(path)}`).then((r) => r.text())
  const html = renderToStaticMarkup(<Md text={text} />)
  const w = window.open("", "_blank")
  if (!w) return
  w.document.write(`<!doctype html><html><head><title>${path.split("/").pop()}</title><style>
    body { font-family: Charter, Georgia, serif; color: #26282b; max-width: 700px; margin: 48px auto; line-height: 1.7; font-size: 13pt; }
    h1,h2,h3,h4 { font-weight: 600; } code, pre { font-family: Menlo, monospace; font-size: 10pt; }
    table { border-collapse: collapse; } th, td { border: 1px solid #ccc; padding: 4px 8px; }
    @media print { body { margin: 0 auto; } }
  </style></head><body>${html}</body></html>`)
  w.document.close()
  setTimeout(() => w.print(), 300)
}

function Row({
  node,
  depth,
  refresh,
  onOpen,
}: {
  node: TreeNode
  depth: number
  refresh: () => void
  onOpen: (path: string) => void
}) {
  const [open, setOpen] = useState(
    () =>
      loadFolderState()[node.path] ??
      (depth === 0 && (node.name === "drafts" || node.name === "sources")),
  )
  const [dropping, setDropping] = useState(false)
  const pad = { paddingLeft: `${depth * 14 + 8}px` }
  const toggle = () =>
    setOpen((o) => {
      saveFolderState(node.path, !o)
      return !o
    })

  if (node.kind === "folder") {
    return (
      <div
        onDragOver={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setDropping(true)
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setDropping(false)
          const from = e.dataTransfer.getData("text/abstract-path")
          if (from) void doMove(from, node.path, refresh)
        }}
        className={dropping ? "bg-accentsoft" : undefined}
      >
        <div
          onClick={toggle}
          style={pad}
          className="group flex w-full cursor-pointer items-center gap-1.5 py-1 text-left text-[12.5px] hover:bg-paper"
        >
          <span className="w-3 text-center font-mono text-[9px] text-muted">{open ? "▾" : "▸"}</span>
          <span className="text-muted">
            <Icon name="folder" />
          </span>
          <span className="truncate font-medium">{node.name}</span>
          <span className="ml-auto font-mono text-[10px] text-faint">
            {node.children?.length ?? 0}
          </span>
          {!node.path.startsWith(".openpaper") && (
            <button
              title="delete folder and contents"
              className="invisible flex-none px-1 pr-2 text-muted hover:text-bad group-hover:visible"
              onClick={(e) => {
                e.stopPropagation()
                void doDelete(node, refresh)
              }}
            >
              <Icon name="trash" />
            </button>
          )}
        </div>
        {open &&
          node.children?.map((ch) => (
            <Row key={ch.path} node={ch} depth={depth + 1} refresh={refresh} onOpen={onOpen} />
          ))}
      </div>
    )
  }

  const inNotes = node.path.startsWith(".openpaper")
  return (
    <div
      style={pad}
      draggable={!inNotes}
      onDragStart={(e) => e.dataTransfer.setData("text/abstract-path", node.path)}
      onClick={() => onOpen(node.path)}
      title="click to preview"
      className="group flex cursor-pointer items-start gap-1.5 py-1 pr-2 hover:bg-paper"
    >
      <span className="w-3" />
      <span className="mt-0.5 flex-none text-ink">
        <Icon name={iconFor(node)} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px]" title={node.path}>
          {node.name}
        </div>
        {node.status === "ingested" && (
          <div className="mt-0.5 flex items-center gap-1.5">
            <span className="font-mono text-[9.5px] uppercase text-ok">ingested</span>
            <GradeChip grade={node.grade ?? null} />
          </div>
        )}
      </div>
      <span
        className="hidden flex-none items-center gap-1 group-hover:flex"
        onClick={(e) => e.stopPropagation()}
      >
        <a
          href={`/api/file?path=${encodeURIComponent(node.path)}&download=1`}
          title="download"
          className="px-1 text-muted hover:text-ink"
        >
          ↓
        </a>
        {node.path.endsWith(".md") && (
          <button
            onClick={() => void printAsPdf(node.path)}
            title="save as PDF"
            className="px-1 font-mono text-[10px] text-muted hover:text-ink"
          >
            PDF
          </button>
        )}
        {!inNotes && (
          <button
            onClick={() => void doDelete(node, refresh)}
            title="delete file"
            className="px-1 text-muted hover:text-bad"
          >
            <Icon name="trash" />
          </button>
        )}
      </span>
    </div>
  )
}

interface Funnel {
  identified: number
  screened: number
  included: number
  excluded: number
  fetched: number
}

export function Explorer({ onAdd, onOpenFile }: { onAdd: () => void; onOpenFile: (path: string) => void }) {
  const [tree, setTree] = useState<TreeNode[]>([])
  const [funnel, setFunnel] = useState<Funnel | null>(null)

  const refresh = () =>
    Promise.all([
      getJson<{ tree: TreeNode[] }>("/api/tree").then((d) => setTree(d.tree ?? [])),
      getJson<{ funnel: Funnel | null }>("/api/ledger").then((d) => setFunnel(d.funnel ?? null)),
    ]).catch(() => {})

  useEffect(() => {
    void refresh()
    const iv = setInterval(refresh, 5000)
    return () => clearInterval(iv)
  }, [])

  async function newFolder() {
    const name = window.prompt("New folder name:")
    if (!name?.trim()) return
    await send("/api/files/mkdir", "POST", { path: name.trim() })
    void refresh()
  }

  return (
    <aside className="hidden w-[var(--w-files-panel)] flex-none flex-col border-l border-linec bg-surface lg:flex">
      <div className="flex items-center justify-between border-b border-linec px-4 py-2.5">
        <span className="steplabel font-bold">files</span>
        <span className="flex gap-1">
          <button
            onClick={() => void newFolder()}
            title="new folder"
            className="border border-linec px-1.5 py-0.5 text-xs hover:border-accent"
          >
            <Icon name="folder" className="inline" />+
          </button>
          <button onClick={onAdd} className="border border-linec px-2 py-0.5 text-xs hover:border-accent">
            + Add
          </button>
        </span>
      </div>
      {funnel && funnel.identified > 0 && (
        <div className="border-b border-linec px-4 py-2.5">
          <div className="steplabel mb-1.5">screening</div>
          <div className="flex h-1.5 w-full overflow-hidden bg-paper">
            <span
              className="bg-ok"
              style={{ width: `${(100 * funnel.included) / funnel.identified}%` }}
              title={`${funnel.included} included`}
            />
            <span
              className="bg-linec"
              style={{ width: `${(100 * funnel.excluded) / funnel.identified}%` }}
              title={`${funnel.excluded} excluded`}
            />
          </div>
          <div className="mt-1.5 font-mono text-[10px] text-muted">
            {funnel.identified} identified · {funnel.screened} screened · {funnel.included} included
          </div>
        </div>
      )}
      <div
        className="min-h-0 flex-1 overflow-y-auto py-1"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault()
          const from = e.dataTransfer.getData("text/abstract-path")
          if (from) void doMove(from, from.split("/").pop() ?? from, () => void refresh())
        }}
      >
        {tree.length === 0 && (
          <p className="px-3 py-2 text-xs text-muted">
            Empty workspace. Add PDFs or notes, or ask the agent to fetch papers.
          </p>
        )}
        {tree.map((n) => (
          <Row key={n.path} node={n} depth={0} refresh={() => void refresh()} onOpen={onOpenFile} />
        ))}
      </div>
    </aside>
  )
}

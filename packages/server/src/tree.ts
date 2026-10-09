import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import type { Database, Workspace } from "@abstract/core"

export interface TreeNode {
  name: string
  path: string
  kind: "folder" | "file"
  size?: number
  status?: string
  grade?: string | null
  children?: TreeNode[]
}

const IGNORED = new Set([".openpaper", ".git", "node_modules", "__pycache__", ".DS_Store"])

function walkDir(abs: string, rel: string, depth: number): TreeNode[] {
  if (depth > 6) return []
  const out: TreeNode[] = []
  const entries = readdirSync(abs).sort()
  // inside drafts/, the ONLY user-facing artifact is the markdown. The verdict
  // .json, the export .bib/.tex, and the .audit.json all still exist on disk
  // (the agent and export use them) but are hidden from the file panel so one
  // document reads as one file.
  const inDrafts = rel === "drafts" || rel.startsWith("drafts/")
  for (const entry of entries) {
    if (entry.startsWith(".") || IGNORED.has(entry)) continue
    if (inDrafts && !entry.endsWith(".md") && !entry.endsWith(".markdown")) continue
    const full = join(abs, entry)
    const relPath = rel ? `${rel}/${entry}` : entry
    const st = statSync(full)
    if (st.isDirectory()) {
      out.push({ name: entry, path: relPath, kind: "folder", children: walkDir(full, relPath, depth + 1) })
    } else {
      out.push({ name: entry, path: relPath, kind: "file", size: st.size })
    }
  }
  // folders first, then files
  return out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "folder" ? -1 : 1))
}

export function buildTree(workspace: Workspace, db: Database): TreeNode[] {
  const nodes = walkDir(workspace.root, "", 0)

  // decorate files with ingest status/grade
  const meta = new Map(
    (db.query("SELECT path, status, grade, title FROM sources").all() as {
      path: string; status: string; grade: string; title: string | null
    }[]).map((r) => [r.path, r]),
  )
  const decorate = (list: TreeNode[]) => {
    for (const n of list) {
      if (n.kind === "file") {
        const m = meta.get(n.path)
        if (m) {
          n.status = m.status
          n.grade = m.grade
        }
      } else if (n.children) decorate(n.children)
    }
  }
  decorate(nodes)

  // virtual notes folder (real files under .openpaper/notes, friendly names)
  const notesDir = join(workspace.dataDir, "notes")
  if (existsSync(notesDir)) {
    const notes = readdirSync(notesDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => ({
        name: f.replace(/__/g, "/").replace(/\.md$/, "").split("/").pop() + ".note.md",
        path: `.openpaper/notes/${f}`,
        kind: "file" as const,
      }))
    if (notes.length > 0) nodes.push({ name: "notes", path: ".openpaper/notes", kind: "folder", children: notes })
  }
  return nodes
}

function safeRel(workspace: Workspace, rel: string): string {
  const full = join(workspace.root, rel)
  if (full !== workspace.root && !full.startsWith(workspace.root + "/"))
    throw new Error("path escapes workspace")
  return full
}

export function makeFolder(workspace: Workspace, rel: string): { ok: true } {
  if (rel.startsWith(".openpaper")) throw new Error("cannot create folders in .openpaper")
  mkdirSync(safeRel(workspace, rel), { recursive: true })
  return { ok: true }
}

/** move/rename a file; keeps the library (sources.path) and its note in sync */
export function moveFile(
  workspace: Workspace,
  db: Database,
  from: string,
  to: string,
): { ok: true; to: string } {
  if (from.startsWith(".openpaper") || to.startsWith(".openpaper"))
    throw new Error("cannot move files in .openpaper")
  const src = safeRel(workspace, from)
  if (!existsSync(src)) throw new Error(`not found: ${from}`)
  let dest = to
  // moving onto a folder → keep the basename
  const destAbs0 = safeRel(workspace, to)
  if (existsSync(destAbs0) && statSync(destAbs0).isDirectory()) dest = `${to}/${basename(from)}`
  const destAbs = safeRel(workspace, dest)
  if (existsSync(destAbs)) throw new Error(`already exists: ${dest}`)
  mkdirSync(dirname(destAbs), { recursive: true })
  renameSync(src, destAbs)
  db.query("UPDATE sources SET path = ? WHERE path = ?").run(dest, from)
  // keep the reading note attached
  const noteFrom = join(workspace.dataDir, "notes", from.replace(/[\\/]/g, "__") + ".md")
  const noteTo = join(workspace.dataDir, "notes", dest.replace(/[\\/]/g, "__") + ".md")
  if (existsSync(noteFrom)) renameSync(noteFrom, noteTo)
  return { ok: true, to: dest }
}

/** delete a file, or a folder with everything in it; scrubs library rows too */
export function deletePath(
  workspace: Workspace,
  db: Database,
  rel: string,
): { ok: true; removedSources: number } {
  if (!rel.trim() || rel === "." || rel === "/") throw new Error("refusing to delete the workspace root")
  if (rel.startsWith(".openpaper")) throw new Error("cannot delete files in .openpaper")
  const full = safeRel(workspace, rel)
  if (full === workspace.root) throw new Error("refusing to delete the workspace root")
  if (!existsSync(full)) throw new Error(`not found: ${rel}`)
  const isDir = statSync(full).isDirectory()

  // scrub the library first: sources at this path (or under this folder),
  // their chunks (cascade), vectors, and verdicts
  const rows = (
    isDir
      ? db.query("SELECT id FROM sources WHERE path = ? OR path LIKE ?").all(rel, `${rel}/%`)
      : db.query("SELECT id FROM sources WHERE path = ?").all(rel)
  ) as { id: string }[]
  const tx = db.transaction(() => {
    for (const s of rows) {
      const chunkIds = (
        db.query("SELECT id FROM chunks WHERE source_id = ?").all(s.id) as { id: string }[]
      ).map((c) => c.id)
      for (const cid of chunkIds) {
        db.query("DELETE FROM verdicts WHERE chunk_id = ?").run(cid)
        db.query("DELETE FROM chunk_vecs WHERE chunk_id = ?").run(cid)
      }
      db.query("DELETE FROM sources WHERE id = ?").run(s.id)
    }
  })
  tx()

  rmSync(full, { recursive: true, force: true })
  // detach reading notes for deleted sources
  const notePath = (p: string) => join(workspace.dataDir, "notes", p.replace(/[\\/]/g, "__") + ".md")
  if (!isDir && existsSync(notePath(rel))) rmSync(notePath(rel), { force: true })
  return { ok: true, removedSources: rows.length }
}

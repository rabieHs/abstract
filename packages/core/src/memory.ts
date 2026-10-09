import type { Database } from "./db.ts"

/**
 * Long-term memory. Rules from CONCEPT.md:
 * - nothing is learned silently: notes written by the agent start unapproved
 *   (approved = 0) and only count after the user approves them in the panel;
 * - notes the user writes/approves are injected into every generation call.
 */

export type MemoryKind = "style" | "preference" | "project" | "lesson"

export interface MemoryNote {
  id: string
  kind: MemoryKind
  content: string
  approved: boolean
  created_at: number
}

export function addNote(
  db: Database,
  kind: MemoryKind,
  content: string,
  approved: boolean,
): MemoryNote {
  const note: MemoryNote = {
    id: crypto.randomUUID(),
    kind,
    content: content.trim(),
    approved,
    created_at: Date.now(),
  }
  db.query(
    "INSERT INTO memory_notes (id, kind, content, approved, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(note.id, note.kind, note.content, note.approved ? 1 : 0, note.created_at)
  return note
}

export function listNotes(db: Database): MemoryNote[] {
  return (
    db.query("SELECT * FROM memory_notes ORDER BY created_at DESC").all() as {
      id: string; kind: MemoryKind; content: string; approved: number; created_at: number
    }[]
  ).map((r) => ({ ...r, approved: r.approved === 1 }))
}

export function setApproved(db: Database, id: string, approved: boolean): void {
  db.query("UPDATE memory_notes SET approved = ? WHERE id = ?").run(approved ? 1 : 0, id)
}

export function deleteNote(db: Database, id: string): void {
  db.query("DELETE FROM memory_notes WHERE id = ?").run(id)
}

/** cap on the rendered recall block — memory must never quietly eat the
 *  system prompt (or, once cached, thrash the prompt-cache prefix) */
export const RECALL_BUDGET_CHARS = 4_000

/**
 * Approved notes formatted for the system prompt; empty string when none.
 * Each note carries its save month so the model can weigh staleness; when
 * the store outgrows the budget, the NEWEST notes win and the omission is
 * stated — never silently truncated (the error-not-truncate discipline).
 */
export function recallForPrompt(db: Database): string {
  const notes = listNotes(db).filter((n) => n.approved) // newest first
  if (notes.length === 0) return ""
  const render = (n: MemoryNote) => `- [${new Date(n.created_at).toISOString().slice(0, 7)}] ${n.content}`
  const kept: MemoryNote[] = []
  let used = 0
  let omitted = 0
  for (const n of notes) {
    const line = render(n)
    if (kept.length > 0 && used + line.length > RECALL_BUDGET_CHARS) {
      omitted++
      continue
    }
    kept.push(n)
    used += line.length
  }
  const byKind = new Map<string, string[]>()
  for (const n of kept) {
    if (!byKind.has(n.kind)) byKind.set(n.kind, [])
    byKind.get(n.kind)!.push(render(n))
  }
  const sections = [...byKind.entries()]
    .map(([kind, items]) => `${kind}:\n${items.join("\n")}`)
    .join("\n")
  return (
    `\n# Memory (user-approved)\nApply these standing notes (each stamped with its save ` +
    `month — on conflict, newer wins):\n${sections}` +
    (omitted > 0
      ? `\n(${omitted} older note(s) over the memory budget were OMITTED from recall — ` +
        "consolidate or retire notes in the Memory panel)"
      : "")
  )
}

/** over-budget signal for the remember tool — the store needs consolidation,
 *  not another note; returns null while within budget */
export function memoryPressure(db: Database): string | null {
  const approved = listNotes(db).filter((n) => n.approved)
  const size = approved.reduce((a, n) => a + n.content.length + 12, 0)
  if (size <= RECALL_BUDGET_CHARS) return null
  return (
    `memory holds ~${size} chars of approved notes against a ${RECALL_BUDGET_CHARS}-char ` +
    "recall budget — older notes are already being omitted. Consolidate overlapping notes " +
    "(merge, shorten, retire) rather than adding more."
  )
}

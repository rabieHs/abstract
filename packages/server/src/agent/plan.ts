import type { Database } from "@abstract/core"

/**
 * The agent's working plan — a per-session task list for MULTI-STEP work.
 * Semantics: the tool replaces the whole list each call; the
 * current list rides the system prompt so the agent re-reads its own state
 * every step instead of re-deriving it from a long transcript (and it
 * survives context compaction, which slims old tool outputs away).
 *
 * v2 adds STRUCTURE (the P1.3 fix for "writes before reading"): tasks have
 * stable ids and can declare `blocked_by` dependencies, so "draft the
 * chapter" is visibly NOT STARTABLE until its reading tasks are done. The
 * echo and the system-prompt render both state the blockage — a signal the
 * model sees at every step, not a hard wall (integrity gates stay in code).
 *
 * Plans are working state, not ceremony: simple questions never get one.
 */

export type TodoStatus = "pending" | "in_progress" | "done"

export interface Todo {
  content: string
  status: TodoStatus
  /** stable id (t1, t2, …) — auto-assigned by position when omitted */
  id?: string
  /** ids of tasks that must be DONE before this one can start */
  blocked_by?: string[]
  /** optional task kind (search/screen/read/synthesize/draft/verify/…) */
  kind?: string
}

/** assign missing ids by position and drop dangling/self dependencies */
export function normalizePlan(todos: Todo[]): Todo[] {
  const withIds = todos.map((t, i) => ({ ...t, id: t.id?.trim() || `t${i + 1}` }))
  const known = new Set(withIds.map((t) => t.id!))
  return withIds.map((t) => {
    const deps = [...new Set(t.blocked_by ?? [])].filter((d) => known.has(d) && d !== t.id)
    const out: Todo = { ...t }
    if (deps.length) out.blocked_by = deps
    else delete out.blocked_by
    return out
  })
}

/** ids of this task's blockers that are not yet done */
function unmetDeps(todos: Todo[], t: Todo): string[] {
  const byId = new Map(todos.map((x) => [x.id, x]))
  return (t.blocked_by ?? []).filter((d) => byId.get(d)?.status !== "done")
}

/** open tasks that cannot start yet, with what blocks them */
export function blockedTasks(todos: Todo[]): { todo: Todo; unmet: string[] }[] {
  return todos
    .filter((t) => t.status !== "done")
    .map((t) => ({ todo: t, unmet: unmetDeps(todos, t) }))
    .filter((x) => x.unmet.length > 0)
}

/** pending tasks whose blockers are all done — what can start right now */
export function startableTasks(todos: Todo[]): Todo[] {
  return todos.filter((t) => t.status === "pending" && unmetDeps(todos, t).length === 0)
}

/**
 * UNFINISHED tasks the new list silently removed (observed live: a budget-
 * pressured agent deleted its own "deep-read and extract" task and drafted
 * from one read paper). Work does not disappear by deleting its task — a
 * drop must be visible, symmetric with the drafts' sections_dropped signal.
 * A cleared plan ([] = task complete) is exempt.
 */
export function droppedTasks(previous: Todo[], next: Todo[]): Todo[] {
  if (next.length === 0) return []
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
  const kept = new Set(next.map((t) => norm(t.content)))
  return previous.filter((t) => t.status !== "done" && !kept.has(norm(t.content)))
}

export function getPlan(db: Database, session: string): Todo[] {
  const row = db.query("SELECT todos FROM plans WHERE session_id = ?").get(session) as
    | { todos: string }
    | null
  if (!row) return []
  try {
    const parsed = JSON.parse(row.todos) as Todo[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function setPlan(db: Database, session: string, todos: Todo[]): void {
  if (todos.length === 0) {
    db.query("DELETE FROM plans WHERE session_id = ?").run(session)
    return
  }
  db.query(
    "INSERT OR REPLACE INTO plans (session_id, todos, updated_at) VALUES (?, ?, ?)",
  ).run(session, JSON.stringify(normalizePlan(todos)), Date.now())
}

const MARK: Record<TodoStatus, string> = { done: "[x]", in_progress: "[>]", pending: "[ ]" }

/** one line per task: status mark, id, kind, content, and live blockage */
export function renderPlanLines(todos: Todo[]): string {
  return todos
    .map((t) => {
      const unmet = unmetDeps(todos, t)
      const blocked = t.status !== "done" && unmet.length > 0 ? ` ⛔ blocked by ${unmet.join(", ")}` : ""
      const kind = t.kind ? ` (${t.kind})` : ""
      return `${MARK[t.status] ?? "[ ]"} ${t.id ?? "?"}${kind} ${t.content}${blocked}`
    })
    .join("\n")
}

/** system-prompt block with the live plan (empty string when no plan exists) */
export function planPrompt(db: Database, session: string): string {
  const todos = getPlan(db, session)
  if (todos.length === 0) return ""
  const blocked = blockedTasks(todos)
  return (
    "\n\n# Your current plan (update_plan)\n" +
    "This is YOUR working plan for the ongoing task. Before acting, check what is done " +
    "and what comes next — never redo a done item. Keep it current: mark items done as " +
    "you finish them, add discovered work, and send an empty list once everything is " +
    "complete.\n" +
    renderPlanLines(todos) +
    (blocked.length > 0
      ? "\n⛔ A blocked task cannot honestly start until its blockers are DONE — a draft " +
        "task blocked by reading tasks means: read first, then draft."
      : "")
  )
}

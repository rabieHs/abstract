import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDb } from "@abstract/core"
import { getPlan, planPrompt, setPlan } from "./plan.ts"

function tempDb() {
  return openDb(join(mkdtempSync(join(tmpdir(), "op-plan-")), "t.db"))
}

describe("plans", () => {
  test("set → get roundtrip, whole-list replacement", () => {
    const db = tempDb()
    setPlan(db, "s1", [
      { content: "read paper A", status: "done" },
      { content: "read paper B", status: "in_progress" },
      { content: "draft comparison", status: "pending" },
    ])
    expect(getPlan(db, "s1")).toHaveLength(3)
    setPlan(db, "s1", [{ content: "draft comparison", status: "in_progress" }])
    expect(getPlan(db, "s1")).toHaveLength(1) // replaced, not appended
  })

  test("empty list clears the plan", () => {
    const db = tempDb()
    setPlan(db, "s1", [{ content: "x", status: "pending" }])
    setPlan(db, "s1", [])
    expect(getPlan(db, "s1")).toHaveLength(0)
    expect(planPrompt(db, "s1")).toBe("")
  })

  test("plans are per-session", () => {
    const db = tempDb()
    setPlan(db, "a", [{ content: "task a", status: "pending" }])
    expect(getPlan(db, "b")).toHaveLength(0)
    expect(planPrompt(db, "b")).toBe("")
  })

  test("prompt shows statuses, ids, and the never-redo instruction", () => {
    const db = tempDb()
    setPlan(db, "s1", [
      { content: "read paper A", status: "done" },
      { content: "draft summary", status: "in_progress" },
    ])
    const p = planPrompt(db, "s1")
    expect(p).toContain("[x] t1 read paper A")
    expect(p).toContain("[>] t2 draft summary")
    expect(p).toContain("never redo a done item")
  })

  test("no plan → zero prompt overhead", () => {
    const db = tempDb()
    expect(planPrompt(db, "fresh")).toBe("")
  })
})

import { blockedTasks, normalizePlan, renderPlanLines, startableTasks } from "./plan.ts"

describe("plan v2 — dependencies (the writes-before-reading fix)", () => {
  const plan = normalizePlan([
    { content: "search the topic", status: "done" },
    { content: "deep-read the core papers", status: "in_progress", kind: "read" },
    { content: "screen remaining candidates", status: "pending", kind: "screen" },
    { content: "draft the chapter", status: "pending", kind: "draft", blocked_by: ["t2", "t3"] },
  ])

  test("ids are auto-assigned by position", () => {
    expect(plan.map((t) => t.id)).toEqual(["t1", "t2", "t3", "t4"])
  })

  test("a draft task blocked by reading tasks is NOT startable", () => {
    expect(startableTasks(plan).map((t) => t.id)).toEqual(["t3"])
    const blocked = blockedTasks(plan)
    expect(blocked).toHaveLength(1)
    expect(blocked[0]!.todo.id).toBe("t4")
    expect(blocked[0]!.unmet).toEqual(["t2", "t3"])
  })

  test("finishing the blockers unblocks the draft", () => {
    const later = plan.map((t) => (t.id === "t2" || t.id === "t3" ? { ...t, status: "done" as const } : t))
    expect(blockedTasks(later)).toHaveLength(0)
    expect(startableTasks(later).map((t) => t.id)).toEqual(["t4"])
  })

  test("render marks the blockage in-line where the model reads its state", () => {
    const lines = renderPlanLines(plan)
    expect(lines).toContain("[ ] t4 (draft) draft the chapter ⛔ blocked by t2, t3")
    expect(lines).toContain("[>] t2 (read) deep-read the core papers")
  })

  test("dangling and self dependencies are dropped, duplicates deduped", () => {
    const p = normalizePlan([
      { content: "a", status: "pending", blocked_by: ["t1", "t9", "t2", "t2"] },
      { content: "b", status: "pending" },
    ])
    expect(p[0]!.blocked_by).toEqual(["t2"])
  })

  test("a normalized plan survives the setPlan → getPlan roundtrip with deps", () => {
    const db = tempDb()
    setPlan(db, "s2", [
      { content: "read", status: "pending" },
      { content: "draft", status: "pending", blocked_by: ["t1"] },
    ])
    const back = getPlan(db, "s2")
    expect(back[1]!.blocked_by).toEqual(["t1"])
    expect(back[1]!.id).toBe("t2")
  })
})

import { droppedTasks } from "./plan.ts"

describe("droppedTasks — silent commitment-shedding is visible (the skipped-reading fix)", () => {
  const prev = normalizePlan([
    { content: "Search literature", status: "done" },
    { content: "Deep-read papers and extract into matrix", status: "pending" },
    { content: "Draft review", status: "pending" },
  ])
  test("an unfinished task missing from the new list is reported", () => {
    const next = normalizePlan([
      { content: "Search literature", status: "done" },
      { content: "Draft review", status: "in_progress" },
    ])
    const d = droppedTasks(prev, next)
    expect(d).toHaveLength(1)
    expect(d[0]!.content).toContain("Deep-read")
  })
  test("done tasks may vanish freely; a cleared plan ([]) is completion, not a drop", () => {
    expect(droppedTasks(prev, normalizePlan([{ content: "Deep-read papers and extract into matrix", status: "pending" }, { content: "Draft review", status: "pending" }]))).toHaveLength(0)
    expect(droppedTasks(prev, [])).toHaveLength(0)
  })
})

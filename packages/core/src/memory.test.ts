import { describe, expect, test } from "bun:test"
import { openDb } from "./db.ts"
import { addNote, deleteNote, listNotes, recallForPrompt, setApproved } from "./memory.ts"

describe("memory", () => {
  const db = openDb(":memory:")

  test("agent-proposed notes start unapproved and are NOT injected", () => {
    addNote(db, "style", "Prefer short sentences.", false)
    expect(listNotes(db)).toHaveLength(1)
    expect(listNotes(db)[0]!.approved).toBe(false)
    expect(recallForPrompt(db)).toBe("")
  })

  test("approval activates injection, grouped by kind", () => {
    const n = listNotes(db)[0]!
    setApproved(db, n.id, true)
    addNote(db, "preference", "Use IEEE citation style.", true)
    const prompt = recallForPrompt(db)
    expect(prompt).toContain("Memory (user-approved)")
    // notes carry their save month for staleness reasoning
    expect(prompt).toMatch(/style:\n- \[\d{4}-\d{2}\] Prefer short sentences\./)
    expect(prompt).toMatch(/preference:\n- \[\d{4}-\d{2}\] Use IEEE citation style\./)
  })

  test("unapprove removes from injection; delete removes entirely", () => {
    const styleNote = listNotes(db).find((n) => n.kind === "style")!
    setApproved(db, styleNote.id, false)
    expect(recallForPrompt(db)).not.toContain("short sentences")
    deleteNote(db, styleNote.id)
    expect(listNotes(db)).toHaveLength(1)
  })
})

import { memoryPressure, RECALL_BUDGET_CHARS } from "./memory.ts"

describe("memory budget (C12 — error-not-truncate)", () => {
  test("over-budget recall keeps the newest notes and STATES the omission", () => {
    const db2 = openDb(":memory:")
    for (let i = 0; i < 40; i++) {
      addNote(db2, "project", `standing note number ${i} ` + "x".repeat(180), true)
    }
    const prompt = recallForPrompt(db2)
    expect(prompt.length).toBeLessThan(RECALL_BUDGET_CHARS + 600)
    expect(prompt).toContain("OMITTED from recall")
    // some notes made it in, some were dropped — never all of either
    const rendered = (prompt.match(/standing note number/g) ?? []).length
    expect(rendered).toBeGreaterThan(0)
    expect(rendered).toBeLessThan(40)
  })
  test("memoryPressure is null within budget, a consolidation nudge beyond it", () => {
    const db3 = openDb(":memory:")
    addNote(db3, "style", "short note", true)
    expect(memoryPressure(db3)).toBeNull()
    for (let i = 0; i < 40; i++) addNote(db3, "project", "y".repeat(200), true)
    expect(memoryPressure(db3)).toContain("Consolidate")
  })
})

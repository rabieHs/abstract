import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { UIMessage } from "ai"
import { openDb } from "@abstract/core"
import { journalUserKey } from "./index.ts"

const u = (text: string): UIMessage =>
  ({ id: "u1", role: "user", parts: [{ type: "text", text }] }) as UIMessage

describe("crash journal", () => {
  test("journalUserKey is stable for the same request, distinct for different ones", () => {
    const a1 = journalUserKey([u("write my chapter")])
    const a2 = journalUserKey([u("write my chapter")])
    const b = journalUserKey([u("actually, review my paper instead")])
    expect(a1).toBe(a2)
    expect(a1).not.toBe(b)
  })

  test("keys off the LAST user message (assistant turns in between don't matter)", () => {
    const history: UIMessage[] = [
      u("first request"),
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "reply" }] } as UIMessage,
      u("second request"),
    ]
    expect(journalUserKey(history)).toBe(journalUserKey([u("second request")]))
  })

  test("turn_journal table: write, read back, replace, delete", () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), "op-journal-")), "t.db"))
    const steps = [{ role: "assistant", content: [{ type: "text", text: "step 1 done" }] }]
    db.query(
      "INSERT OR REPLACE INTO turn_journal (session_id, user_key, accumulated, updated_at) VALUES (?, ?, ?, ?)",
    ).run("s1", "k1", JSON.stringify(steps), Date.now())
    const row = db.query("SELECT user_key, accumulated FROM turn_journal WHERE session_id = ?").get("s1") as {
      user_key: string
      accumulated: string
    }
    expect(row.user_key).toBe("k1")
    expect(JSON.parse(row.accumulated)).toEqual(steps)
    // REPLACE semantics: one journal per session
    db.query(
      "INSERT OR REPLACE INTO turn_journal (session_id, user_key, accumulated, updated_at) VALUES (?, ?, ?, ?)",
    ).run("s1", "k1", JSON.stringify([...steps, { role: "user", content: "more" }]), Date.now())
    expect((db.query("SELECT COUNT(*) n FROM turn_journal").get() as { n: number }).n).toBe(1)
    db.query("DELETE FROM turn_journal WHERE session_id = ?").run("s1")
    expect(db.query("SELECT 1 FROM turn_journal WHERE session_id = ?").get("s1")).toBeNull()
  })

  test("undefined fields are stripped by the JSON round-trip (replay-safe)", () => {
    const dirty = [{ role: "tool", content: [{ type: "tool-result", output: { a: 1, b: undefined } }] }]
    const clean = JSON.parse(JSON.stringify(dirty))
    expect("b" in clean[0].content[0].output).toBe(false)
  })
})

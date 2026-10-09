import { describe, expect, test } from "bun:test"
import type { UIMessage } from "ai"
import { slimHistory } from "./compact.ts"

const many = (n: number, mk: (i: number) => UIMessage) => Array.from({ length: n }, (_, i) => mk(i))

describe("slimHistory preserves reasoning pairs (protocol state)", () => {
  test("old assistant messages keep reasoning parts byte-for-byte", () => {
    const reasoning = {
      type: "reasoning",
      text: "",
      providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: "gAAAA..." } },
    }
    const textPart = {
      type: "text",
      text: "hello",
      providerMetadata: { openai: { itemId: "msg_1" } },
    }
    const msgs = many(12, (i) =>
      ({ id: `m${i}`, role: i % 2 ? "assistant" : "user",
         parts: i % 2 ? [reasoning, textPart] : [{ type: "text", text: `q${i}` }] }) as unknown as UIMessage,
    )
    const slim = slimHistory(msgs)
    // the OLDEST assistant message is far outside any keep-tail — its
    // reasoning must survive, unchanged, next to its text part
    const first = slim.find((m) => m.role === "assistant")!
    const r = first.parts.find((p) => p.type === "reasoning") as typeof reasoning | undefined
    expect(r).toBeDefined()
    expect(r!.providerMetadata.openai.itemId).toBe("rs_1")
    expect(r!.providerMetadata.openai.reasoningEncryptedContent).toBe("gAAAA...")
  })

  test("tool outputs still get digested for old messages", () => {
    const msgs = many(12, (i) =>
      ({ id: `m${i}`, role: i % 2 ? "assistant" : "user",
         parts: i % 2
           ? [{ type: "tool-search_scholar", state: "output-available", input: { q: "x" },
                output: { results: "y".repeat(20_000) } }]
           : [{ type: "text", text: `q${i}` }] }) as unknown as UIMessage,
    )
    const slim = slimHistory(msgs)
    const first = slim.find((m) => m.role === "assistant")!
    const t = first.parts[0] as { output?: unknown }
    expect(JSON.stringify(t.output).length).toBeLessThan(5_000)
  })
})

import { slimModelMessages } from "./compact.ts"
import type { ModelMessage } from "ai"

const toolMsg = (toolName: string, value: unknown, id = "c1"): ModelMessage =>
  ({
    role: "tool",
    content: [{ type: "tool-result", toolCallId: id, toolName, output: { type: "json", value } }],
  }) as ModelMessage

describe("slimModelMessages (in-turn step slimming)", () => {
  const big = { text: "x".repeat(5000), pages: "1-2", coverage: "read 2/12", file: "notes/a.md" }

  test("small conversations pass through untouched (identity)", () => {
    const msgs: ModelMessage[] = [
      { role: "user", content: "hi" },
      toolMsg("read_pages", { text: "short" }),
    ]
    expect(slimModelMessages(msgs)).toBe(msgs)
  })

  test("old big tool outputs become digests; the tail stays verbatim", () => {
    const msgs: ModelMessage[] = []
    for (let i = 0; i < 20; i++) msgs.push(toolMsg("read_pages", big, `c${i}`))
    const out = slimModelMessages(msgs)
    const first = (out[0] as { content: { output: { value: Record<string, unknown> } }[] }).content[0]!
    // digested: big text gone, artifact keys kept
    expect(JSON.stringify(first.output.value).length).toBeLessThan(1000)
    expect(first.output.value["file"]).toBe("notes/a.md")
    expect(first.output.value["coverage"]).toBe("read 2/12")
    // tail untouched
    const last = (out[out.length - 1] as { content: { output: { value: unknown } }[] }).content[0]!
    expect(last.output.value).toBe(big)
  })

  test("assistant messages are never touched", () => {
    const assistant = {
      role: "assistant",
      content: [{ type: "reasoning", text: "", providerOptions: { openai: { itemId: "rs_9" } } }],
    } as unknown as ModelMessage
    const msgs: ModelMessage[] = [assistant]
    for (let i = 0; i < 15; i++) msgs.push(toolMsg("search_library", big, `c${i}`))
    const out = slimModelMessages(msgs)
    expect(out[0]).toBe(assistant)
  })

  test("view_page results are never digested (pixels re-attach by path)", () => {
    const view = toolMsg("view_page", { file: "figures/a.png", note: "y".repeat(3000) })
    const msgs: ModelMessage[] = [view]
    for (let i = 0; i < 15; i++) msgs.push(toolMsg("read_pages", big, `c${i}`))
    const out = slimModelMessages(msgs)
    expect(out[0]).toBe(view)
  })

  test("idempotent: a slimmed conversation slims to itself", () => {
    const msgs: ModelMessage[] = []
    for (let i = 0; i < 20; i++) msgs.push(toolMsg("read_pages", big, `c${i}`))
    const once = slimModelMessages(msgs)
    const twice = slimModelMessages(once)
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once))
  })
})

import { markStableCachePoint, ANTHROPIC_EPHEMERAL_CACHE } from "./compact.ts"

describe("prompt-cache breakpoints (C1)", () => {
  test("markStableCachePoint marks the LAST message and never mutates input", () => {
    const msgs: ModelMessage[] = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ]
    const out = markStableCachePoint(msgs)
    expect(out).toHaveLength(2)
    expect(out[0]).toBe(msgs[0]) // untouched prefix, same reference
    const last = out[1] as { providerOptions?: Record<string, unknown> }
    expect(last.providerOptions).toEqual(ANTHROPIC_EPHEMERAL_CACHE)
    // the input array's own object was not mutated
    expect((msgs[1] as { providerOptions?: unknown }).providerOptions).toBeUndefined()
  })
  test("empty input passes through", () => {
    const empty: ModelMessage[] = []
    expect(markStableCachePoint(empty)).toBe(empty)
  })
  test("existing providerOptions on the last message are preserved and merged", () => {
    const msgs = [
      { role: "user", content: "x", providerOptions: { openai: { k: 1 } } },
    ] as unknown as ModelMessage[]
    const out = markStableCachePoint(msgs)
    const po = (out[0] as { providerOptions: Record<string, unknown> }).providerOptions
    expect(po["openai"]).toEqual({ k: 1 })
    expect(po["anthropic"]).toEqual(ANTHROPIC_EPHEMERAL_CACHE.anthropic)
  })
})

describe("quantized slim boundary (cache-stable prefix)", () => {
  const bigVal = { text: "x".repeat(5000) }
  const mk = (n: number): ModelMessage[] =>
    Array.from({ length: n }, (_, i) => toolMsg("read_pages", bigVal, `c${i}`))

  test("the digest boundary only moves in quantum jumps", () => {
    // 17 messages: raw cut would be 7, quantized cut is 0 — nothing digested
    const out17 = slimModelMessages(mk(17))
    expect(JSON.stringify((out17[0] as { content: { output: { value: unknown } }[] }).content[0]!.output.value)).toContain("x".repeat(100))
    // 18 messages: quantized cut is 8 — the first 8 are digested, 9th intact
    const out18 = slimModelMessages(mk(18))
    const first = (out18[0] as { content: { output: { value: unknown } }[] }).content[0]!
    expect(JSON.stringify(first.output.value).length).toBeLessThan(1000)
    const ninth = (out18[8] as { content: { output: { value: unknown } }[] }).content[0]!
    expect(ninth.output.value).toBe(bigVal)
  })
  test("prefix is byte-stable while the boundary holds (cacheability)", () => {
    // growing 18 → 25 keeps the same cut (8): the already-slimmed prefix of
    // the longer conversation equals the slimmed shorter one, byte for byte
    const out18 = slimModelMessages(mk(18))
    const out25 = slimModelMessages(mk(25))
    expect(JSON.stringify(out25.slice(0, 18))).toBe(JSON.stringify(out18))
  })
})

import {
  compactAccumulated, midturnCut, renderModelSpan, summarizeLong, verbatimRequestsBlock,
} from "./compact.ts"

describe("mid-turn compaction (C2a)", () => {
  const assistantCall = (id: string): ModelMessage =>
    ({ role: "assistant", content: [{ type: "tool-call", toolCallId: id, toolName: "read_pages", input: { p: 1 } }] }) as ModelMessage
  const toolResult = (id: string): ModelMessage =>
    ({ role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName: "read_pages", output: { type: "json", value: { text: "x".repeat(500) } } }] }) as ModelMessage

  test("midturnCut never lets the tail OPEN with an orphan tool result", () => {
    const msgs: ModelMessage[] = []
    for (let i = 0; i < 20; i++) {
      msgs.push(assistantCall(`c${i}`))
      msgs.push(toolResult(`c${i}`))
    }
    const cut = midturnCut(msgs, 5) // raw cut = 35 → lands on a tool message
    expect(msgs[cut]!.role).not.toBe("tool")
    expect(cut).toBeLessThanOrEqual(35)
  })

  test("compactAccumulated folds the head into a resumption message + verbatim tail", async () => {
    const msgs: ModelMessage[] = []
    for (let i = 0; i < 15; i++) {
      msgs.push(assistantCall(`c${i}`))
      msgs.push(toolResult(`c${i}`))
    }
    const out = await compactAccumulated(msgs, async () => "SUMMARY: read 15 pages; next: draft.", { keepTail: 6 })
    expect(out.length).toBeLessThan(msgs.length)
    const first = out[0] as { role: string; content: string }
    expect(first.role).toBe("user")
    expect(first.content).toContain("MID-TURN CONTEXT COMPACTION")
    expect(first.content).toContain("SUMMARY: read 15 pages")
    // tail is verbatim and protocol-valid (opens with an assistant call, not a tool result)
    expect((out[1] as { role: string }).role).not.toBe("tool")
    expect(out[out.length - 1]).toBe(msgs[msgs.length - 1])
  })

  test("too little to fold → input returned unchanged (caller sees a no-op)", async () => {
    const msgs: ModelMessage[] = [assistantCall("c1"), toolResult("c1")]
    expect(await compactAccumulated(msgs, async () => "S")).toBe(msgs)
  })

  test("renderModelSpan renders calls and results compactly", () => {
    const s = renderModelSpan([assistantCall("c1"), toolResult("c1")])
    expect(s).toContain("[call read_pages")
    expect(s).toContain("read_pages →")
  })
})

describe("summarizeLong map-reduce (C2b — no silent truncation)", () => {
  test("every window reaches the summarizer; each fold carries the prior summary", async () => {
    const calls: { system: string; prompt: string }[] = []
    let n = 0
    const fake = async (system: string, prompt: string) => {
      calls.push({ system, prompt })
      return `S${++n}`
    }
    const rendered = "A".repeat(250) // window=100 → 3 windows
    const out = await summarizeLong(rendered, "PRIOR", fake, 100)
    expect(out).toBe("S3")
    expect(calls).toHaveLength(3)
    expect(calls[0]!.prompt).toContain("PRIOR")
    expect(calls[1]!.prompt).toContain("S1")
    expect(calls[2]!.prompt).toContain("S2")
    // nothing dropped: the three windows jointly cover all 250 chars
    const covered = calls.map((c) => c.prompt.split("TURNS TO COMPACT:\n")[1]!.length).reduce((a, b) => a + b, 0)
    expect(covered).toBe(250)
  })
})

describe("verbatimRequestsBlock (the code-extracted anti-drift record)", () => {
  const user = (text: string): UIMessage =>
    ({ id: "u", role: "user", parts: [{ type: "text", text }] }) as UIMessage
  test("extracts user requests verbatim and skips the compaction bridge", () => {
    const block = verbatimRequestsBlock([
      user("write the FATE review, exclude pre-2019 work"),
      { id: "a", role: "assistant", parts: [{ type: "text", text: "ok" }] } as UIMessage,
      user("(continuing from the compacted conversation summarized above)"),
      user("also never cite blog posts"),
    ])
    expect(block).toContain("1. write the FATE review, exclude pre-2019 work")
    expect(block).toContain("2. also never cite blog posts")
    expect(block).not.toContain("(continuing from")
    expect(block).toContain("verbatim, code-extracted")
  })
  test("empty span → empty block", () => {
    expect(verbatimRequestsBlock([])).toBe("")
  })
  test("a marathon session elides the middle, never the mission or the latest direction", () => {
    const many = Array.from({ length: 60 }, (_, i) => user(`request number ${i} ${"pad".repeat(80)}`))
    const block = verbatimRequestsBlock(many)
    expect(block.length).toBeLessThan(12_000)
    expect(block).toContain("request number 0")
    expect(block).toContain("request number 59")
    expect(block).toContain("elided")
  })
})

describe("compact summary faithfulness", () => {
  test("the <analysis> scratchpad is stripped from the stored summary", async () => {
    const fake = async () => "<analysis>walked turns 1-9, all requests found</analysis>\n1. TASK — finish the review."
    const out = await summarizeLong("some rendered turns", null, fake, 1000)
    expect(out).not.toContain("<analysis>")
    expect(out).toContain("1. TASK — finish the review.")
  })
})

import { compactContext } from "./compact.ts"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDb } from "@abstract/core"

describe("EN1 mechanism — compaction survival of constraints (no provider needed)", () => {
  const user = (id: string, text: string): UIMessage =>
    ({ id, role: "user", parts: [{ type: "text", text }] }) as UIMessage
  const asst = (id: string, text: string): UIMessage =>
    ({ id, role: "assistant", parts: [{ type: "text", text }] }) as UIMessage

  test("a 400K-char session compacts through the REAL path with the verbatim record intact", async () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), "op-en1-")), "t.db"))
    const msgs: UIMessage[] = [
      user("u0", "THREE standing rules: (1) exclude pre-2019 work; (2) never cite blog posts; (3) codeword HELIOPAUSE."),
      asst("a0", "Acknowledged."),
    ]
    for (let i = 1; i <= 30; i++) {
      msgs.push(user(`u${i}`, i === 15
        ? "IMPORTANT CORRECTION: additionally exclude workshop papers.\n\n" + "note ".repeat(2500)
        : `reading notes part ${i}: ` + "word ".repeat(2600)))
      msgs.push(asst(`a${i}`, `Noted part ${i}.`))
    }
    expect(JSON.stringify(msgs).length).toBeGreaterThan(360_000)

    // pre-seed the cached summary exactly as a prior run would have left it —
    // compactContext must USE it (no model call) and still build the verbatim
    // requests block from the ORIGINAL messages by code
    const upto = Math.floor(Math.max(0, msgs.length - 10) / 8) * 8
    db.query("INSERT INTO compactions (session_id, upto, summary, created_at) VALUES (?, ?, ?, ?)")
      .run("en1", upto, "1. TASK & SUCCESS CRITERIA — survey; codeword HELIOPAUSE.\n5. NEXT STEPS — continue notes.", Date.now())

    const out = await compactContext(db, "en1", msgs, {} as never)
    expect(out.systemSuffix).toContain("HELIOPAUSE")
    expect(out.systemSuffix).toContain("verbatim, code-extracted")
    // the mid-run correction survives IN THE CODE-EXTRACTED RECORD, not only in the summary
    expect(out.systemSuffix).toContain("exclude workshop papers")
    // the standing-rules message survives verbatim too
    expect(out.systemSuffix).toContain("exclude pre-2019 work")
    // tail is verbatim and starts with a user message
    expect(out.messages.length).toBeLessThan(msgs.length)
    expect(out.messages[0]!.role).toBe("user")
    // context actually shrank
    expect(out.contextChars).toBeLessThan(JSON.stringify(msgs).length / 3)
  })
})

import { describe, expect, test } from "bun:test"
import type { UIMessage } from "ai"
import {
  continuationNudge, errorMessageOf, finalizeTurnParts, friendlyProviderError,
  immediateTurnParts, interleaveInterjections, isTransientStreamError, mergeClientHistory,
  retryDelayHintMs, sanitizeToolParts, shouldContinueTurn,
} from "./turn.ts"

const fakeModel = (text: string) =>
  ({
    specificationVersion: "v2",
    provider: "test",
    modelId: "fake",
    supportedUrls: {},
    doGenerate: async () => ({
      content: [{ type: "text", text }],
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      warnings: [],
    }),
    doStream: async () => {
      throw new Error("not needed")
    },
  }) as never

const poisonedModel = () =>
  ({
    specificationVersion: "v2",
    provider: "test",
    modelId: "poison",
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error("model must not be called")
    },
    doStream: async () => {
      throw new Error("model must not be called")
    },
  }) as never

const toolPart = {
  type: "tool-ask_document",
  toolCallId: "t1",
  state: "output-available",
  input: { path: "a.pdf", question: "q" },
  output: { answer: "42" },
} as unknown as UIMessage["parts"][number]

describe("friendlyProviderError", () => {
  test("quota errors point at credits and Settings", () => {
    const m = friendlyProviderError("429 RESOURCE_EXHAUSTED: quota exceeded")
    expect(m).toContain("quota or credits exhausted")
    expect(m).toContain("Settings")
  })
  test("auth errors point at the API key", () => {
    expect(friendlyProviderError("401 invalid API key")).toContain("rejected the API key")
  })
  test("other errors say the turn was interrupted, with the raw cause", () => {
    const m = friendlyProviderError("socket hang up")
    expect(m).toContain("interrupted")
    expect(m).toContain("socket hang up")
  })
})

describe("ChatGPT plan errors", () => {
  const limit = '{"type":"chatgpt_error","code":"chatgpt_error","message":"ChatGPT plan usage limit reached (chatgpt_usage_limit) — manage usage at https://chatgpt.com/settings/usage"}'

  test("usage limit gets the Usage limit reached message with the manage-usage link", () => {
    const m = friendlyProviderError(limit)
    expect(m).toStartWith("Usage limit reached")
    expect(m).toContain("https://chatgpt.com/settings/usage")
  })

  test("usage limit is never retried, even as a 429", () => {
    expect(isTransientStreamError(limit, 429)).toBe(false)
    expect(isTransientStreamError(limit)).toBe(false)
  })

  test("ineligible plan and lost sign-in are fatal with their own guidance", () => {
    const ineligible = "This ChatGPT account can't use its plan here (chatgpt_not_eligible) — plan usage needs ChatGPT Plus or Pro."
    expect(friendlyProviderError(ineligible)).toContain("Plus or Pro")
    expect(isTransientStreamError(ineligible, 403)).toBe(false)
    const signedOut = "Your ChatGPT session ended (chatgpt_signed_out) — sign in again"
    expect(friendlyProviderError(signedOut)).toContain("Continue with ChatGPT")
    expect(isTransientStreamError(signedOut, 401)).toBe(false)
  })

  test("a temporarily unavailable plan route still retries", () => {
    expect(isTransientStreamError("ChatGPT plan usage is temporarily unavailable — service unavailable, retrying.", 503)).toBe(true)
  })
})

describe("finalizeTurnParts", () => {
  test("a stream error is persisted as visible text (model untouched)", async () => {
    const parts = await finalizeTurnParts([], {
      streamError: "provider quota or credits exhausted — top up",
      model: poisonedModel(),
      lastUserText: "hello",
    })
    const last = parts[parts.length - 1] as { type: string; text: string }
    expect(last.type).toBe("text")
    expect(last.text).toContain("⚠")
    expect(last.text).toContain("exhausted")
  })

  test("a tool-only turn gets a closing summary", async () => {
    const parts = await finalizeTurnParts([toolPart], {
      streamError: null,
      model: fakeModel("I read the table in a.pdf; the answer is 42."),
      lastUserText: "what does table 2 say?",
    })
    const last = parts[parts.length - 1] as { type: string; text: string }
    expect(last.type).toBe("text")
    expect(last.text).toContain("42")
  })

  test("a turn that already has text is left alone", async () => {
    const withText = [toolPart, { type: "text", text: "done." } as UIMessage["parts"][number]]
    const parts = await finalizeTurnParts(withText, {
      streamError: null,
      model: poisonedModel(),
      lastUserText: "x",
    })
    expect(parts).toHaveLength(2)
  })

  test("summary-model failure never blocks persistence", async () => {
    const parts = await finalizeTurnParts([toolPart], {
      streamError: null,
      model: poisonedModel(),
      lastUserText: "x",
    })
    expect(parts).toHaveLength(1) // unchanged, no throw
  })

  test("a fully empty errored turn still yields a visible message", async () => {
    const parts = await finalizeTurnParts([], {
      streamError: friendlyProviderError("429 rate limit"),
      model: poisonedModel(),
      lastUserText: "x",
    })
    expect(parts).toHaveLength(1)
    expect((parts[0] as { text: string }).text).toContain("⚠")
  })

  test("a dangling tool call is converted to an error result (session never wedges)", () => {
    const dangling = {
      type: "tool-draft_section",
      toolCallId: "t9",
      state: "input-available",
      input: { instructions: "x" },
    } as unknown as UIMessage["parts"][number]
    const out = sanitizeToolParts([dangling])
    const t = out[0] as { state: string; errorText?: string }
    expect(t.state).toBe("output-error")
    expect(t.errorText).toContain("interrupted")
  })

  test("a reasoning-only turn still yields visible text", () => {
    const reasoning = { type: "reasoning", text: "thinking" } as unknown as UIMessage["parts"][number]
    const { parts, needsSummary } = immediateTurnParts([reasoning], null)
    expect(needsSummary).toBe(false)
    const last = parts[parts.length - 1] as { type: string; text: string }
    expect(last.type).toBe("text")
    expect(last.text).toContain("⚠")
  })

  test("completed tool parts pass through sanitize untouched", () => {
    const out = sanitizeToolParts([toolPart])
    expect(out[0]).toBe(toolPart)
  })
})

describe("interleaveInterjections — steering must never corrupt the transcript", () => {
  const t = (id: string) =>
    ({ type: "tool-read_pages", toolCallId: id, state: "output-available", input: {}, output: {} }) as unknown as UIMessage["parts"][number]
  const txt = (s: string) => ({ type: "text", text: s }) as UIMessage["parts"][number]

  test("no interjections → one assistant segment, parts identical", () => {
    const parts = [txt("a"), t("t1"), txt("b")]
    const { segments } = interleaveInterjections(parts, [])
    expect(segments).toHaveLength(1)
    expect(segments[0]!.parts).toEqual(parts)
  })

  test("one interjection splits at exactly its tool boundary", () => {
    const parts = [t("t1"), t("t2"), txt("done")]
    const { segments } = interleaveInterjections(parts, [
      { text: "focus on CPU only", afterToolCallId: "t1" },
    ])
    expect(segments.map((s) => s.role)).toEqual(["assistant", "user", "assistant"])
    expect(segments[0]!.parts).toHaveLength(1) // t1
    expect((segments[1]!.parts[0] as { text: string }).text).toBe("focus on CPU only")
    expect(segments[2]!.parts).toHaveLength(2) // t2 + text
  })

  test("two interjections at the same boundary become two user messages in order", () => {
    const { segments } = interleaveInterjections([t("t1"), txt("x")], [
      { text: "first", afterToolCallId: "t1" },
      { text: "second", afterToolCallId: "t1" },
    ])
    expect(segments.map((s) => s.role)).toEqual(["assistant", "user", "user", "assistant"])
    expect((segments[1]!.parts[0] as { text: string }).text).toBe("first")
    expect((segments[2]!.parts[0] as { text: string }).text).toBe("second")
  })

  test("nothing is ever lost: parts count is conserved, unknown boundaries still surface", () => {
    const parts = [txt("a"), t("t1"), t("t2")]
    const { segments } = interleaveInterjections(parts, [
      { text: "orphan", afterToolCallId: "never-existed" },
    ])
    const allParts = segments.filter((s) => s.role === "assistant").flatMap((s) => s.parts)
    expect(allParts).toEqual(parts) // assistant content untouched
    const userTexts = segments.filter((s) => s.role === "user").map((s) => (s.parts[0] as { text: string }).text)
    expect(userTexts).toEqual(["orphan"]) // the user's words survive anyway
  })

  test("interjection after the LAST tool leaves a trailing assistant segment intact", () => {
    const parts = [t("t1"), txt("wrap-up")]
    const { segments } = interleaveInterjections(parts, [{ text: "note", afterToolCallId: "t1" }])
    expect(segments.map((s) => s.role)).toEqual(["assistant", "user", "assistant"])
    expect((segments[2]!.parts[0] as { text: string }).text).toBe("wrap-up")
  })
})

describe("mergeClientHistory", () => {
  const u = (id: string, text: string): UIMessage =>
    ({ id, role: "user", parts: [{ type: "text", text }] }) as UIMessage
  const a = (id: string, text: string): UIMessage =>
    ({ id, role: "assistant", parts: [{ type: "text", text }] }) as UIMessage
  const texts = (ms: UIMessage[]) =>
    ms.map((m) => `${m.role}:${(m.parts[0] as { text: string }).text}`)

  test("empty DB: the posted history is used verbatim (first turn)", () => {
    const posted = [u("c1", "hello")]
    expect(mergeClientHistory([], posted)).toEqual(posted)
  })

  test("normal next turn: DB prefix wins, the new user message is appended", () => {
    const db = [u("s0", "q1"), a("s1", "part one"), u("s2", "steer"), a("s3", "part two")]
    const posted = [u("c0", "q1"), a("c1", "part one part two"), u("c2", "q2")]
    expect(texts(mergeClientHistory(db, posted))).toEqual([
      "user:q1", "assistant:part one", "user:steer", "assistant:part two", "user:q2",
    ])
  })

  test("stale client that never refetched cannot erase server-only rows", () => {
    const db = [u("s0", "q1"), a("s1", "reply"), u("s2", "late steer")]
    const posted = [u("c0", "q1"), a("c1", "reply"), u("c2", "q2")]
    expect(texts(mergeClientHistory(db, posted))).toEqual([
      "user:q1", "assistant:reply", "user:late steer", "user:q2",
    ])
  })

  test("auto-continue: a trailing user message already persisted is not duplicated", () => {
    const db = [u("s0", "q1"), a("s1", "reply"), u("s2", "late steer")]
    const posted = [u("c0", "q1"), a("c1", "reply"), u("c2", "late steer")]
    expect(texts(mergeClientHistory(db, posted))).toEqual([
      "user:q1", "assistant:reply", "user:late steer",
    ])
  })

  test("multiple trailing user messages after the client's last assistant all append", () => {
    const db = [u("s0", "q1"), a("s1", "reply")]
    const posted = [u("c0", "q1"), a("c1", "reply"), u("c2", "first"), u("c3", "second")]
    expect(texts(mergeClientHistory(db, posted))).toEqual([
      "user:q1", "assistant:reply", "user:first", "user:second",
    ])
  })

  test("non-text user parts (file attachments) still ride along in the tail", () => {
    const db = [u("s0", "q1"), a("s1", "reply")]
    const withFile = {
      id: "c2", role: "user",
      parts: [{ type: "file", url: "u", mediaType: "application/pdf" }, { type: "text", text: "read this" }],
    } as unknown as UIMessage
    const merged = mergeClientHistory(db, [u("c0", "q1"), a("c1", "reply"), withFile])
    expect(merged).toHaveLength(3)
    expect(merged[2]!.parts).toHaveLength(2)
  })
})

describe("mergeClientHistory element-wise dedupe", () => {
  const u = (id: string, text: string): UIMessage =>
    ({ id, role: "user", parts: [{ type: "text", text }] }) as UIMessage
  const a = (id: string, text: string): UIMessage =>
    ({ id, role: "assistant", parts: [{ type: "text", text }] }) as UIMessage
  const texts = (ms: UIMessage[]) =>
    ms.map((m) => `${m.role}:${(m.parts[0] as { text: string }).text}`)

  test("re-posted persisted steer followed by a NEW message: steer not duplicated", () => {
    const db = [u("s0", "q1"), a("s1", "reply"), u("s2", "A")]
    const posted = [u("c0", "q1"), a("c1", "reply"), u("c2", "A"), u("c3", "B")]
    expect(texts(mergeClientHistory(db, posted))).toEqual([
      "user:q1", "assistant:reply", "user:A", "user:B",
    ])
  })

  test("two persisted trailing steers re-posted plus a new message", () => {
    const db = [u("s0", "q1"), a("s1", "reply"), u("s2", "A"), u("s3", "B")]
    const posted = [u("c0", "q1"), a("c1", "reply"), u("c2", "A"), u("c3", "B"), u("c4", "C")]
    expect(texts(mergeClientHistory(db, posted))).toEqual([
      "user:q1", "assistant:reply", "user:A", "user:B", "user:C",
    ])
  })

  test("no DB user tail: nothing is deduped, genuine repeat text still appends", () => {
    const db = [u("s0", "continue"), a("s1", "reply")]
    const posted = [u("c0", "continue"), a("c1", "reply"), u("c2", "continue")]
    expect(texts(mergeClientHistory(db, posted))).toEqual([
      "user:continue", "assistant:reply", "user:continue",
    ])
  })
})

describe("isTransientStreamError — resume only what a retry can actually fix", () => {
  test("network/stream deaths are transient", () => {
    expect(isTransientStreamError("The socket connection was closed unexpectedly. For more information, pass `verbose: true`")).toBe(true)
    expect(isTransientStreamError("fetch failed: ECONNRESET")).toBe(true)
    expect(isTransientStreamError("terminated: other side closed")).toBe(true)
    expect(isTransientStreamError("502 Bad Gateway")).toBe(true)
    expect(isTransientStreamError("The service is currently overloaded")).toBe(true)
  })
  test("auth, quota and request errors are fatal", () => {
    expect(isTransientStreamError("Google Generative AI API key is missing")).toBe(false)
    expect(isTransientStreamError("401 Unauthorized")).toBe(false)
    expect(isTransientStreamError("You exceeded your current quota")).toBe(false)
    // per-minute rate limits are transient BY DESIGN since the TPM incident —
    // they self-heal in seconds; hard quota (above) stays fatal
    expect(isTransientStreamError("429 rate limit reached")).toBe(true)
    expect(isTransientStreamError("This model's maximum context length is 128000 tokens")).toBe(false)
    expect(isTransientStreamError("Invalid request: unknown parameter")).toBe(false)
  })
  test("numbers inside unrelated text do not false-positive as HTTP 5xx", () => {
    expect(isTransientStreamError("processed 5030 tokens in the request")).toBe(false)
  })
})

describe("errorMessageOf + classification of provider in-band error objects", () => {
  test("plain-object provider errors become classifiable text, never [object Object]", () => {
    expect(errorMessageOf({ type: "overloaded_error", message: "Overloaded" })).toContain("overloaded_error")
    expect(errorMessageOf(new Error("boom"))).toBe("boom")
    expect(errorMessageOf("plain")).toBe("plain")
  })
  test("Anthropic overloaded / OpenAI server_error resume; invalid_request is fatal", () => {
    expect(isTransientStreamError(errorMessageOf({ type: "overloaded_error", message: "Overloaded" }))).toBe(true)
    expect(isTransientStreamError(errorMessageOf({ type: "server_error", message: "The server had an error" }))).toBe(true)
    expect(isTransientStreamError(errorMessageOf({ type: "api_error", message: "internal error" }))).toBe(true)
    expect(isTransientStreamError(errorMessageOf({ type: "invalid_request_error", message: "max_tokens too large" }))).toBe(false)
    expect(isTransientStreamError(errorMessageOf({ type: "authentication_error", message: "invalid x-api-key" }))).toBe(false)
  })
})

describe("shouldContinueTurn — the stop-gate", () => {
  const base = { finishReason: "stop", ranRealTools: true, openItems: 5, nudges: 0, maxNudges: 4 }
  test("milestone stop with open plan and real work → continue", () => {
    expect(shouldContinueTurn(base)).toBe(true)
  })
  test("talk-only turn (plan proposal, question, blocker) is NEVER continued", () => {
    expect(shouldContinueTurn({ ...base, ranRealTools: false })).toBe(false)
  })
  test("plan complete → normal end", () => {
    expect(shouldContinueTurn({ ...base, openItems: 0 })).toBe(false)
  })
  test("loop guard exhausted → end", () => {
    expect(shouldContinueTurn({ ...base, nudges: 4 })).toBe(false)
  })
  test("non-stop finish reasons (length, tool-calls, error, undefined) → no gate", () => {
    for (const fr of ["length", "tool-calls", "error", undefined])
      expect(shouldContinueTurn({ ...base, finishReason: fr })).toBe(false)
  })
  test("nudge text lists the open items and allows a stated blocker", () => {
    const n = continuationNudge([{ content: "Deep-read the core set", status: "pending" }])
    expect(n).toContain("Deep-read the core set")
    expect(n).toContain("the user did NOT write it")
    expect(n).toContain("say so plainly and stop")
  })
})

describe("rate limits: per-minute limits resume, hard quota stays fatal", () => {
  const tpm = 'Rate limit reached for gpt-5 in organization org-x on tokens per min (TPM): Limit 500000, Used 471018, Requested 77282. Please try again in 5.796s.'
  test("TPM rate limit is transient with the provider's own delay hint", () => {
    expect(isTransientStreamError(tpm)).toBe(true)
    expect(retryDelayHintMs(tpm)).toBe(5796)
  })
  test("hard quota / billing stays fatal with the quota message", () => {
    const hard = "You exceeded your current quota, please check your plan and billing details. (insufficient_quota)"
    expect(isTransientStreamError(hard)).toBe(false)
    expect(friendlyProviderError(hard)).toContain("quota or credits exhausted")
  })
  test("exhausted-retry rate limit surfaces the wait-and-resend message", () => {
    expect(friendlyProviderError(tpm)).toContain("rate limit stayed saturated")
  })
  test("no hint → no fabricated delay", () => {
    expect(retryDelayHintMs("socket closed unexpectedly")).toBe(null)
  })
})

import { shouldRemindPlan, planReminder, PLAN_REMINDER_AFTER_STEPS, PLAN_REMINDER_INTERVAL } from "./turn.ts"

describe("in-turn task reinforcement", () => {
  test("does not remind when the plan has no open items", () => {
    expect(shouldRemindPlan({ openItems: 0, stepsSincePlanTouch: 50, stepsSinceReminder: 50 })).toBe(false)
  })
  test("does not remind before the plan has been silent long enough", () => {
    expect(
      shouldRemindPlan({ openItems: 3, stepsSincePlanTouch: PLAN_REMINDER_AFTER_STEPS - 1, stepsSinceReminder: 99 }),
    ).toBe(false)
  })
  test("reminds once the silence threshold is crossed with open work", () => {
    expect(
      shouldRemindPlan({ openItems: 3, stepsSincePlanTouch: PLAN_REMINDER_AFTER_STEPS, stepsSinceReminder: PLAN_REMINDER_INTERVAL }),
    ).toBe(true)
  })
  test("does not re-remind before the interval elapses (no spam)", () => {
    expect(
      shouldRemindPlan({ openItems: 3, stepsSincePlanTouch: 99, stepsSinceReminder: PLAN_REMINDER_INTERVAL - 1 }),
    ).toBe(false)
  })
  test("reminder is a self-concealing <system-reminder> listing open items", () => {
    const t = planReminder([{ content: "deep-read the 8 core papers", status: "in_progress" }])
    expect(t).toContain("<system-reminder>")
    expect(t).toContain("Do not mention this reminder")
    expect(t).toContain("[in_progress] deep-read the 8 core papers")
    expect(t).toContain("update_plan")
    expect(t).toContain("</system-reminder>")
  })
})

import { classifyFailure, computeBackoffMs, MAX_BACKOFF_MS } from "./turn.ts"

describe("classifyFailure (structured status + retry-after extraction)", () => {
  test("plain Error yields message only", () => {
    const f = classifyFailure(new Error("socket hang up"))
    expect(f.message).toBe("socket hang up")
    expect(f.statusCode).toBeUndefined()
    expect(f.retryAfterMs).toBeUndefined()
  })
  test("statusCode and retry-after-ms are read off the error itself", () => {
    const err = Object.assign(new Error("rate limited"), {
      statusCode: 429,
      responseHeaders: { "retry-after-ms": "2350.5" },
    })
    const f = classifyFailure(err)
    expect(f.statusCode).toBe(429)
    expect(f.retryAfterMs).toBe(2351)
  })
  test("retry-after in seconds converts to ms; headers are case-insensitive", () => {
    const err = Object.assign(new Error("overloaded"), {
      statusCode: 529,
      responseHeaders: { "Retry-After": "7" },
    })
    const f = classifyFailure(err)
    expect(f.statusCode).toBe(529)
    expect(f.retryAfterMs).toBe(7000)
  })
  test("walks the cause chain to find the wrapped APICallError facts", () => {
    const inner = Object.assign(new Error("429 Too Many Requests"), {
      statusCode: 429,
      responseHeaders: { "retry-after": "12" },
    })
    const outer = new Error("fetch failed", { cause: inner })
    const f = classifyFailure(outer)
    expect(f.statusCode).toBe(429)
    expect(f.retryAfterMs).toBe(12000)
  })
})

describe("isTransientStreamError with a known status (status beats regex)", () => {
  test("429/529/5xx/408/409 are transient by status", () => {
    for (const s of [408, 409, 429, 500, 503, 529]) {
      expect(isTransientStreamError("anything at all", s)).toBe(true)
    }
  })
  test("other 4xx are fatal by status even with transient-looking text", () => {
    expect(isTransientStreamError("connection reset while rate limited", 400)).toBe(false)
    expect(isTransientStreamError("not found", 404)).toBe(false)
  })
  test("quota exhaustion stays fatal even though it arrives as 429", () => {
    expect(isTransientStreamError("You exceeded your current quota", 429)).toBe(false)
    expect(isTransientStreamError("insufficient_quota", 429)).toBe(false)
  })
  test("no status falls back to the message classification", () => {
    expect(isTransientStreamError("ECONNRESET")).toBe(true)
    expect(isTransientStreamError("invalid api key")).toBe(false)
  })
})

describe("computeBackoffMs (consecutive-failure scoped, provider hint honored, capped)", () => {
  test("grows with CONSECUTIVE failures, never uncapped", () => {
    const d1 = computeBackoffMs(1, null, 0)
    const d3 = computeBackoffMs(3, null, 0)
    expect(d1).toBe(1600)
    expect(d3).toBe(6400)
    expect(computeBackoffMs(30, null, 0)).toBe(MAX_BACKOFF_MS)
  })
  test("a provider-stated cool-down is authoritative, padded per failure", () => {
    expect(computeBackoffMs(1, 5000, 0)).toBe(6000)
    expect(computeBackoffMs(2, 5000, 0)).toBe(7000)
  })
  test("even a huge provider hint respects the ceiling", () => {
    expect(computeBackoffMs(1, 10 * 60 * 1000, 0)).toBe(MAX_BACKOFF_MS)
  })
  test("the old pathology is gone: 10 consecutive failures wait ≤60s, not ~13.7min", () => {
    expect(computeBackoffMs(10, null, 0)).toBeLessThanOrEqual(MAX_BACKOFF_MS)
  })
})

import {
  adjudicateStop, endsWithDeferredWork, gaveUpNotice, lastAssistantText, promiseNudge,
  statesUserBlocker,
} from "./turn.ts"

describe("stop-gate v2 — adjudicated stop (C5)", () => {
  const base = { finishReason: "stop" as const, ranRealTools: true, nudges: 0, maxNudges: 4 }

  test("open plan → continue (v1 behavior preserved)", () => {
    expect(adjudicateStop({ ...base, openItems: 2, lastText: "Screening done." }).kind).toBe("continue-open-plan")
  })
  test("a stated user-blocking question is a LEGITIMATE stop, even with open items", () => {
    expect(
      adjudicateStop({ ...base, openItems: 2, lastText: "Two venues fit. Which would you prefer, CBMI or ICTAI?" }).kind,
    ).toBe("end")
  })
  test("empty plan is NO free exit when the closing words promise more work", () => {
    expect(
      adjudicateStop({ ...base, openItems: 0, lastText: "The corpus is screened. I'll now draft the comparison section." }).kind,
    ).toBe("continue-deferred-promise")
  })
  test("empty plan + a genuinely final message → end", () => {
    expect(
      adjudicateStop({ ...base, openItems: 0, lastText: "The review is saved to drafts/review-fate.md with 14 supported claims." }).kind,
    ).toBe("end")
  })
  test("nudges exhausted with open items → gave-up (visible), never silent end", () => {
    const d = adjudicateStop({ ...base, nudges: 4, openItems: 3, lastText: "More to do." })
    expect(d.kind).toBe("gave-up")
    if (d.kind === "gave-up") expect(d.openItems).toBe(3)
  })
  test("talk-only turns always pass (propose-and-confirm intact)", () => {
    expect(
      adjudicateStop({ ...base, ranRealTools: false, openItems: 3, lastText: "Here is my proposed strategy. Shall I proceed?" }).kind,
    ).toBe("end")
  })

  test("deferred-work detector catches the classic closers", () => {
    expect(endsWithDeferredWork("Screening complete. I'll now read the remaining papers.")).toBe(true)
    expect(endsWithDeferredWork("Done screening. Next, I will draft section 2.")).toBe(true)
    expect(endsWithDeferredWork("Moving on to the synthesis.")).toBe(true)
    expect(endsWithDeferredWork("The draft is complete and saved.")).toBe(false)
  })
  test("user-blocker detector: questions and stated blocks pass, rhetoric does not", () => {
    expect(statesUserBlocker("Should I include preprints in the corpus?")).toBe(true)
    expect(statesUserBlocker("I am blocked on your decision about the venue.")).toBe(true)
    expect(statesUserBlocker("This raises the question of scalability in general.")).toBe(false)
  })

  test("lastAssistantText walks back to the latest non-empty assistant text", () => {
    const msgs = [
      { role: "assistant", content: [{ type: "text", text: "first" }] },
      { role: "tool", content: [] },
      { role: "assistant", content: [{ type: "tool-call", toolName: "x" }] },
      { role: "assistant", content: [{ type: "text", text: "the closer" }] },
    ]
    expect(lastAssistantText(msgs)).toBe("the closer")
    expect(lastAssistantText([])).toBe("")
  })

  test("gave-up notice names the open items and is user-visible language", () => {
    const n = gaveUpNotice([{ content: "deep-read kaur2024" }, { content: "draft section 3" }])
    expect(n).toContain("2 plan item(s) still open")
    expect(n).toContain("deep-read kaur2024")
    expect(n).toContain("send a message to continue")
  })
  test("promise nudge quotes the model's own closing words back at it", () => {
    const n = promiseNudge("All screened. I'll now write the review.")
    expect(n).toContain("I'll now write the review")
    expect(n).toContain("Do that work NOW")
  })
})

import { artifactMismatchNudge, claimsAbsentTable } from "./turn.ts"

describe("reply-vs-artifact honesty (the claimed-table miss)", () => {
  test("detects table claims in closing prose", () => {
    expect(claimsAbsentTable("The draft includes a comparison table across studies.")).toBe(true)
    expect(claimsAbsentTable("I built a table comparing methods and datasets.")).toBe(true)
    expect(claimsAbsentTable("a verified draft with a table of fairness metrics")).toBe(true)
  })
  test("does not fire on table-free replies or the word 'stable'", () => {
    expect(claimsAbsentTable("The draft covers six sources with inline citations.")).toBe(false)
    expect(claimsAbsentTable("Results were stable across seeds.")).toBe(false)
  })
  test("the nudge names the file and both honest exits", () => {
    const n = artifactMismatchNudge("drafts/review-x.md")
    expect(n).toContain("drafts/review-x.md")
    expect(n).toContain("NO table")
    expect(n).toContain("correct your reply")
  })
})

import { systemReminder } from "./turn.ts"

describe("steer harmonization — the <system-reminder> convention", () => {
  test("every steer builder wraps in a self-concealing system-reminder", () => {
    for (const msg of [
      continuationNudge([{ content: "x", status: "pending" }]),
      promiseNudge("I'll now write the review."),
      artifactMismatchNudge("drafts/r.md"),
      systemReminder("anything"),
    ]) {
      expect(msg).toContain("<system-reminder>")
      expect(msg).toContain("Do not mention it, quote it, or reply to it")
      expect(msg).toContain("</system-reminder>")
    }
  })
  test("honestly stating a table's ABSENCE never re-fires the artifact check", () => {
    expect(claimsAbsentTable("You're right — the draft contains no table.")).toBe(false)
    expect(claimsAbsentTable("The review lacks a table because only one direct study exists.")).toBe(false)
    expect(claimsAbsentTable("I built a comparison table across the studies.")).toBe(true)
  })
})

import { repairToolInput, repairToolName } from "./turn.ts"

describe("tool-call repair — the harness absorbs mechanical slips", () => {
  test("case-drifted names remap when unambiguous (the search_Scholar case)", () => {
    expect(repairToolName("search_Scholar", ["search_scholar", "search_library"])).toBe("search_scholar")
    expect(repairToolName("SEARCH_LIBRARY", ["search_scholar", "search_library"])).toBe("search_library")
    expect(repairToolName("search", ["search_scholar", "search_library"])).toBeNull()
  })
  test("the REAL leaked-scaffolding payload repairs into a queries array", () => {
    const real = JSON.stringify({
      document: "ictai-review",
      instructions: "Write a review.",
      queries: '\n<parameter name="queries">FRUGAL-FATE BENCH framework architecture tool implementation',
    })
    const fixed = repairToolInput(real, new Set(["queries"]))
    expect(fixed).not.toBeNull()
    const parsed = JSON.parse(fixed!)
    expect(parsed.queries).toEqual(["FRUGAL-FATE BENCH framework architecture tool implementation"])
    expect(parsed.instructions).toBe("Write a review.")
  })
  test("a JSON-array-as-string (second real payload) parses into the real array", () => {
    const real = JSON.stringify({
      queries: '\n<parameter name="queries">["DEA cross-efficiency", "web demo reproducibility"]',
    })
    const parsed = JSON.parse(repairToolInput(real, new Set(["queries"]))!)
    expect(parsed.queries).toEqual(["DEA cross-efficiency", "web demo reproducibility"])
  })
  test("nothing repairable → null (the error path stands)", () => {
    expect(repairToolInput("not json", new Set())).toBeNull()
    expect(repairToolInput('{"queries": ["already", "fine"]}', new Set(["queries"]))).toBeNull()
  })
})

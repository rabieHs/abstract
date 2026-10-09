import { generateText, type LanguageModel, type ModelMessage, type UIMessage } from "ai"
import type { Database } from "@abstract/core"

/**
 * Context management for long conversations. Everything here shapes ONLY what
 * is sent to the model this turn — the database and the UI always keep the
 * full conversation.
 *
 * Two tiers:
 *  1. mechanical slimming (always): old tool outputs become small digests,
 *     old inline attachments are dropped, reasoning parts go away.
 *  2. summarization (only past a size threshold): turns before a boundary are
 *     compacted into a cached summary that rides the system prompt; only the
 *     recent tail is sent verbatim.
 */

const SLIM_KEEP_TAIL = 6 // most recent messages pass through untouched
// attachments stay visible much longer than tool noise — the user expects the
// model to still "see" an image from a few exchanges ago
const ATTACH_KEEP_TAIL = 14
const SLIM_OUTPUT_MAX = 700 // stringified tool output above this becomes a digest
const SLIM_INPUT_MAX = 400
// Summarization threshold. ~4 chars/token: 360K chars ≈ 90K tokens — a common
// auto-compact point for agent harnesses, and safe for every provider we
// route to (the smallest common context is 200K tokens). The previous 150K
// chars (~37K tokens) compacted ~4× too early and threw away detail the
// context could easily have held.
const COMPACT_THRESHOLD = 360_000
const COMPACT_STEP = 8 // the summary boundary advances in steps (keeps the cache warm)
// verbatim tail after the boundary: the model keeps the recent exchange
// word-for-word even after everything before it was summarized
const COMPACT_TAIL = 10

/** keys that point at on-disk artifacts, tiny result fields, or reality
 *  signals the model must still see after the raw output is trimmed — always
 *  kept. The *_warning/evidence_depth/sections_dropped signals are load-bearing
 *  integrity nudges: a draft's remediation ("screen those sources and revise")
 *  can take more than the keep-tail of steps, so the nudge must survive slimming */
const DIGEST_KEYS = [
  "file", "dataFile", "summary", "path", "error", "note", "warning", "coverage",
  "count", "references", "warnings", "status", "edited", "reindexed",
  "reading_warning", "sources_never_read", "evidence_depth", "revision_size",
  "sections_dropped", "excludedUnread", "library_state", "skills_note",
  "tables_expected_but_absent", "coverage_note", "narration_note", "brief_only_note",
  "gap_note", "search_log", "matrix_state", "blocked_note", "clamped", "next",
  "table_promise_missed", "verdict_note", "new_candidates", "tasks_dropped", "mode_note",
]

function digestOutput(output: unknown): unknown {
  const s = JSON.stringify(output)
  if (!s || s.length <= SLIM_OUTPUT_MAX) return output
  if (output && typeof output === "object" && !Array.isArray(output)) {
    const o = output as Record<string, unknown>
    const keep: Record<string, unknown> = {}
    for (const k of DIGEST_KEYS) if (k in o) keep[k] = o[k]
    if (Object.keys(keep).length > 0) {
      return { ...keep, slimmed: "full output trimmed from context; artifacts live on disk" }
    }
  }
  return { slimmed: s.slice(0, SLIM_OUTPUT_MAX) + "…" }
}

/**
 * In-TURN slimming, applied via prepareStep on every step of a running turn.
 * A 60-step research run used to re-send every old tool output (search dumps,
 * page text) on every step — the quadratic cost behind rate-limit stalls. Old
 * TOOL outputs become small digests; the recent tail stays verbatim.
 *
 * Safety: only tool-role messages are touched. Assistant messages (reasoning
 * items are provider-signed protocol state) pass through byte-for-byte.
 * view_page results are kept whole — their file path drives pixel
 * re-attachment. Deterministic and idempotent: the same messages always slim
 * to the same bytes, so each step's prompt prefix stays provider-cacheable
 * (one message crosses the age boundary per step; everything before it is
 * unchanged).
 */
const STEP_KEEP_TAIL = 10
const STEP_OUTPUT_MAX = 1500
// The digest boundary advances in QUANTUM jumps, not per message. A per-step
// moving boundary rewrites one old message every step, which permanently caps
// the provider-cacheable prompt prefix ~10 messages back; quantizing keeps the
// prefix byte-stable for QUANTUM steps at a time so cache reads cover it.
const STEP_BOUNDARY_QUANTUM = 8

export function slimModelMessages(messages: ModelMessage[]): ModelMessage[] {
  const cut =
    Math.floor(Math.max(0, messages.length - STEP_KEEP_TAIL) / STEP_BOUNDARY_QUANTUM) *
    STEP_BOUNDARY_QUANTUM
  let changed = false
  const out = messages.map((m, i) => {
    if (i >= cut || m.role !== "tool" || !Array.isArray(m.content)) return m
    let mChanged = false
    const content = m.content.map((part) => {
      if (part.type !== "tool-result" || part.toolName === "view_page") return part
      const o = part.output as { type?: string; value?: unknown } | undefined
      if (o?.type === "json") {
        const s = JSON.stringify(o.value)
        if (s && s.length > STEP_OUTPUT_MAX) {
          mChanged = true
          return { ...part, output: { type: "json" as const, value: digestOutput(o.value) } }
        }
      } else if (o?.type === "text" && typeof o.value === "string" && o.value.length > STEP_OUTPUT_MAX) {
        mChanged = true
        return {
          ...part,
          output: {
            type: "text" as const,
            value:
              o.value.slice(0, STEP_OUTPUT_MAX) +
              " …[old output trimmed mid-turn; notes and artifacts persist on disk]",
          },
        }
      }
      return part
    })
    if (!mChanged) return m
    changed = true
    return { ...m, content } as ModelMessage
  })
  return changed ? out : messages
}

/** tier 1 — deterministic, lossless for the recent tail, never mutates input */
export function slimHistory(messages: UIMessage[]): UIMessage[] {
  const cut = Math.max(0, messages.length - SLIM_KEEP_TAIL)
  const attachCut = Math.max(0, messages.length - ATTACH_KEEP_TAIL)
  return messages
    .map((m, i) => {
      if (i >= cut) return m
      let changed = false
      const parts = m.parts.flatMap((p) => {
        const part = p as Record<string, unknown> & { type: string }
        if (part.type === "file") {
          if (i >= attachCut) return [p] // recent attachments stay fully visible
          changed = true
          const label = (part.filename as string) ?? (part.mediaType as string) ?? "file"
          return [
            {
              type: "text" as const,
              text: `[attachment "${label}" from an earlier message — dropped from context; ask the user to re-attach it if needed]`,
            },
          ]
        }
        if (part.type === "reasoning") {
          // KEEP, byte-for-byte. Reasoning items are PROTOCOL STATE for
          // reasoning models: OpenAI pairs each msg_ item to its rs_ item and
          // hard-rejects a replay that orphans one; Gemini signs its thoughts.
          // The measured cost is small (~4KB/turn of encrypted blob, zero
          // visible text) and the summarize tier still bounds deep history by
          // replacing whole turns — both halves of the pair together.
          return [p]
        }
        if (part.type.startsWith("tool-")) {
          const inStr = JSON.stringify(part.input)
          const slimInput =
            inStr && inStr.length > SLIM_INPUT_MAX
              ? { slimmed: inStr.slice(0, SLIM_INPUT_MAX) + "…" }
              : part.input
          const slimOutput = part.output !== undefined ? digestOutput(part.output) : part.output
          if (slimInput !== part.input || slimOutput !== part.output) {
            changed = true
            return [{ ...part, input: slimInput, output: slimOutput } as unknown as UIMessage["parts"][number]]
          }
        }
        return [p]
      })
      return changed ? ({ ...m, parts } as UIMessage) : m
    })
    .filter((m) => m.parts.length > 0)
}

/* ------------------------------------------------------------------ *
 * Anthropic prompt caching. The API only caches when explicit
 * cache_control breakpoints are set — without them every step of a long
 * turn re-bills the full history at full input price (the primary driver
 * of rate-limit exhaustion on the Anthropic route). Other providers
 * ignore the anthropic namespace, so this is safe to apply unconditionally.
 *
 * Placement rules (API constraints): max 4 breakpoints per request; a
 * breakpoint caches everything before it INCLUDING tools and system. We
 * use two: one fixed on the system message (covers tools + system), one
 * moving on the last STABLE message of each step — set BEFORE the
 * ephemeral tail (pinned skills, plan reminders) is appended, because
 * that tail is regenerated every step and a breakpoint there would
 * thrash the cache instead of building it.
 * ------------------------------------------------------------------ */
export const ANTHROPIC_EPHEMERAL_CACHE = {
  anthropic: { cacheControl: { type: "ephemeral" as const } },
}

/** mark the LAST message as a cache breakpoint (copy, never mutate) */
export function markStableCachePoint(messages: ModelMessage[]): ModelMessage[] {
  const last = messages[messages.length - 1]
  if (!last) return messages
  const prior = (last as { providerOptions?: Record<string, unknown> }).providerOptions
  const marked = {
    ...last,
    providerOptions: { ...prior, ...ANTHROPIC_EPHEMERAL_CACHE },
  } as ModelMessage
  return [...messages.slice(0, -1), marked]
}

/* ------------------------------------------------------------------ *
 * Resumption summarization — shared by between-turns compaction
 * (compactContext) and mid-turn compaction (compactAccumulated).
 * ------------------------------------------------------------------ */

// RESUMPTION summary, not a state summary. The agent will keep working
// from this text after the original turns are gone — so it must carry
// what "done" looks like and what to do next, or the agent drifts and
// declares victory early (observed repeatedly before this shape).
const RESUMPTION_PROMPT =
  "You compact earlier turns of a conversation between a researcher and their " +
  "research agent into a continuation summary the agent will RESUME WORK FROM. " +
  "FIRST, inside <analysis></analysis> tags, walk the conversation chronologically " +
  "and check yourself: every user request found? every file/artifact touched noted? " +
  "every failure recorded? (The analysis is discarded — only the summary is kept.) " +
  "THEN write the summary so work can continue immediately without the original " +
  "turns. Structure it EXACTLY as:\n" +
  "1. TASK & SUCCESS CRITERIA — the user's overall goal, and what a complete, " +
  "correct result looks like (deliverables, scope, constraints the user set).\n" +
  "2. ALL USER REQUESTS — a chronological list of every distinct thing the user " +
  "asked for or corrected, each in one line, NONE omitted. This is the anti-drift " +
  "record: a request that falls out of this list is forgotten forever.\n" +
  "3. STATE — what is already done; files created/edited with exact paths; sources " +
  "fetched/read (with read depth); key facts and numbers established.\n" +
  "4. DISCOVERIES — decisions made and why; user preferences; approaches that FAILED " +
  "and why (so they are not retried).\n" +
  "5. NEXT STEPS — the specific remaining actions, in priority order; open blockers. " +
  "If an immediate next action was STATED in the conversation, quote it VERBATIM so " +
  "there is no drift in task interpretation.\n" +
  "6. PROMISES — anything the agent told the user it would do that is not yet done, " +
  "quoted closely so the commitment does not drift.\n" +
  "Compact markdown, at most 700 words. Err toward keeping whatever prevents " +
  "duplicate work, a dropped request, or a forgotten commitment. No preamble."

export type SummarizeCall = (system: string, prompt: string) => Promise<string>

export function summarizeCallFor(model: LanguageModel): SummarizeCall {
  return async (system, prompt) => (await generateText({ model, system, prompt })).text
}

/** one summarizer window — sized so the cheap summarizer model never overflows */
const SUMMARY_WINDOW = 100_000

/**
 * Map-reduce summarization: fold the rendered span through the resumption
 * prompt in sequential windows, each fold carrying the previous summary.
 * Replaces a silent `.slice(0, 120_000)` that DROPPED everything past the
 * slice — user requests in that region left context without ever reaching
 * the summarizer, the exact "forgets what I asked" failure.
 */
export async function summarizeLong(
  rendered: string,
  prior: string | null,
  call: SummarizeCall,
  windowSize = SUMMARY_WINDOW,
): Promise<string> {
  let summary = prior
  for (let i = 0; i < rendered.length; i += windowSize) {
    const window = rendered.slice(i, i + windowSize)
    summary = await call(
      RESUMPTION_PROMPT,
      (summary
        ? `EXISTING SUMMARY OF EVEN EARLIER TURNS (fold it in, preserving its TASK and unfinished NEXT STEPS/PROMISES verbatim where still open):\n${summary}\n\n`
        : "") + `TURNS TO COMPACT:\n${window}`,
    )
    // the <analysis> scratchpad improves faithfulness but is working memory,
    // not the record — strip it before the summary is stored or folded
    summary = summary.replace(/<analysis>[\s\S]*?<\/analysis>\s*/gi, "").trim()
  }
  return summary ?? ""
}

/* ------------------------------------------------------------------ *
 * MID-TURN compaction. A single research turn can run hundreds of steps;
 * `accumulated` grows without bound and, before this existed, a context-
 * length overflow was FATAL — and the crash journal then restored the
 * same oversized state, an unrecoverable dead-end.
 * ------------------------------------------------------------------ */

/** real prompt tokens (from step usage) that trigger a mid-turn fold */
export const MIDTURN_COMPACT_TOKENS = 110_000
/** char fallback when the provider reports no usage (~120K tokens) */
export const MIDTURN_COMPACT_CHARS = 480_000
const MIDTURN_KEEP_TAIL = 12

/**
 * Where to cut `accumulated` so the verbatim tail stays protocol-valid:
 * a tail that OPENS with a tool-role message references a tool call that
 * was folded away — every later request would be invalid. Pure, testable.
 */
export function midturnCut(messages: ModelMessage[], keepTail = MIDTURN_KEEP_TAIL): number {
  let cut = Math.max(0, messages.length - keepTail)
  while (cut > 0 && messages[cut]?.role === "tool") cut--
  return cut
}

/** compact rendering of mid-turn step messages for the summarizer */
export function renderModelSpan(span: ModelMessage[]): string {
  return span
    .map((m) => {
      if (typeof m.content === "string") return `${m.role.toUpperCase()}: ${m.content}`
      const bits = (Array.isArray(m.content) ? m.content : []).map((p) => {
        const part = p as unknown as Record<string, unknown> & { type: string }
        if (part.type === "text") return part.text as string
        if (part.type === "tool-call")
          return `[call ${part.toolName}: ${JSON.stringify(part.input ?? part.args ?? {})?.slice(0, 150)}]`
        if (part.type === "tool-result")
          return `[${part.toolName} → ${JSON.stringify(part.output ?? "")?.slice(0, 250)}]`
        return ""
      })
      return `${m.role.toUpperCase()}: ${bits.filter(Boolean).join("\n")}`
    })
    .join("\n\n")
}

/**
 * Fold the older steps of a RUNNING turn into a resumption summary and keep
 * the recent tail verbatim. Returns the input unchanged when there is too
 * little to fold (the caller treats a no-op as "compaction cannot help").
 */
export async function compactAccumulated(
  accumulated: ModelMessage[],
  call: SummarizeCall,
  opts: { keepTail?: number } = {},
): Promise<ModelMessage[]> {
  const cut = midturnCut(accumulated, opts.keepTail ?? MIDTURN_KEEP_TAIL)
  if (cut < 8) return accumulated
  const head = accumulated.slice(0, cut)
  const tail = accumulated.slice(cut)
  const summary = await summarizeLong(renderModelSpan(head), null, call)
  if (!summary.trim()) return accumulated
  return [
    {
      role: "user",
      content:
        "<system-reminder>\nMID-TURN CONTEXT COMPACTION — earlier steps of THIS SAME turn " +
        "were folded into the continuation summary below. Their tool calls really ran and " +
        "their artifacts persist on disk. The TASK and SUCCESS CRITERIA remain binding, the " +
        "NEXT STEPS are still yours to finish, and failed approaches are not to be retried. " +
        "Do NOT redo completed work; continue from where the summary leaves off. The user " +
        "did not write this and cannot see it — do not mention or reply to it.\n\n" +
        summary +
        "\n</system-reminder>",
    },
    ...tail,
  ]
}

function renderForSummary(span: UIMessage[]): string {
  return span
    .map((m) => {
      const bits = m.parts.map((p) => {
        const part = p as Record<string, unknown> & { type: string }
        if (part.type === "text") return part.text as string
        if (part.type.startsWith("tool-")) {
          const name = part.type.replace(/^tool-/, "")
          const out = JSON.stringify(part.output ?? "")
          return `[${name}: ${JSON.stringify(part.input ?? {})?.slice(0, 150)} → ${out.slice(0, 250)}]`
        }
        return ""
      })
      return `${m.role.toUpperCase()}: ${bits.filter(Boolean).join("\n")}`
    })
    .join("\n\n")
}

export interface CompactedContext {
  messages: UIMessage[]
  /** appended to the system prompt when a summary replaced earlier turns */
  systemSuffix: string
  /** approximate size of what will be sent to the model, in chars */
  contextChars: number
}

export async function compactContext(
  db: Database,
  session: string,
  messages: UIMessage[],
  summarizer: LanguageModel | null,
): Promise<CompactedContext> {
  const slim = slimHistory(messages)
  const size = JSON.stringify(slim).length
  if (size <= COMPACT_THRESHOLD || !summarizer) {
    return { messages: slim, systemSuffix: "", contextChars: size }
  }

  const upto = Math.floor(Math.max(0, slim.length - COMPACT_TAIL) / COMPACT_STEP) * COMPACT_STEP
  if (upto < COMPACT_STEP) return { messages: slim, systemSuffix: "", contextChars: size }

  const cached = db
    .query(
      "SELECT upto, summary FROM compactions WHERE session_id = ? AND upto <= ? ORDER BY upto DESC LIMIT 1",
    )
    .get(session, upto) as { upto: number; summary: string } | null

  let summary: string
  if (cached && cached.upto === upto) {
    summary = cached.summary
  } else {
    try {
      const startAt = cached?.upto ?? 0
      const rendered = renderForSummary(slim.slice(startAt, upto))
      // map-reduce over windows: nothing is ever silently dropped (the old
      // single-call path sliced at 120K chars and everything past the slice
      // left context without ever reaching the summarizer)
      summary = await summarizeLong(rendered, cached?.summary ?? null, summarizeCallFor(summarizer))
      db.query(
        "INSERT OR REPLACE INTO compactions (session_id, upto, summary, created_at) VALUES (?, ?, ?, ?)",
      ).run(session, upto, summary, Date.now())
    } catch {
      // summarization is an enhancement — never block the chat on it
      return { messages: slim, systemSuffix: "", contextChars: size }
    }
  }

  let tail = slim.slice(upto)
  if (tail[0]?.role !== "user") {
    // some providers require the first non-system message to be from the user
    tail = [
      {
        id: `${session}:compact-bridge`,
        role: "user",
        parts: [{ type: "text", text: "(continuing from the compacted conversation summarized above)" }],
      } as UIMessage,
      ...tail,
    ]
  }
  const systemSuffix =
    "\n\n# Earlier conversation (compacted)\n" +
    "This conversation is longer than the messages that follow; its earlier turns were " +
    "compacted to this continuation summary. Its TASK and SUCCESS CRITERIA remain binding, " +
    "its NEXT STEPS and PROMISES are still yours to finish, and its failed approaches are " +
    "not to be retried. Resume the work directly — do not ask the user questions the " +
    "summary already answers (only a genuinely NEW user-owned decision justifies asking):\n" +
    summary +
    verbatimRequestsBlock(slim.slice(0, upto))
  return { messages: tail, systemSuffix, contextChars: JSON.stringify(tail).length + systemSuffix.length }
}

/**
 * ALL USER REQUESTS from the compacted span, extracted BY CODE — never by
 * the summarizer. The summary above is a lossy chain (each compaction folds
 * the previous one through a small model); over a multi-hour run that chain
 * degrades exactly the record that must not degrade. The DB keeps the full
 * conversation, so this re-extracts verbatim from the originals every turn.
 */
export function verbatimRequestsBlock(compactedSpan: UIMessage[]): string {
  const textOf = (m: UIMessage) =>
    m.parts
      .filter((p) => p.type === "text")
      .map((p) => (p as { text?: string }).text ?? "")
      .join("\n")
      .trim()
  const requests = compactedSpan
    .filter((m) => m.role === "user")
    .map(textOf)
    .filter((t) => t && !t.startsWith("(continuing from"))
  if (requests.length === 0) return ""
  let lines = requests.map((t, i) => `${i + 1}. ${t.length > 300 ? `${t.slice(0, 300)}…` : t}`)
  // cap the block without ever silently losing the record's SHAPE: when a
  // marathon session outgrows the budget, keep the earliest requests (the
  // mission) and the latest (the current direction), and say what was elided
  if (lines.join("\n").length > 9_000 && lines.length > 15) {
    const head = lines.slice(0, 5)
    const tail = lines.slice(-10)
    lines = [...head, `… (${lines.length - 15} earlier requests elided — the summary above covers them)`, ...tail]
  }
  return (
    "\n\nALL USER REQUESTS in the compacted turns (verbatim, code-extracted — the " +
    "anti-drift record; every one of these remains binding regardless of the summary):\n" +
    lines.join("\n")
  )
}

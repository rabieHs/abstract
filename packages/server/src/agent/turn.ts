import { generateText, type LanguageModel, type UIMessage } from "ai"

/**
 * Turn-finalization guarantees: a persisted assistant turn must never be
 * silent, and must never wedge the session. A provider failure becomes a
 * visible, plain-language message; a tool call the provider abandoned
 * mid-flight becomes an error result (a dangling call with no result makes
 * every later request invalid); a turn that ended on a bare tool call gets
 * a short outcome summary.
 */

/** ChatGPT-plan failures that repeat identically on retry (codes set in providers/chatgpt.ts) */
const CHATGPT_FATAL = /chatgpt_usage_limit|subscription_sharing_usage_limit_exceeded|chatgpt_not_eligible|chatgpt_not_signed_in|chatgpt_signed_out|chatgpt_invalid_user|chatgpt_unsupported/i

export function friendlyProviderError(raw: string): string {
  if (/chatgpt_usage_limit|subscription_sharing_usage_limit_exceeded/i.test(raw)) {
    return "Usage limit reached — your ChatGPT plan's allowance for abstract is used up. Manage usage at https://chatgpt.com/settings/usage, or switch models in Settings, then resend your message."
  }
  if (/chatgpt_not_eligible/i.test(raw)) {
    return "This ChatGPT account can't use its plan in abstract — plan usage needs ChatGPT Plus or Pro. Switch models in Settings, then resend your message."
  }
  if (/chatgpt_not_signed_in|chatgpt_signed_out|chatgpt_invalid_user/i.test(raw)) {
    return "Your ChatGPT sign-in needs renewing — open Settings, choose Continue with ChatGPT, then resend your message."
  }
  return /insufficient_quota|exceeded your current quota|RESOURCE_EXHAUSTED|billing|credit/i.test(raw)
    ? `provider quota or credits exhausted — top up or switch models in Settings, then resend your message. (${raw.slice(0, 200)})`
    : /API key|unauthoriz|permission|401|403/i.test(raw)
      ? `the provider rejected the API key — check it in Settings. (${raw.slice(0, 200)})`
      : /rate.?limit|\b429\b/i.test(raw)
        ? `the provider rate limit stayed saturated even after automatic retries — wait a minute and resend to continue; everything so far is saved. (${raw.slice(0, 200)})`
        : isTransientStreamError(raw)
          ? `the connection to the model provider kept dropping — this turn was interrupted, but everything so far is saved; resend to continue. (${raw.slice(0, 200)})`
          : `provider error — this turn was interrupted; resend to retry. (${raw.slice(0, 300)})`
}

/**
 * Providers surface IN-BAND stream errors as plain objects (e.g. Anthropic's
 * {type:"overloaded_error",message:"Overloaded"}), not Error instances —
 * String() would yield "[object Object]" and defeat classification.
 */
export function errorMessageOf(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === "object" && err !== null) {
    try {
      return JSON.stringify(err)
    } catch {
      return String(err)
    }
  }
  return String(err)
}

/**
 * Failures worth an automatic in-turn resume: the network/stream layer died,
 * not the request itself. Auth, quota and invalid-request errors are FATAL —
 * retrying them would just repeat the failure (or spend money doing it).
 * When the HTTP status is known (AI SDK APICallError), it is authoritative —
 * message-substring matching is only the fallback for wrapped/in-band errors.
 */
export function isTransientStreamError(message: string, statusCode?: number): boolean {
  if (statusCode !== undefined) {
    // 408 timeout / 409 conflict / 429 rate limit / all 5xx (incl. 529
    // overloaded) heal on retry; every other 4xx repeats identically.
    // Quota-exhaustion arrives as 429 but never heals — the message check
    // below still catches it before the status class would retry it.
    if (/insufficient_quota|exceeded your current quota|billing|credit/i.test(message)) return false
    if (CHATGPT_FATAL.test(message)) return false
    return statusCode === 408 || statusCode === 409 || statusCode === 429 || statusCode >= 500
  }
  if (/api key|unauthoriz|permission|insufficient_quota|exceeded your current quota|credit|billing|invalid|\b40[013]\b|context length|too long/i.test(message)) {
    return false
  }
  if (CHATGPT_FATAL.test(message)) return false
  // per-minute rate limits self-heal in seconds ("Please try again in 5.7s") —
  // the most transient failure there is; hard quota/billing is caught above
  return /rate.?limit|\b429\b|try again in|socket|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|network|closed unexpectedly|terminated|fetch failed|premature close|overloaded|server_error|api_error|\b50[0-4]\b|internal server error|bad gateway|service unavailable|gateway timeout/i.test(
    message,
  )
}

/**
 * Context overflow is NOT fatal anymore: it is recoverable-by-compaction.
 * The loop folds the running turn's steps into a resumption summary and
 * resumes once — before this, the turn died and the crash journal restored
 * the same oversized state, an unrecoverable dead-end.
 */
export function isContextLengthError(message: string): boolean {
  return /context length|too long|maximum context|context window|input length.*exceed|exceeds? the.*context/i.test(
    message,
  )
}

/** the provider's own cool-down hint ("Please try again in 5.796s"), when given */
export function retryDelayHintMs(message: string): number | null {
  const m = /try again in ([\d.]+)\s*s/i.exec(message)
  return m ? Math.ceil(parseFloat(m[1]!) * 1000) : null
}

export interface ClassifiedFailure {
  message: string
  /** HTTP status when the error (or any cause in its chain) carries one */
  statusCode?: number
  /** the provider's stated cool-down, from retry-after(-ms) headers */
  retryAfterMs?: number
}

/**
 * Pull the STRUCTURED failure facts out of an error chain. The AI SDK's
 * APICallError carries statusCode + responseHeaders, but our loop used to
 * flatten everything to a message string — so Anthropic's authoritative
 * `retry-after` header was never read and backoff ran blind.
 */
export function classifyFailure(err: unknown): ClassifiedFailure {
  const out: ClassifiedFailure = { message: errorMessageOf(err) }
  let cur: unknown = err
  for (let depth = 0; cur && typeof cur === "object" && depth < 6; depth++) {
    const o = cur as {
      statusCode?: unknown
      status?: unknown
      responseHeaders?: Record<string, string>
      cause?: unknown
    }
    if (out.statusCode === undefined && typeof o.statusCode === "number") out.statusCode = o.statusCode
    if (out.statusCode === undefined && typeof o.status === "number") out.statusCode = o.status
    if (out.retryAfterMs === undefined && o.responseHeaders) {
      const h = Object.fromEntries(
        Object.entries(o.responseHeaders).map(([k, v]) => [k.toLowerCase(), v]),
      )
      const ms = parseFloat(h["retry-after-ms"] ?? "")
      if (Number.isFinite(ms)) out.retryAfterMs = Math.ceil(ms)
      else if (h["retry-after"]) {
        const s = parseFloat(h["retry-after"])
        if (Number.isFinite(s)) out.retryAfterMs = Math.ceil(s * 1000)
        else {
          const at = Date.parse(h["retry-after"])
          if (!Number.isNaN(at)) out.retryAfterMs = Math.max(0, at - Date.now())
        }
      }
    }
    cur = o.cause
  }
  return out
}

/* ------------------------------------------------------------------ *
 * Tool-call REPAIR — the harness absorbs mechanical model slips instead
 * of spending a round-trip on each (observed live: 'search_Scholar'
 * case drift; '<parameter name="queries">…' scaffolding leaked into a
 * field; a JSON array encoded as a string). Repairs FORM only, never
 * content: unambiguous name remaps and shape coercions, or nothing.
 * ------------------------------------------------------------------ */

/** unique case-insensitive tool-name match, else null */
export function repairToolName(requested: string, available: string[]): string | null {
  const lower = requested.toLowerCase().trim()
  const matches = available.filter((n) => n.toLowerCase() === lower)
  return matches.length === 1 ? matches[0]! : null
}

/**
 * Mechanical input repair: strip leaked <parameter> scaffolding from string
 * values, and where the schema expects an ARRAY but a string arrived, parse
 * a JSON-encoded array or wrap the single value. Returns the repaired JSON
 * string, or null when nothing (safely) repairable.
 */
export function repairToolInput(inputJson: string, arrayFields: Set<string>): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(inputJson)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null
  const obj = parsed as Record<string, unknown>
  let changed = false
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v !== "string") continue
    let s = v
    if (/<\/?parameter[^>]*>/i.test(s)) {
      s = s.replace(/<\/?parameter[^>]*>/gi, "").trim()
      changed = true
    }
    if (arrayFields.has(k)) {
      let arr: unknown = null
      const t = s.trim()
      if (t.startsWith("[")) {
        try {
          arr = JSON.parse(t)
        } catch {
          /* not valid JSON — wrap below */
        }
      }
      obj[k] = Array.isArray(arr) ? arr : [t]
      changed = true
    } else if (s !== v) {
      obj[k] = s
    }
  }
  return changed ? JSON.stringify(obj) : null
}

/** hard ceiling on any single wait — a stall must never look like a hang */
export const MAX_BACKOFF_MS = 60_000

/**
 * Backoff for the outer resume loop, computed from CONSECUTIVE failures
 * (progress resets that counter) — never from the loop's attempt index,
 * which also counts stop-gate nudges and successful resumes and used to
 * produce uncapped multi-minute stalls (attempt=10 → ~13.7 min).
 * A provider-stated cool-down (header or message hint) is authoritative,
 * padded per consecutive failure since a saturated window drains slowly.
 */
export function computeBackoffMs(
  consecutiveFailures: number,
  providerHintMs: number | null,
  jitter: number = Math.random(),
): number {
  const n = Math.max(1, consecutiveFailures)
  const base =
    providerHintMs != null && providerHintMs >= 0
      ? providerHintMs + 1000 * n
      : 800 * 2 ** n + jitter * 400
  return Math.min(MAX_BACKOFF_MS, Math.max(0, Math.round(base)))
}

/** tool calls that never got a result are converted to error results */
export function sanitizeToolParts(parts: UIMessage["parts"]): UIMessage["parts"] {
  return parts.map((p) => {
    if (!p.type.startsWith("tool-") && p.type !== "dynamic-tool") return p
    const t = p as { state?: string; input?: unknown }
    if (t.state === "output-available" || t.state === "output-error") return p
    return {
      ...p,
      state: "output-error",
      input: t.input ?? {},
      errorText: "interrupted — the provider failed before this tool call finished",
    } as UIMessage["parts"][number]
  })
}

/** synchronous pass: everything that must be true BEFORE first persistence */
export function immediateTurnParts(
  parts: UIMessage["parts"],
  streamError: string | null,
): { parts: UIMessage["parts"]; needsSummary: boolean } {
  const out = sanitizeToolParts(parts)
  const hasText = out.some((p) => p.type === "text" && (p as { text?: string }).text?.trim())
  const hasTool = out.some((p) => p.type.startsWith("tool-") || p.type === "dynamic-tool")
  if (streamError) {
    return { parts: [...out, { type: "text", text: `⚠ ${streamError}` }], needsSummary: false }
  }
  if (!hasText && hasTool) return { parts: out, needsSummary: true }
  if (!hasText && out.length > 0) {
    // reasoning-only / step-only turn: still not allowed to be silent
    return {
      parts: [...out, { type: "text", text: "⚠ the model ended this turn without a reply — resend to retry." }],
      needsSummary: false,
    }
  }
  return { parts: out, needsSummary: false }
}

/** post-persistence pass: a 1-3 sentence outcome summary for tool-only turns */
export async function summarizeToolOnlyTurn(
  parts: UIMessage["parts"],
  model: LanguageModel,
  lastUserText: string,
): Promise<string | null> {
  try {
    const digest = parts
      .filter((p) => p.type.startsWith("tool-"))
      .map((p) => {
        const t = p as { type: string; input?: unknown; output?: unknown }
        return `${t.type.replace(/^tool-/, "")}: ${JSON.stringify(t.input ?? {})?.slice(0, 200)} → ${JSON.stringify(t.output ?? "")?.slice(0, 400)}`
      })
      .join("\n")
    const { text } = await generateText({
      model,
      prompt:
        `The user asked: "${lastUserText.slice(0, 500)}"\nAn agent ran these tools:\n${digest}\n\n` +
        "In 1-3 plain sentences, tell the user what was done and the outcome. No preamble.",
    })
    return text.trim() || null
  } catch {
    return null
  }
}

/** convenience wrapper (kept for tests): immediate pass + summary in one step */
export async function finalizeTurnParts(
  parts: UIMessage["parts"],
  opts: { streamError: string | null; model: LanguageModel; lastUserText: string },
): Promise<UIMessage["parts"]> {
  const { parts: out, needsSummary } = immediateTurnParts(parts, opts.streamError)
  if (!needsSummary) return out
  const text = await summarizeToolOnlyTurn(out, opts.model, opts.lastUserText)
  return text ? [...out, { type: "text", text }] : out
}

/**
 * Merge the client's POSTed history with the server-side snapshot. The client
 * can be stale: interleaved steering segments, trailing undelivered
 * interjections and tool-only summaries exist only in the DB (the client may
 * never have refetched before sending). The DB wins for everything except the
 * genuinely NEW trailing user message(s) the client just added. When the
 * client's last user message equals the DB's trailing user message, nothing is
 * appended — that is the auto-continue of an already-persisted interjection.
 */
export function mergeClientHistory(dbMsgs: UIMessage[], posted: UIMessage[]): UIMessage[] {
  if (dbMsgs.length === 0) return posted
  const textOf = (m: UIMessage) =>
    m.parts.filter((p) => p.type === "text").map((p) => (p as { text?: string }).text ?? "").join("\n")
  const lastAssistant = posted.map((m) => m.role).lastIndexOf("assistant")
  let tail = posted.slice(lastAssistant + 1).filter((m) => m.role === "user")
  // element-wise dedupe against the DB's trailing run of user rows: the client
  // may re-post already-persisted steers (after a refetch) with a NEW message
  // after them — drop exactly the overlap, keep the rest
  const dbUserTail: UIMessage[] = []
  for (let i = dbMsgs.length - 1; i >= 0 && dbMsgs[i]!.role === "user"; i--) dbUserTail.unshift(dbMsgs[i]!)
  for (let k = Math.min(dbUserTail.length, tail.length); k > 0; k--) {
    const suffix = dbUserTail.slice(dbUserTail.length - k)
    if (suffix.every((d, j) => textOf(d) === textOf(tail[j]!))) {
      tail = tail.slice(k)
      break
    }
  }
  return [...dbMsgs, ...tail]
}

/* ------------------------------------------------------------------ *
 * the stop-gate — harness-enforced turn completion (model-agnostic)
 * ------------------------------------------------------------------ */

/**
 * Some models end their turn at a satisfying milestone ("I'm moving on to
 * screening now.") while their own plan is still open — deferring work to a
 * "next turn" that never comes. The harness, not the prompt, closes that gap:
 * a turn that (a) stopped normally, (b) did real tool work, and (c) left its
 * own plan open, is continued in place. A turn that only TALKED — proposed a
 * plan, asked a question, explained a blocker — is never continued, which
 * keeps propose-and-confirm working styles fully intact.
 */
export function shouldContinueTurn(opts: {
  finishReason: string | undefined
  ranRealTools: boolean
  openItems: number
  nudges: number
  maxNudges: number
}): boolean {
  return (
    opts.finishReason === "stop" &&
    opts.ranRealTools &&
    opts.openItems > 0 &&
    opts.nudges < opts.maxNudges
  )
}

/**
 * Injection convention: EVERY harness message rides a
 * self-concealing <system-reminder> block — the model acts on it silently
 * and never answers it as if the user spoke (observed failure without
 * this: the agent replied "You're right — I misspoke" to a hidden check).
 * Every steer below goes through this wrapper.
 */
export function systemReminder(text: string): string {
  return (
    "<system-reminder>\n" +
    text +
    "\nThis is an automated harness message — the user did NOT write it and cannot see it. " +
    "Do not mention it, quote it, or reply to it; silently act on it and continue.\n" +
    "</system-reminder>"
  )
}

/* ------------------------------------------------------------------ *
 * stop-gate v2 — ADJUDICATED stop (the C5/P1.3 free-exit fix).
 * v1 continued only on open plan items; clearing the plan (or never
 * making one) was a free exit even when the model's own closing words
 * promised more work. v2 adjudicates three ways:
 *   - open plan → continue (as before), but a stated user-blocker is a
 *     LEGITIMATE stop that passes without burning nudges (the escape
 *     ralph-wiggum-style loops lack);
 *   - empty plan + a closing deferred-work promise → continue: the work
 *     happens NOW, because no later turn comes unless the user speaks;
 *   - nudges exhausted with open items → the harness gives up VISIBLY
 *     (a persisted notice), never silently.
 * ------------------------------------------------------------------ */

/** the last assistant TEXT of the run so far — what the stop-gate adjudicates */
export function lastAssistantText(messages: { role: string; content: unknown }[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role !== "assistant") continue
    if (typeof m.content === "string") {
      if (m.content.trim()) return m.content.trim()
    } else if (Array.isArray(m.content)) {
      const text = m.content
        .filter((p) => (p as { type?: string }).type === "text")
        .map((p) => (p as { text?: string }).text ?? "")
        .join("\n")
        .trim()
      if (text) return text
    }
  }
  return ""
}

/** a turn whose closing words PROMISE more work has not finished */
export function endsWithDeferredWork(text: string): boolean {
  const tail = text.slice(-600)
  return /\b(I(['’]| wi)ll (now|next|then|start|begin|proceed)|next,? I (will|am going)|moving on to|let me (now|next)|I am (now )?(going|about) to|(now|next),? I(['’]ll| will))\b/i.test(
    tail,
  )
}

/** the model states a decision only the user can make — a legitimate stop */
export function statesUserBlocker(text: string): boolean {
  const tail = text.slice(-700)
  if (/(which|what|should I|do you (want|prefer|need)|would you (like|prefer|rather)|shall I)[^.!\n]{0,120}\?/i.test(tail)) return true
  return /\b(blocked on|waiting for your|need(s)? your (choice|decision|approval|input|go[- ]ahead)|your call|let me know (which|whether|if|how))\b/i.test(
    tail,
  )
}

export type StopDecision =
  | { kind: "end" }
  | { kind: "continue-open-plan" }
  | { kind: "continue-deferred-promise" }
  | { kind: "gave-up"; openItems: number }

export function adjudicateStop(opts: {
  finishReason: string | undefined
  ranRealTools: boolean
  openItems: number
  nudges: number
  maxNudges: number
  lastText: string
}): StopDecision {
  if (opts.finishReason !== "stop" || !opts.ranRealTools) return { kind: "end" }
  // BLOCKED exit: a concrete user-owned decision passes the gate freely —
  // collaborative styles must never be nudged through their own questions
  if (statesUserBlocker(opts.lastText)) return { kind: "end" }
  if (opts.openItems > 0) {
    if (opts.nudges < opts.maxNudges) return { kind: "continue-open-plan" }
    return { kind: "gave-up", openItems: opts.openItems }
  }
  if (endsWithDeferredWork(opts.lastText) && opts.nudges < opts.maxNudges) {
    return { kind: "continue-deferred-promise" }
  }
  return { kind: "end" }
}

/**
 * Reply-vs-artifact honesty (observed live): the closing message claimed a
 * comparison table while the draft on disk contained none. Deterministically
 * detectable — and corrected in-turn, never shipped.
 */
export function claimsAbsentTable(lastText: string): boolean {
  // stating the table's ABSENCE is honesty, not a claim — never re-fire on it
  if (/(no|without|lacks? a?|absence of|not (include|contain|build)) [^.]{0,20}?\btable\b|\btable\b[^.]{0,40}(does not exist|was not|absent|missing)/i.test(lastText)) {
    return false
  }
  return /(comparison|summary|overview) table|\btable\b (of|across|comparing)|with a \btable\b/i.test(lastText)
}

export function artifactMismatchNudge(file: string): string {
  return systemReminder(
    "Your reply claims a comparison " +
    `table, but the draft file ${file} contains NO table. Either add it now (call ` +
    "draft_section again on the same document and describe the table you want — it will be " +
    "built and cite-checked cell by cell), or correct your reply to state plainly that the " +
    "document has no table. Never claim an artifact that does not exist.",
  )
}

/** nudge for the empty-plan deferred-promise case — model context only */
export function promiseNudge(lastText: string): string {
  const quoted = lastText.slice(-200).replace(/\s+/g, " ").trim()
  return systemReminder(
    "Your last " +
    `message ends by promising further work ("…${quoted}") but the turn was about to ` +
    "end. Deferred work never happens — no later turn comes unless the user speaks. " +
    "Do that work NOW in this same turn, or state plainly that the task is complete " +
    "and why nothing remains.",
  )
}

/** the VISIBLE notice when the harness stops nudging with work still open */
export function gaveUpNotice(openItems: { content: string }[]): string {
  const list = openItems
    .slice(0, 5)
    .map((t) => `“${t.content}”`)
    .join(", ")
  return (
    `\n\n⚠ stopped after repeated automatic continuations with ${openItems.length} plan ` +
    `item(s) still open: ${list}${openItems.length > 5 ? ", …" : ""} — everything so far ` +
    "is saved; send a message to continue this work."
  )
}

/** the continuation message — model context only, never shown or persisted */
export function continuationNudge(openItems: { content: string; status: string }[]): string {
  const list = openItems.map((t) => `- [${t.status}] ${t.content}`).join("\n")
  return systemReminder(
    "Your working plan still has open items:\n" +
      list +
      "\nContinue executing them now, within this same turn. If you are genuinely " +
      "blocked, or the next step needs a decision only the user can make, say so " +
      "plainly and stop instead.",
  )
}

/* ------------------------------------------------------------------ *
 * IN-TURN task reinforcement — the mechanism that lets a long run hold
 * its goal without drifting.
 *
 * The harness re-attaches the live plan to the model DURING a turn — once
 * enough steps pass with no plan update, and then periodically — not only at
 * turn end. Our stop-gate fired only at turn end, so mid-turn the model could
 * wander off the plan with nothing pulling it back. This is a self-concealing
 * SIGNAL, not a mandate (consistent with the rest of the harness): it states
 * the open items and lets the model decide.
 * ------------------------------------------------------------------ */
export const PLAN_REMINDER_AFTER_STEPS = 8 // steps of plan silence before the first reminder
export const PLAN_REMINDER_INTERVAL = 4 // steps between subsequent reminders

/** whether an in-turn plan reminder should fire this step, given counters */
export function shouldRemindPlan(opts: {
  openItems: number
  stepsSincePlanTouch: number
  stepsSinceReminder: number
}): boolean {
  return (
    opts.openItems > 0 &&
    opts.stepsSincePlanTouch >= PLAN_REMINDER_AFTER_STEPS &&
    opts.stepsSinceReminder >= PLAN_REMINDER_INTERVAL
  )
}

/** the reminder text — kept out of the persisted transcript, model-context only */
export function planReminder(
  openItems: { content: string; status: string }[],
  budgetNote?: string,
): string {
  const list = openItems.map((t) => `- [${t.status}] ${t.content}`).join("\n")
  return systemReminder(
    "Do not mention this reminder to the user. Your working plan still has open items:\n" +
      list +
      "\nKeep working through them in THIS turn. Mark items done with update_plan as you " +
      "finish each, add any newly discovered work, and keep exactly one item in_progress. " +
      "Only stop if you are blocked on a decision that is genuinely the user's to make." +
      // budget awareness (C4): pacing, never cutting — core work is protected
      // and the budget rolls into a fresh segment when genuinely needed
      (budgetNote ? `\n[${budgetNote}]` : ""),
  )
}

/* ------------------------------------------------------------------ *
 * mid-run steering — user messages that arrived WHILE the agent worked
 * ------------------------------------------------------------------ */

export interface Interjection {
  text: string
  /** the tool call whose result carried this message to the model */
  afterToolCallId: string
}

export interface ReplySegment {
  role: "assistant" | "user"
  parts: UIMessage["parts"]
}

/**
 * Split one assistant turn into the interleaved sequence it really was:
 * assistant work → user interjection(s) → assistant continuation → …
 * Pure and total: no interjections → one assistant segment, order is
 * preserved exactly, nothing is ever dropped. Interjections that were never
 * delivered (arrived after the last step) come back in `undelivered`.
 */
export function interleaveInterjections(
  parts: UIMessage["parts"],
  delivered: Interjection[],
): { segments: ReplySegment[] } {
  if (delivered.length === 0) {
    return { segments: parts.length ? [{ role: "assistant", parts }] : [] }
  }
  const byTool = new Map<string, string[]>()
  for (const d of delivered) {
    const arr = byTool.get(d.afterToolCallId) ?? []
    arr.push(d.text)
    byTool.set(d.afterToolCallId, arr)
  }
  const segments: ReplySegment[] = []
  let cur: UIMessage["parts"] = []
  for (const p of parts) {
    cur.push(p)
    const toolCallId = (p as { toolCallId?: string }).toolCallId
    if (p.type.startsWith("tool-") && toolCallId && byTool.has(toolCallId)) {
      segments.push({ role: "assistant", parts: cur })
      for (const text of byTool.get(toolCallId)!) {
        segments.push({ role: "user", parts: [{ type: "text", text }] })
      }
      byTool.delete(toolCallId)
      cur = []
    }
  }
  if (cur.length) segments.push({ role: "assistant", parts: cur })
  // anything left in byTool references a tool part that never appeared —
  // impossible in practice, but never lose a user's words over it
  for (const texts of byTool.values()) {
    for (const text of texts) segments.push({ role: "user", parts: [{ type: "text", text }] })
  }
  return { segments }
}

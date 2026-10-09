import { generateObject, type LanguageModel } from "ai"
import { z } from "zod"

/**
 * The entailment verifier — Abstract's load-bearing component.
 *
 * Given a claim and the passage(s) it cites, decide whether the passages
 * actually support the claim. Two layers:
 *  1. LLM judgment with strict JSON output.
 *  2. A deterministic gate: a "supported" verdict MUST carry a verbatim
 *     quote from one of the passages (checked by string containment after
 *     whitespace normalization). No quote → downgraded to "partial".
 *     The verifier's own output is never trusted blindly.
 */

export type Verdict = "supported" | "partial" | "unsupported"

export interface VerifyResult {
  verdict: Verdict
  /** verbatim evidence quotes (verified server-side), if any */
  quotes: string[]
  /** one-sentence rationale from the judge */
  rationale: string
  /** true if the judge said "supported" but failed the verbatim-quote gate */
  downgraded: boolean
}

const JudgeOutput = z.object({
  verdict: z.enum(["supported", "partial", "unsupported"]),
  quotes: z
    .array(z.string())
    .describe(
      "1-3 verbatim substrings of the passages that together prove the claim; empty if not supported",
    ),
  rationale: z.string().describe("one short sentence explaining the verdict"),
})

const SYSTEM = `You are a strict scientific fact-checker. You judge whether a CLAIM is supported by the given source PASSAGES — nothing else. Rules:

- "supported": every part of the claim (entities, direction of effect, numbers, hedging strength) follows from the passages. You MUST copy 1-3 verbatim quotes (exact substrings of the passages) that together carry the key evidence — one quote per distinct fact in the claim.
- "partial": the passages are on-topic and support part of the claim, but some part (a number, a qualifier, scope, causality) is not established.
- "unsupported": the passages do not establish the claim, contradict it, or the claim overstates them.

Be adversarial. Numbers must match exactly. A claim stronger than the evidence ("proves" vs "suggests") is NOT supported. If unsure, choose the weaker verdict. Never invent a quote — it must be copy-pasted from a passage.`

function normalize(s: string): string {
  return s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
}

export function quoteIsVerbatim(quote: string, passages: string[]): boolean {
  const q = normalize(quote)
  if (q.length < 10) return false
  return passages.some((p) => normalize(p).includes(q))
}

export async function verifyClaim(
  model: LanguageModel,
  claim: string,
  passages: string[],
): Promise<VerifyResult> {
  const { object } = await generateObject({
    // inner calls need the lead loop's resilience: retry connection-class failures
    maxRetries: 8,
    model,
    schema: JudgeOutput,
    system: SYSTEM,
    prompt: `CLAIM:\n${claim}\n\nPASSAGES:\n${passages
      .map((p, i) => `[${i + 1}] ${p}`)
      .join("\n\n")}`,
  })

  let verdict: Verdict = object.verdict
  let downgraded = false
  if (verdict === "supported") {
    const ok =
      object.quotes.length > 0 && object.quotes.every((q) => quoteIsVerbatim(q, passages))
    if (!ok) {
      verdict = "partial"
      downgraded = true
    }
  }
  return { verdict, quotes: object.quotes, rationale: object.rationale, downgraded }
}


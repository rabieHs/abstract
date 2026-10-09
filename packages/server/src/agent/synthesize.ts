import { generateObject, type LanguageModel } from "ai"
import { z } from "zod"
import type { Database, Workspace } from "@abstract/core"
import { hybridSearch, type SearchHit } from "@abstract/ingest"
import { isOpened } from "./draft.ts"

/**
 * Cross-source synthesis — the leap from "what each paper says" to insight:
 * where papers AGREE, where they CONTRADICT each other (each side grounded in
 * a real passage), and what the corpus leaves OPEN. This is the analytical
 * lens; the verified prose still goes through draft_section afterward, with
 * this analysis passed in as its brief.
 *
 * Integrity: every stance/agreement must cite a real retrieved chunk id
 * (structural gate). The tension framing and gaps are analysis — the agent's
 * own reading — and are surfaced as such, never dressed as sourced fact.
 */

const SynthOut = z.object({
  agreements: z
    .array(
      z.object({
        point: z.string().describe("a claim multiple sources support"),
        cites: z.array(z.string()).min(1).describe("chunk ids, from >=2 different sources ideally"),
      }),
    )
    .describe("points where the literature converges"),
  tensions: z
    .array(
      z.object({
        question: z.string().describe("the specific point of disagreement or divergence"),
        positions: z
          .array(
            z.object({
              stance: z.string().describe("what this source claims on the question"),
              cites: z.array(z.string()).min(1).describe("chunk ids supporting this stance"),
            }),
          )
          .min(2)
          .describe("two or more opposing/diverging positions, each grounded"),
        nature: z
          .string()
          .describe("why they diverge: different assumptions, metrics, scope, methods, or an open dispute"),
      }),
    )
    .describe("genuine contradictions or unresolved divergences between sources — the most valuable output"),
  gaps: z
    .array(
      z.object({
        statement: z
          .string()
          .describe(
            "what the corpus does NOT settle — a specific missing thing, never an absolute " +
            "('no one has…' is banned; the evidence only covers the sources at hand)",
          ),
        open_question: z.string().describe("the researchable question this gap implies"),
      }),
    )
    .describe("what is missing, untested, or assumed — where a new contribution could sit"),
})

/**
 * A gap claim is only as good as the searches that tried to CLOSE it
 * (Wohlin: a gap that might be a missed cluster demands a new search
 * before being declared). Each gap is cross-checked against the recorded
 * search log; one with no matching counter-search is an unverified hunch,
 * and the result says so.
 */
export interface GapFinding {
  statement: string
  open_question: string
  /** auto-filled corpus bound — the honest scope of any absence claim */
  boundary: string
  /** logged searches that plausibly tried to close this gap */
  counter_searches: { query: string; hits: number }[]
  status: "search-bounded" | "unverified-hunch"
}

const GAP_STOP = new Set([
  "the", "and", "for", "with", "from", "this", "that", "into", "when", "what",
  "does", "not", "are", "how", "why", "which", "their", "there", "have", "been",
  "about", "across", "between", "under", "over", "these", "those", "corpus",
  "literature", "studies", "study", "paper", "papers", "work", "works", "research",
])

export function gapTokens(text: string): Set<string> {
  return new Set(
    text.toLowerCase().split(/[^a-z0-9-]+/).filter((w) => w.length >= 4 && !GAP_STOP.has(w)),
  )
}

/** logged searches sharing ≥2 content tokens with the gap statement */
export function gapCounterSearches(
  db: Database,
  statement: string,
  limit = 5,
): { query: string; hits: number }[] {
  const want = gapTokens(statement)
  if (want.size === 0) return []
  const rows = db
    .query("SELECT query, hits FROM searches ORDER BY id DESC LIMIT 300")
    .all() as { query: string; hits: number }[]
  const out: { query: string; hits: number }[] = []
  const seen = new Set<string>()
  for (const r of rows) {
    if (seen.has(r.query)) continue
    let shared = 0
    for (const t of gapTokens(r.query)) if (want.has(t)) shared++
    if (shared >= 2) {
      out.push(r)
      seen.add(r.query)
      if (out.length >= limit) break
    }
  }
  return out
}

export interface SynthesisResult {
  agreements: { point: string; cites: string[] }[]
  tensions: { question: string; positions: { stance: string; cites: string[]; source: string }[]; nature: string }[]
  gaps: GapFinding[]
  /** present when gaps lack counter-searches — the close-it-first teaching */
  gap_note?: string
  sourcesCovered: string[]
  /** publication timeline of the synthesized corpus (evolution over time) */
  timeline: { source: string; year: number | null }[]
  passages: { chunkId: string; source: string; page: number | null; grade: string; text: string }[]
}

export async function synthesizeSources(
  db: Database,
  workspace: Workspace,
  opts: {
    topic: string
    queries: string[]
    model: LanguageModel
    embedder?: ((values: string[]) => Promise<number[][]>) | null
  },
): Promise<SynthesisResult | { error: string }> {
  // 1. retrieve across the whole library — round-robin across query hit-lists
  // so every query contributes and no two sources dominate the evidence.
  // Synthesis, like drafting, works only over what the agent has OPENED:
  // insight across papers nobody read is not insight.
  const openedCache = new Map<string, boolean>()
  const citable = (p: string) => {
    if (!openedCache.has(p)) openedCache.set(p, isOpened(db, workspace, p))
    return openedCache.get(p)!
  }
  const excludedUnread = new Set<string>()
  const perQuery: SearchHit[][] = []
  for (const q of opts.queries) {
    const raw = await hybridSearch(db, q, 12, opts.embedder)
    for (const h of raw) if (!citable(h.sourcePath)) excludedUnread.add(h.sourcePath)
    perQuery.push(raw.filter((h) => citable(h.sourcePath)))
  }
  const seen = new Map<string, SearchHit>()
  const cap = Math.min(48, Math.max(28, 12 * opts.queries.length))
  const maxLen = Math.max(0, ...perQuery.map((l) => l.length))
  outer: for (let i = 0; i < maxLen; i++)
    for (const list of perQuery) {
      const h = list[i]
      if (h && !seen.has(h.chunkId)) {
        seen.set(h.chunkId, h)
        if (seen.size >= cap) break outer
      }
    }
  const hits = [...seen.values()]
  const sources = new Set(hits.map((h) => h.sourcePath))
  if (hits.length === 0) {
    return {
      error:
        excludedUnread.size > 0
          ? `no passages from OPENED sources — ${excludedUnread.size} relevant source(s) were never read (` +
            [...excludedUnread].slice(0, 5).join(", ") +
            (excludedUnread.size > 5 ? ", …" : "") +
            "). Read them first (read_pages / read_source / view_page / ask_document, with notes), then synthesize."
          : "no passages found — ingest and read the sources first, then synthesize",
    }
  }
  if (sources.size < 2) {
    return {
      error:
        "synthesis needs at least two sources to compare — only one matched. Ingest/read more " +
        "papers on this topic, or use draft_section for a single-source write-up.",
    }
  }
  const byId = new Map(hits.map((h) => [h.chunkId, h]))
  const allowed = new Set(hits.map((h) => h.chunkId))

  // 2. grouped evidence, so the model reasons per-source then across sources
  const bySrc = new Map<string, SearchHit[]>()
  for (const h of hits) {
    const arr = bySrc.get(h.sourcePath) ?? []
    arr.push(h)
    bySrc.set(h.sourcePath, arr)
  }
  const evidence = [...bySrc.entries()]
    .map(([src, hs]) => {
      const grade = hs[0]!.grade
      const passages = hs
        .map((h) => `  [${h.chunkId}]${h.page ? ` (p.${h.page})` : ""} ${h.text.replace(/\s+/g, " ").slice(0, 500)}`)
        .join("\n")
      return `SOURCE: ${src} (grade: ${grade})\n${passages}`
    })
    .join("\n\n")

  // 3. synthesis pass
  let object: z.infer<typeof SynthOut>
  try {
    const r = await generateObject({
      // inner calls need the lead loop's resilience: retry connection-class failures
      maxRetries: 8,
      model: opts.model,
      schema: SynthOut,
      prompt:
        `You are synthesizing the literature on: ${opts.topic}\n\n` +
        "Go beyond summary. Read ACROSS the sources below and produce:\n" +
        "- AGREEMENTS: claims multiple sources converge on.\n" +
        "- TENSIONS: genuine contradictions or divergences — the same question answered " +
        "differently by different papers. This is the point of the exercise: name the " +
        "disagreement precisely, give each side with its grounding passage, and explain WHY " +
        "they diverge (different metric, assumption, scope, method, or a real open dispute). " +
        "Do not manufacture tensions that are not there; if two papers simply address " +
        "different things, that is a gap, not a tension.\n" +
        "- GAPS: what the corpus does NOT settle — untested conditions, unstated assumptions, " +
        "questions left open. This is where a new contribution could sit.\n\n" +
        "RULES: every agreement and every stance must cite chunk ids from the passages below. " +
        "Never cite an id that is not shown. Never invent a finding not in a passage.\n\n" +
        `PASSAGES (grouped by source):\n${evidence}`,
    })
    object = r.object
  } catch (err) {
    return { error: `synthesis failed: ${err instanceof Error ? err.message : String(err)}` }
  }

  // 4. structural gate: drop any cite that is not a real retrieved chunk
  const clean = (ids: string[]) => ids.filter((c) => allowed.has(c))
  const srcOf = (c: string) => byId.get(c)?.sourcePath ?? "unknown"
  const agreements = object.agreements
    .map((a) => ({ point: a.point, cites: clean(a.cites) }))
    .filter((a) => a.cites.length > 0)
  const tensions = object.tensions
    .map((t) => ({
      question: t.question,
      nature: t.nature,
      positions: t.positions
        .map((p) => ({ stance: p.stance, cites: clean(p.cites), source: srcOf(clean(p.cites)[0] ?? "") }))
        .filter((p) => p.cites.length > 0),
    }))
    .filter((t) => t.positions.length >= 2) // a tension needs >=2 grounded sides

  // 5. gap gate: bound every gap to the corpus and cross-check it against
  // the recorded search log — an absence claim nobody tried to close is a
  // hunch, and it is labeled as one
  const boundary = `within the ${sources.size} sources synthesized here`
  const gaps: GapFinding[] = object.gaps.map((g) => {
    const counter = gapCounterSearches(db, `${g.statement} ${g.open_question}`)
    return {
      statement: g.statement,
      open_question: g.open_question,
      boundary,
      counter_searches: counter,
      status: counter.length > 0 ? "search-bounded" : "unverified-hunch",
    }
  })
  const hunches = gaps.filter((g) => g.status === "unverified-hunch").length

  // 6. publication timeline — the corpus ordered in time, so "how did this
  // evolve" and old-vs-new framing come from data, not vibes
  const timeline = [...sources]
    .map((src) => {
      const row = db.query("SELECT csl_json FROM sources WHERE path = ?").get(src) as {
        csl_json: string | null
      } | null
      let year: number | null = null
      try {
        year =
          (JSON.parse(row?.csl_json ?? "null") as { issued?: { "date-parts"?: number[][] } } | null)
            ?.issued?.["date-parts"]?.[0]?.[0] ?? null
      } catch {
        /* unparseable CSL — year unknown */
      }
      return { source: src, year }
    })
    .sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999))

  return {
    agreements,
    tensions,
    gaps,
    ...(hunches > 0
      ? {
          gap_note:
            `${hunches} gap(s) have NO logged counter-search — a gap you did not try to close ` +
            "is a search failure, not a finding. Run targeted searches (search_scholar / " +
            "snowball) for each, then re-synthesize; until then present them as open " +
            "questions, hedged to the boundary, never as established gaps.",
        }
      : {}),
    sourcesCovered: [...sources],
    timeline,
    passages: hits.map((h) => ({
      chunkId: h.chunkId,
      source: h.sourcePath,
      page: h.page,
      grade: h.grade,
      text: h.text.slice(0, 600),
    })),
  }
}

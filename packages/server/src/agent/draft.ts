import { generateObject, generateText, type LanguageModel } from "ai"
import { z } from "zod"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Database, Workspace } from "@abstract/core"
import { hybridSearch, type SearchHit } from "@abstract/ingest"
import { verifyClaim } from "@abstract/verifier"
import { readNote } from "./notes.ts"
import { renderDraftHtml } from "./html.ts"
import { isTransientStreamError } from "./turn.ts"

/** a source is CITABLE only once the agent has actually opened it — pages
 *  read (read_pages), a text read (read_source), a visual read (view_page /
 *  ask_document), or a note taken. Downloading indexes the text for search, but a real
 *  researcher's download contributes nothing to their writing until they read
 *  it; the platform mirrors that. */
export function isOpened(db: Database, workspace: Workspace, sourcePath: string): boolean {
  const row = db
    .query("SELECT COUNT(*) AS n FROM read_log WHERE source_path = ?")
    .get(sourcePath) as { n: number } | null
  if (row && row.n > 0) return true
  return readNote(workspace, sourcePath) != null
}

export type SentenceVerdict = "supported" | "partial" | "unsupported" | "uncited"

export interface DraftSentence {
  text: string
  cites: string[]
  verdict: SentenceVerdict
  quotes: string[]
  /** cites the writer invented that failed the structural gate */
  invalidCites: string[]
  /** section heading that starts immediately before this sentence, if any */
  heading: string | null
  /** revision mode: true when this sentence changed vs the previous draft */
  revised?: boolean
  /** block structure: prose (default), list item, or sub-heading — any
   *  structure, verified the same (sub-headings carry no claims) */
  block?: "p" | "li" | "h3"
  ordered?: boolean
  /** starts a new paragraph (a blank line preceded it in the writer's output) */
  newPara?: boolean
}

/** a verified table cell — a mini-sentence with its own verdict */
export interface DraftCell {
  text: string
  cites: string[]
  verdict: SentenceVerdict
  quotes: string[]
  invalidCites: string[]
}

/** a verified table, placed under the section whose heading it carries */
export interface DraftTable {
  heading: string | null
  caption: string | null
  columns: string[]
  rows: DraftCell[][]
}

export interface DraftResult {
  file: string
  /** machine-readable sentence/verdict data, input for export_draft */
  dataFile: string
  /** the reading projection: linked citations, print-grade styling */
  htmlFile?: string
  /** 1 on first write; +1 on every in-place revision of the same document */
  version: number
  sentences: DraftSentence[]
  /** verified comparison/listing tables, each under its section */
  tables: DraftTable[]
  sources: { chunkId: string; path: string; page: number | null; grade: string }[]
  summary: { supported: number; partial: number; unsupported: number; uncited: number }
  /** false = plain composition — renderers show a clean document, no verification chrome */
  verified: boolean
  /** relevant library sources that could NOT contribute passages because the
   *  agent never opened them — reading them widens the evidence base */
  excludedUnread?: string[]
  /** revision only: previous-draft headings absent from the new draft — a
   *  dropped section, intended or not, surfaced so the agent can notice */
  droppedSections?: string[]
}

const SectionPlan = z.object({
  sections: z
    .array(
      z.object({
        heading: z
          .string()
          .nullable()
          .describe('short section heading (e.g. "Model Frugality"), or null for an unheaded flowing section'),
        brief: z
          .string()
          .describe("1-3 sentences: what THIS section must cover and which themes/sources it draws on"),
      }),
    )
    .min(1)
    .max(14),
})

/* ------------------------------------------------------------------ *
 * MARKDOWN-NATIVE AUTHORING — the root-cause fix for "he tried and
 * couldn't". The old writer filled a deeply-nested JSON form (sentence
 * arrays + optional table objects): small models skipped optional
 * tables (valid JSON, no error) or failed the nesting when they tried,
 * and real document structure (lists!) was impossible. Models write
 * MARKDOWN fluently — so the writer now writes GFM, one sentence per
 * line, each factual line ending with a [[c:chunkId,chunkId]]
 * annotation, tables as ordinary GFM tables with per-cell annotations.
 * CODE parses that into exactly the same verified units as before; the
 * whole verification pipeline (verdicts, quotes, [n] rendering, export,
 * PDF-linked citations) is unchanged. There is no schema to fail — only
 * text to parse. Any structure the content needs, verified all the same.
 * ------------------------------------------------------------------ */

export interface ParsedUnit {
  text: string
  cites: string[]
  block: "p" | "li" | "h3"
  ordered?: boolean
  /** a blank line preceded this prose unit — a paragraph boundary to KEEP */
  newPara?: boolean
}
export interface ParsedTable {
  caption: string | null
  columns: string[]
  rows: { text: string; cites: string[] }[][]
}

const CITE_ANNOTATION = /\s*\[\[c:([^\]]*)\]\]\s*/g

function extractCites(raw: string): { text: string; cites: string[] } {
  const cites: string[] = []
  const text = raw
    .replace(CITE_ANNOTATION, (_, ids: string) => {
      for (const id of ids.split(/[\s,]+/)) {
        const t = id.trim()
        if (t && t !== "-") cites.push(t)
      }
      return " "
    })
    .replace(/\s+/g, " ")
    .trim()
  return { text, cites: [...new Set(cites)] }
}

/** GFM writer output → verifiable units + tables. Deterministic, no model. */
export function parseAnnotatedMarkdown(md: string): {
  units: ParsedUnit[]
  tables: ParsedTable[]
  /** lines carrying HTML — a rule violation the caller feeds back */
  html: string[]
} {
  const units: ParsedUnit[] = []
  const tables: ParsedTable[] = []
  const html: string[] = []
  const lines = md.split(/\r?\n/)
  let pendingCaption: string | null = null
  let inFence = false
  let sawBlank = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim()
    if (line.startsWith("```")) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    if (line.length === 0) {
      sawBlank = true // paragraph boundary — preserved, not discarded
      continue
    }
    // writers structure long sections with sub-headings — keep them. A ###
    // heading or a bold-only line both count (observed live: 19 bold-only
    // pseudo-headings fused into a wall of prose before this existed).
    const h3 = /^#{3,6}\s+(.*)$/.exec(line) ?? /^\*\*([^*]+)\*\*:?$/.exec(line)
    if (h3) {
      units.push({ text: extractCites(h3[1]!).text, cites: [], block: "h3" })
      sawBlank = false
      continue
    }
    if (/^#{1,2}\s/.test(line)) continue // section headings come from the plan
    if (/<[a-z][a-z0-9]*(\s[^>]*)?>/i.test(line)) {
      html.push(line.slice(0, 80))
      continue
    }
    // caption convention: a single *italic* line directly above a table
    if (/^\*[^*].*\*$/.test(line) && lines[i + 1]?.trim().startsWith("|")) {
      pendingCaption = line.replace(/^\*|\*$/g, "").trim()
      continue
    }
    if (line.startsWith("|")) {
      // a table block: header | separator | data rows
      const rowsRaw: string[] = [line]
      while (lines[i + 1]?.trim().startsWith("|")) rowsRaw.push(lines[++i]!.trim())
      const cellsOf = (r: string) =>
        r.replace(/^\||\|$/g, "").split("|").map((c) => c.trim())
      const sepIdx = rowsRaw.findIndex((r) => /^\|?[\s:|-]+\|?$/.test(r) && r.includes("-"))
      if (sepIdx >= 1 && rowsRaw.length > sepIdx + 1) {
        const columns = cellsOf(rowsRaw[sepIdx - 1]!).map((c) => extractCites(c).text)
        const dataRows = rowsRaw.slice(sepIdx + 1).map((r) => {
          const cells = cellsOf(r).map((c) => extractCites(c))
          // pad/trim to the header width so the renderer never sees ragged rows
          while (cells.length < columns.length) cells.push({ text: "", cites: [] })
          return cells.slice(0, columns.length)
        })
        if (columns.length >= 2 && dataRows.length >= 1) {
          tables.push({ caption: pendingCaption, columns, rows: dataRows })
        }
      }
      pendingCaption = null
      continue
    }
    const li = /^([-*]|\d+[.)])\s+(.*)$/.exec(line)
    if (li) {
      const { text, cites } = extractCites(li[2]!)
      if (text) units.push({ text, cites, block: "li", ordered: /^\d/.test(li[1]!) })
      sawBlank = false
      continue
    }
    const { text, cites } = extractCites(line)
    if (text) {
      units.push({ text, cites, block: "p", ...(sawBlank && units.length > 0 ? { newPara: true } : {}) })
      sawBlank = false
    }
  }
  return { units, tables, html }
}

const MD_FORMAT_RULES_PLAIN =
  "\n\nOUTPUT FORMAT — GitHub markdown, line-oriented:\n" +
  "- Prose: ONE sentence per line. BLANK LINES between paragraphs (kept).\n" +
  "- '### Sub-heading' lines organize long sections; lists as '- item' / '1. item'.\n" +
  "- Tables as ordinary GFM tables. No HTML, no code fences, no section headings " +
  "(the plan adds them).\n"

const MD_FORMAT_RULES =
  "\n\nOUTPUT FORMAT — GitHub markdown, line-oriented (no JSON):\n" +
  "- Prose: ONE sentence per line. Every sentence making a factual claim from the " +
  "literature ends with its citation annotation [[c:chunkId]] or [[c:id1,id2]]. " +
  "Connective sentences and author-position judgments end with [[c:-]].\n" +
  "- Structure freely, like a real paper: BLANK LINES between paragraphs (they are kept), " +
  "and '### Sub-heading' lines to organize a long section into named parts.\n" +
  "- Lists are welcome where the material is enumerable: '- item' or '1. item', one item " +
  "per line, annotated exactly like sentences.\n" +
  "- Tables are ordinary GFM tables (header row, |---| separator, data rows); every " +
  "FACTUAL cell ends with [[c:ids]] inside the cell, label cells carry no annotation. An " +
  "optional caption goes on a single *italic* line directly above the table.\n" +
  "- Do NOT write section headings (the document plan adds them), no HTML, no code fences.\n" +
  "- The annotations are machine-read and stripped — the reader never sees them."

/* ------------------------------------------------------------------ *
 * Lenient writer protocol — the schema-failure PREVENTION layer.
 * Strict generateObject is the primary path (best quality on strong
 * models), but small models wobble on deeply-nested JSON, and a
 * packaging wobble must never read as a drafting failure. The fallback
 * asks for one sentence per line — `text ||| cite ids` — and the
 * STRUCTURE is rebuilt by code. Verification downstream is identical.
 * ------------------------------------------------------------------ */

const LENIENT_PLAN_FORMAT =
  "\n\nOUTPUT FORMAT (plain text, NOT JSON): one section per line, each line exactly\n" +
  "<heading or - for an unheaded section> ||| <1-3 sentence brief>\n" +
  "No other text."

export function parseLenientPlan(raw: string): { heading: string | null; brief: string }[] {
  const out: { heading: string | null; brief: string }[] = []
  for (const line of raw.split(/\r?\n/)) {
    const l = line.trim()
    if (!l || /^(#|```)/.test(l) || !l.includes("|||")) continue
    const [h, ...rest] = l.split("|||")
    const heading = (h ?? "").trim()
    const brief = rest.join("|||").trim()
    if (!brief) continue
    out.push({ heading: heading === "-" || heading === "" ? null : heading.replace(/^[-*•\d.\s]+\s*/, ""), brief })
  }
  return out.slice(0, 14)
}

/** case- and punctuation-insensitive heading key, so a re-plan that lightly
 *  reformats a heading ("Related Work" → "Related work") still matches */
export function normalizeHeading(h: string | null): string {
  return (h ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
}

/**
 * Revision inheritance, as a PURE function of the previous draft and the new
 * plan's headings — the fragile part the adversarial review broke three ways.
 * For each plan section it returns the previous section whose verified prose it
 * should reuse (matched by normalized heading, each previous section consumed
 * at most once so nothing duplicates), plus the previous headings the new plan
 * DROPPED (so a silent section loss can be surfaced). A single-section plan
 * inherits the WHOLE previous draft, never just its leading unheaded run.
 */
export function mapRevision(
  previous: DraftSentence[] | undefined,
  planHeadings: (string | null)[],
): { inherited: (DraftSentence[] | undefined)[]; dropped: string[] } {
  if (!previous?.length) return { inherited: planHeadings.map(() => undefined), dropped: [] }
  if (planHeadings.length === 1) {
    const prevHeadings = [...new Set(previous.filter((s) => s.heading != null).map((s) => s.heading!))]
    // a lone section absorbs everything; a section it happens to share a
    // heading with is still "kept", so only report a drop when the sole plan
    // heading does not match a previous one
    const solo = normalizeHeading(planHeadings[0]!)
    const dropped = prevHeadings.filter((h) => normalizeHeading(h) !== solo && solo !== "")
    return { inherited: [previous], dropped: planHeadings[0] === null ? [] : dropped }
  }
  // group previous into ordered sections
  const sections: { norm: string; heading: string | null; sentences: DraftSentence[]; consumed: boolean }[] = []
  let cur: (typeof sections)[number] | null = null
  for (const s of previous) {
    if (s.heading != null || cur == null) {
      cur = { norm: normalizeHeading(s.heading), heading: s.heading, sentences: [], consumed: false }
      sections.push(cur)
    }
    cur.sentences.push(s)
  }
  const inherited = planHeadings.map((h) => {
    const n = normalizeHeading(h)
    if (n === "") return undefined
    const hit = sections.find((p) => !p.consumed && p.norm === n)
    if (hit) {
      hit.consumed = true
      return hit.sentences
    }
    return undefined
  })
  const planNorms = new Set(planHeadings.map(normalizeHeading))
  const dropped = sections
    .filter((p) => p.heading != null && !planNorms.has(p.norm))
    .map((p) => p.heading!)
  return { inherited, dropped }
}

/** real markup only — known HTML tag names, or a line that IS a pipe-table row;
 *  never flags math prose like "k<n", "p<0.05" or "||w||" */
export function hasDraftMarkup(text: string): boolean {
  return (
    /<\/?(table|thead|tbody|tr|td|th|div|span|p|br|hr|ul|ol|li|sub|sup|b|i|em|strong|code|pre|h[1-6])\b[^>]*>/i.test(text) ||
    /^\s*\|.+\|\s*$/m.test(text)
  )
}

/** a GFM pipe table from a verified table (cells rendered as text) */
export function tableToMarkdown(t: { caption: string | null; columns: string[]; rows: { text: string }[][] }): string {
  const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim()
  const header = `| ${t.columns.map(esc).join(" | ")} |`
  const sep = `| ${t.columns.map(() => "---").join(" | ")} |`
  const rows = t.rows.map(
    (r) => `| ${t.columns.map((_, ci) => esc(r[ci]?.text ?? "")).join(" | ")} |`,
  )
  const cap = t.caption ? `*${esc(t.caption)}*\n\n` : ""
  return `${cap}${header}\n${sep}\n${rows.join("\n")}`
}

/**
 * Writers sometimes leak raw chunk-id markers into prose ("…systems
 * [b06ce6560f68fc3c:1:1992]") — observed in real drafts. Citations render
 * from the cites field; raw ids inside sentence text are always noise.
 * Also normalizes the exotic-whitespace family that breaks UI wrapping.
 */
export function cleanSentenceText(s: string): string {
  return s
    .replace(/[\u00A0\u2000-\u200B\u2028\u2029]/g, " ")
    .replace(/\s*\[[0-9a-f]{12,16}:\d+:\d+(?:\s*,\s*[0-9a-f]{12,16}:\d+:\d+)*\]/gi, "")
    .trim()
}

/**
 * The annotated-bibliography anti-pattern is DETECTABLE (Webster & Watson):
 * runs of consecutive sentences opening with an integral citation ("Smith et
 * al. propose…", "Jones (2024) shows…") walk papers one-by-one instead of
 * synthesizing by ideas. Returns the number of such runs (2+ back-to-back).
 */
export function narrationLintRuns(sentences: { text: string }[]): number {
  const integral = (t: string) =>
    /^(?:[A-Z][\w’'-]+(?:\s+(?:et\s+al\.?|and\s+[A-Z][\w’'-]+))?)\s*(?:\(\d{4}\)\s*)?(?:propose[sd]?|present(?:s|ed)?|introduce[sd]?|show(?:s|ed)?|report(?:s|ed)?|develop(?:s|ed)?|describe[sd]?|argue[sd]?|find(?:s)?|found|evaluate[sd]?|stud(?:y|ies|ied)|examine[sd]?|investigate[sd]?|demonstrate[sd]?|conduct(?:s|ed)?)\b/.test(
      t,
    )
  let runs = 0
  let cur = 0
  for (const s of sentences) {
    if (integral(s.text)) {
      cur++
      if (cur === 2) runs++
    } else {
      cur = 0
    }
  }
  return runs
}

/**
 * Writers often echo the section heading into their first sentence
 * ("## Scope and framing" → "Scope and framing This section…") — observed
 * live. The heading renders separately; a leading duplicate is always noise.
 */
export function stripHeadingEcho(text: string, heading: string | null): string {
  if (!heading) return text
  const h = heading.trim()
  if (!h) return text
  const re = new RegExp(`^${h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s:.,—–-]*`, "i")
  if (!re.test(text)) return text
  const rest = text.replace(re, "").trim()
  // only strip when a real sentence remains — never hollow out short text
  if (rest.length < 15) return text
  return rest.charAt(0).toUpperCase() + rest.slice(1)
}

/** ordered unique source paths by FIRST citation (prose before table cells) */
export function orderSourcesByFirstCite(
  citedUnits: { cites: string[] }[],
  chunkPath: Map<string, string>,
): string[] {
  const seen = new Set<string>()
  const order: string[] = []
  for (const u of citedUnits)
    for (const c of u.cites) {
      const p = chunkPath.get(c)
      if (p && !seen.has(p)) {
        seen.add(p)
        order.push(p)
      }
    }
  return order
}

/**
 * THE one markdown body renderer — visible [n] citation markers on every
 * cited sentence and table cell, sections in order, each section's tables
 * flushed after its prose. Serves BOTH the working draft and the export:
 * two divergent renderers produced zero-marker drafts (looked fabricated)
 * and raw-hash leaks in real workspaces. Never fork this again.
 */
export function renderDraftBody(
  sentences: {
    text: string
    cites: string[]
    heading: string | null
    block?: "p" | "li" | "h3"
    ordered?: boolean
    newPara?: boolean
  }[],
  tables: { heading: string | null; caption: string | null; columns: string[]; rows: { text: string; cites: string[] }[][] }[],
  citeNums: (cites: string[]) => number[],
  /** author-year style override: returns "(Hooker et al., 2020)" or null for numeric */
  citeText?: (cites: string[]) => string | null,
): string {
  const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim()
  const marker = (cites: string[]) => {
    if (citeText) {
      const t = citeText(cites)
      if (t) return ` ${t}`
    }
    const nums = citeNums(cites)
    return nums.length ? ` [${nums.join(", ")}]` : ""
  }
  const tableMd = (t: (typeof tables)[number]) => {
    const cell = (c?: { text: string; cites: string[] }) => (c ? esc(c.text) + marker(c.cites) : "")
    const header = `| ${t.columns.map(esc).join(" | ")} |`
    const sep = `| ${t.columns.map(() => "---").join(" | ")} |`
    const rows = t.rows.map((r) => `| ${t.columns.map((_, ci) => cell(r[ci])).join(" | ")} |`)
    const cap = t.caption ? `*${esc(t.caption)}*\n\n` : ""
    return `${cap}${header}\n${sep}\n${rows.join("\n")}`
  }
  const tablesByHeading = new Map<string, (typeof tables)[number][]>()
  for (const t of tables) {
    const k = normalizeHeading(t.heading)
    const l = tablesByHeading.get(k) ?? []
    l.push(t)
    tablesByHeading.set(k, l)
  }
  let curHeading: string | null = null
  let body = ""
  const flushTables = () => {
    for (const t of tablesByHeading.get(normalizeHeading(curHeading)) ?? []) body += `\n\n${tableMd(t)}\n`
  }
  let prevBlock: "p" | "li" | "h3" = "p"
  sentences.forEach((s, i) => {
    const block = s.block ?? "p"
    const line = s.text + marker(s.cites)
    if (s.heading) {
      flushTables()
      body += `${i > 0 ? "\n\n" : ""}## ${s.heading}\n\n${block === "li" ? `${s.ordered ? "1." : "-"} ` : block === "h3" ? "### " : ""}${block === "h3" ? s.text : line}`
      curHeading = s.heading
    } else if (block === "h3") {
      // writer sub-headings survive as ### structure
      body += `\n\n### ${s.text}\n\n`
    } else if (block === "li") {
      // list items stand on their own lines; GFM renumbers ordered lists
      body += `${prevBlock === "li" ? "\n" : "\n\n"}${s.ordered ? "1." : "-"} ${line}`
    } else if (prevBlock === "li" || prevBlock === "h3" || s.newPara) {
      // fresh paragraph: after a list, after a sub-heading, or at a
      // writer-marked paragraph boundary (blank line — formerly discarded,
      // which fused whole sections into one wall of text)
      body += prevBlock === "h3" ? line : `\n\n${line}`
    } else {
      body += i > 0 ? ` ${line}` : line
    }
    prevBlock = block
  })
  flushTables()
  return body
}

/**
 * Scholarly identity for the writer's evidence — THE fix for "why can't he
 * write 'Hooker et al. showed…'": passages used to arrive as anonymous
 * chunk ids + file paths, so naming authors was impossible (inventing them
 * is banned). Identity comes from registry metadata, by code.
 */
function sourceIdentityLabels(db: Database, paths: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const p of [...new Set(paths)]) {
    const row = db.query("SELECT title, csl_json FROM sources WHERE path = ?").get(p) as {
      title: string | null
      csl_json: string | null
    } | null
    let label = row?.title ?? p.split("/").pop() ?? p
    try {
      const csl = JSON.parse(row?.csl_json ?? "null") as {
        author?: { family?: string; name?: string }[]
        issued?: { "date-parts"?: number[][] }
        title?: string[] | string
      } | null
      if (csl) {
        const fams = (csl.author ?? []).map((a) => a.family ?? a.name).filter(Boolean) as string[]
        const auth =
          fams.length === 0 ? null : fams.length === 1 ? fams[0]! : fams.length === 2 ? `${fams[0]} & ${fams[1]}` : `${fams[0]} et al.`
        const year = csl.issued?.["date-parts"]?.[0]?.[0]
        const title = (Array.isArray(csl.title) ? csl.title[0] : csl.title) ?? row?.title
        if (auth) label = `${auth}${year ? `, ${year}` : ""}${title ? ` — "${title}"` : ""}`
      }
    } catch {
      /* unparseable CSL — filename/title label stands */
    }
    out.set(p, label)
  }
  return out
}

/** short in-text form: "Hooker et al., 2020" (for author-year citation style) */
export function shortIdentity(label: string): string {
  return label.split(" — ")[0]!.trim()
}

function passagesBlock(hits: SearchHit[], identity?: Map<string, string>): string {
  return hits
    .map((h) => {
      const id = identity?.get(h.sourcePath)
      return `[${h.chunkId}] ${id ? `${id} ` : ""}(${h.sourcePath}${h.page ? `, p.${h.page}` : h.lines ? `, L${h.lines}` : ""}, grade: ${h.grade})\n${h.text}`
    })
    .join("\n\n")
}

function briefBlock(brief?: string): string {
  return brief
    ? `\nCONVERSATION BRIEF — content carried over from the conversation (a review, agreed points,
an outline). Build the draft AROUND this material and incorporate its substance faithfully;
do not reduce it to a thin summary. Its assessments and positions are the author's own:
write them with empty cites (they will be marked as the author's position, by design).
Any claim about the LITERATURE (findings, numbers, prior work) still requires chunk cites.
BRIEF:
${brief}\n`
    : ""
}

function planPrompt(
  instructions: string,
  hits: SearchHit[],
  brief?: string,
  previous?: DraftSentence[],
  feedback?: string,
): string {
  const inventory = [...new Set(hits.map((h) => h.sourcePath))].join(", ") || "(none)"
  const prevOutline = previous?.length
    ? "\nPREVIOUS DRAFT OUTLINE (you are REVISING this existing document):\n" +
      previous
        .filter((s, i) => s.heading != null || i === 0)
        .map((s) => `- ${s.heading ?? "(unheaded flow)"}`)
        .join("\n") + "\n"
    : ""
  const revisionRule = previous?.length
    ? "\n- REVISION: return the COMPLETE outline of the revised document — EVERY section " +
      "that should appear in the final file, not only the ones you are changing. A section " +
      "you omit is DELETED from the document. Keep each unchanged section with its heading " +
      "reproduced VERBATIM (same words, same case) so its verified prose can be reused; " +
      "only drop a section if the instructions genuinely ask to remove it."
    : ""
  return `Plan the SECTION STRUCTURE of a document (structure only — no prose yet).

INSTRUCTIONS FOR THE DOCUMENT:
${instructions}
${briefBlock(brief)}${prevOutline}
SOURCES available as passages: ${inventory}

Rules:
- Sections in reading order. Each "brief" says in 1-3 sentences what THAT section must
  cover and which themes/sources it draws on.
- Match the scale the instructions ask for: a short note or answer is ONE section with
  heading null; a full chapter gets its complete outline. Never pad beyond the instructions.
- STRUCTURE FOLLOWS GENRE, never a standard template: a literature review, a rebuttal
  letter, a methods section, an abstract, a technical report each have their OWN
  conventional shape — plan the shape THIS document's genre and instructions demand
  (loaded skill guidance included), and let sections differ in kind, not just topic.${revisionRule}
${feedback ? `\nPREVIOUS ATTEMPT REJECTED: ${feedback}` : ""}`
}

function plainSectionPrompt(args: {
  instructions: string
  brief?: string
  plan: { heading: string | null; brief: string }[]
  index: number
  tail: string[]
  prevDraft?: DraftSentence[]
  previous?: DraftSentence[]
  feedback?: string
}): string {
  const { instructions, brief, plan, index, tail, prevDraft, previous, feedback } = args
  const sec = plan[index]!
  const prevDraftBlock = prevDraft?.length
    ? `\nWHOLE PREVIOUS DRAFT (you are REVISING this document — reproduce any sentence that
still fits VERBATIM; change only what the instructions require; do NOT drop content that
belongs in the final document):\n${prevDraft
        .map((p) => `${p.heading ? `\n## ${p.heading}\n` : ""}${p.text}`)
        .join(" ")}\n`
    : ""
  const prev = previous?.length
    ? `\nTHE PREVIOUS VERSION OF THIS SPECIFIC SECTION (reuse what still fits verbatim):\n${previous
        .map((p) => p.text)
        .join("\n")}\n`
    : ""
  return `You are writing a PLAIN document — it carries NO citations and makes no claims
that need verification against sources.

RULES:
- Write ONLY from the DOCUMENT INSTRUCTIONS and the BRIEF below. Never invent facts,
  numbers, references, quotes, or named findings — if the material for a point is not
  given, leave the point out.
- No [[c:…]] annotations and no bibliography — this document is the author's own text.
- Voice, tone, and shape follow the genre the instructions ask for: an email reads like
  an email, an outline like an outline, a statement like a statement.

DOCUMENT INSTRUCTIONS:
${instructions}
${briefBlock(brief)}${prevDraftBlock}${prev}
DOCUMENT PLAN (the whole document — other sections are written separately, do NOT cover
their material):
${plan.map((p, i) => `${i === index ? "→ " : "  "}${i + 1}. ${p.heading ?? "(unheaded)"} — ${p.brief}`).join("\n")}

YOUR TASK: write ONLY section ${index + 1}${sec.heading ? ` ("${sec.heading}")` : ""}: ${sec.brief}
${tail.length ? `\nThe preceding section ends with: "…${tail.join(" ")}" — continue coherently without repeating it.\n` : ""}${feedback ? `\nPREVIOUS ATTEMPT REJECTED: ${feedback}` : ""}`
}

function sectionPrompt(args: {
  instructions: string
  hits: SearchHit[]
  identity?: Map<string, string>
  brief?: string
  plan: { heading: string | null; brief: string }[]
  index: number
  tail: string[]
  /** whole previous draft (revision only) — a cacheable safety net so no
   *  section is ever rewritten blind if its heading drifts in the re-plan */
  prevDraft?: DraftSentence[]
  /** the previous section this one maps to (revision) — the verbatim-reuse hint */
  previous?: DraftSentence[]
  /** this section's tables in the previous draft (revision) — reproduce/reuse */
  previousTables?: DraftTable[]
  feedback?: string
}): string {
  const { instructions, hits, brief, plan, index, tail, prevDraft, previous, previousTables, feedback } = args
  const sec = plan[index]!
  // whole previous draft rides the STABLE PREFIX (identical across every
  // section call of this revision), so the model can always reproduce and
  // re-cite prior content verbatim even when its section was renamed — and
  // the provider's prompt cache pays for it once, not per section
  const prevDraftBlock = prevDraft?.length
    ? `\nWHOLE PREVIOUS DRAFT (you are REVISING this document — reproduce any sentence that
still fits VERBATIM with its exact [cites]; change only what the instructions require; do
NOT drop content that belongs in the final document):\n${prevDraft
        .map((p) => `${p.heading ? `\n## ${p.heading}\n` : ""}${p.text} [cites: ${p.cites.join(",") || "-"}]`)
        .join(" ")}\n`
    : ""
  const prev = previous?.length
    ? `\nTHE PREVIOUS VERSION OF THIS SPECIFIC SECTION (reuse what still fits VERBATIM, with
its exact cites; only change what the instructions require):\n${previous
        .map((p) => `${p.text} [cites: ${p.cites.join(",") || "-"}]`)
        .join("\n")}\n`
    : ""
  const prevTablesBlock = previousTables?.length
    ? `\nTHIS SECTION'S PREVIOUS TABLE(S) (reproduce in the tables field unless the instructions
change them):\n${previousTables
        .map((t) => tableToMarkdown({ caption: t.caption, columns: t.columns, rows: t.rows }))
        .join("\n\n")}\n`
    : ""
  // passages + rules lead the prompt and are IDENTICAL across the per-section
  // calls of one draft — a stable prefix the provider's prompt cache can reuse
  return `PASSAGES:
${passagesBlock(hits, args.identity) || "(none)"}

RULES (non-negotiable):
- Use ONLY the passages above as factual material about the literature. Cite by chunk id.
- EVERY sentence containing a factual claim from the literature must list at least one
  chunk id that supports it.${
    hits.length === 0
      ? "\n- PASSAGES is empty: no literature claims are allowed — write only from the brief."
      : ""
  }
- Never write a citation, number, or finding that is not in a passage. Never invent chunk ids.
- Never state absolute absence or priority claims ("no prior work has…", "this is the
  first…", "nobody has considered…") — evidence can only cover the sources at hand. Scope
  them honestly: "among the works reviewed here…", "to the best of the reviewed literature…".
- Purely connective sentences${brief ? " and sentences carrying the brief's own positions" : ""} may have empty cites.
- Prose sentences carry NO markup — no bullet lists, no HTML, and no pipe/table syntax
  inside a sentence. When the material is genuinely TABULAR — a comparison across several
  works, a tools×metrics or methods×properties matrix, a PRISMA-style count/flow — build it
  in the "tables" field (columns + rows of cells), NOT as prose. Each data cell that states
  a finding or number cites its chunk ids exactly like a sentence; header and row-label
  cells have empty cites. Use a table only when it genuinely serves the material; otherwise
  prefer prose.
- AUTHOR NAMING: passage headers show each source's authors and year — name them in
  prose where the AUTHOR matters ("Hooker et al. argue… [[c:id]]"; contrasting camps,
  attributing positions, seminal claims). Names come ONLY from those headers, never
  from memory. Otherwise stay information-prominent.
- SYNTHESIZE, never catalogue: organize by ideas, not by papers. Never walk through one
  source at a time ("A did X. B did Y."); open paragraphs with a claim ABOUT the
  literature and support it from several sources, use contrast and continuity moves
  ("whereas…", "building on…", "in contrast to…") where the passages genuinely conflict
  or connect, and where the passages support it, evaluate — strength of evidence, sample
  or scope limits — rather than only report.

DEPTH: match the depth the material and instructions call for — a literature review or
survey section is SUBSTANTIAL: develop it fully from the passages available, never
compress rich material into a thin summary unless the instructions ask for brevity.

DOCUMENT INSTRUCTIONS:
${instructions}
${briefBlock(brief)}${prevDraftBlock}
DOCUMENT PLAN (the whole document — other sections are written separately, do NOT cover
their material):
${plan.map((p, i) => `${i === index ? "→ " : "  "}${i + 1}. ${p.heading ?? "(unheaded)"} — ${p.brief}`).join("\n")}

YOUR TASK: write ONLY section ${index + 1}${sec.heading ? ` ("${sec.heading}")` : ""}: ${sec.brief}
${tail.length ? `\nThe preceding section ends with: "…${tail.join(" ")}" — continue coherently without repeating it.\n` : ""}${prev}${prevTablesBlock}${feedback ? `\nPREVIOUS ATTEMPT REJECTED: ${feedback}` : ""}`
}

export async function draftSection(
  db: Database,
  workspace: Workspace,
  opts: {
    instructions: string
    queries: string[]
    writer: LanguageModel
    verifier: LanguageModel
    embedder?: ((values: string[]) => Promise<number[][]>) | null
    /** dataFile of a previous draft to revise minimally */
    reviseOf?: string
    /** verbatim conversation content (a review, agreed points, an outline) the draft must build on */
    brief?: string
    /** stable document slug: the draft lives at drafts/<document>.md|.json and is updated in place */
    document?: string
    /** in-text citation style — numeric [n] (default) or author-year */
    citationStyle?: "numeric" | "author-year"
    /** false = a PLAIN document (no retrieval, no verification, no citation
     *  chrome) — for compositions without claims from sources */
    verified?: boolean
  },
): Promise<DraftResult | { error: string }> {
  // PLAIN mode — the AGENT's decision from the user's need: a document with no
  // claims from sources (email, outline, statement, conversation summary).
  // No retrieval, no verification, no citation chrome — but the SAME planner
  // and section writer, so structure and genre quality are identical.
  let plain = opts.verified === false
  // 1. retrieve — round-robin across query hit-lists so EVERY query contributes
  // passages (insertion-order truncation used to starve all but the first two
  // queries, which made dense multi-section reviews physically impossible).
  // The citable universe is what the agent has OPENED: passages from sources
  // nobody ever read are excluded — downloaded is not known.
  const openedCache = new Map<string, boolean>()
  const citable = (p: string) => {
    if (!openedCache.has(p)) openedCache.set(p, isOpened(db, workspace, p))
    return openedCache.get(p)!
  }
  const excludedUnread = new Set<string>()
  const perQuery: SearchHit[][] = []
  for (const q of plain ? [] : opts.queries) {
    const raw = await hybridSearch(db, q, 12, opts.embedder)
    for (const h of raw) if (!citable(h.sourcePath)) excludedUnread.add(h.sourcePath)
    perQuery.push(raw.filter((h) => citable(h.sourcePath)))
  }
  const seen = new Map<string, SearchHit>()
  const cap = Math.min(64, Math.max(24, 12 * opts.queries.length))
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
  // PREVENTION gate (observed live): a fact from a FILE the agent read but
  // never ingested gets smuggled in via `brief` and ships UNCITED. When zero
  // passages are citable AND read-but-uningested files exist, the remedy is
  // mechanical: ingest them so retrieval can cite. Genuine brief-only flows
  // (conversation content) have no such files and pass untouched.
  if (!plain && hits.length === 0 && opts.brief) {
    const ingested = new Set(
      (db.query("SELECT path FROM sources").all() as { path: string }[]).map((r) => r.path),
    )
    const readUningested = (
      db.query("SELECT DISTINCT source_path AS p FROM read_log").all() as { p: string }[]
    )
      .map((r) => r.p)
      .filter((p) => !ingested.has(p) && existsSync(join(workspace.root, p)))
    if (readUningested.length > 0) {
      return {
        error:
          `0 citable passages, but you READ ${readUningested.slice(0, 3).join(", ")}` +
          `${readUningested.length > 3 ? ", …" : ""} WITHOUT ingesting — facts from a file must be ` +
          "CITED to it. ingest_source the file(s), then draft again with retrieval queries so every " +
          "sentence carries its citation; brief is only for conversation-derived content.",
      }
    }
  }
  if (!plain && hits.length === 0 && !opts.brief) {
    return {
      error:
        excludedUnread.size > 0
          ? `no passages available from OPENED sources. ${excludedUnread.size} relevant source(s) are in the library but were never read: ` +
            [...excludedUnread].slice(0, 6).join(", ") +
            (excludedUnread.size > 6 ? ", …" : "") +
            " — a source becomes citable by reading it (read_pages / read_source / view_page / ask_document, with notes). Read what matters, then draft."
          : "no passages found for these queries — ingest sources or adjust queries first. " +
            "If this document needs NO literature grounding (an email, outline, statement, " +
            "opinion piece), pass your composed content as `brief` instead — it will be " +
            "saved as author-position text, no citations required.",
    }
  }
  // MECHANICAL mode correction (observed live): a fresh draft with ZERO citable
  // passages cannot be a verified document — there is nothing to verify, so the
  // "0 supported · N uncited" chrome is pure noise and export warns about every
  // sentence. Such a document IS plain; produce it that way and say so.
  let plainFallback = false
  if (!plain && hits.length === 0 && !opts.reviseOf) {
    plain = true
    plainFallback = true
  }
  const allowed = new Set(hits.map((h) => h.chunkId))
  const byId = new Map(hits.map((h) => [h.chunkId, h]))
  // scholarly identity for every evidence source — makes author-prominent
  // prose POSSIBLE (names from registry metadata, never model memory)
  const identity = sourceIdentityLabels(db, hits.map((h) => h.sourcePath))

  // revision mode: load the previous draft; its cited chunks stay legal
  let previous: DraftSentence[] | undefined
  let previousTables: DraftTable[] = []
  let prevVersion = 0
  if (opts.reviseOf) {
    try {
      const { readFileSync } = await import("node:fs")
      const prev = JSON.parse(readFileSync(join(workspace.root, opts.reviseOf), "utf8")) as DraftResult
      previous = prev.sentences
      previousTables = prev.tables ?? []
      prevVersion = prev.version ?? 1
      for (const src of prev.sources) {
        if (byId.has(src.chunkId)) {
          allowed.add(src.chunkId)
          continue
        }
        const row = db
          .query(
            `SELECT c.id, c.page, c.line_start, c.line_end, c.text, s.path, s.title, s.grade
             FROM chunks c JOIN sources s ON s.id = c.source_id WHERE c.id = ?`,
          )
          .get(src.chunkId) as any
        // a previously-cited chunk can be GONE (its source was edited and
        // re-indexed under new ids). It must not stay legal: sentences citing
        // it get re-grounded against current passages instead of crashing.
        if (row) {
          allowed.add(src.chunkId)
          byId.set(src.chunkId, {
            chunkId: row.id, sourcePath: row.path, sourceTitle: row.title, grade: row.grade,
            page: row.page, lines: row.line_start ? `${row.line_start}-${row.line_end}` : null,
            text: row.text, score: 0,
          })
        }
      }
    } catch {
      return { error: `could not load previous draft: ${opts.reviseOf}` }
    }
  }

  // 2. write in two stages: PLAN the section structure (one small call), then
  // write SECTION BY SECTION — one bounded call each. The old single-shot
  // writer put a whole document into one JSON response; chapter-scale drafts
  // exceeded the output window, truncated mid-structure and failed the entire
  // draft. Per-section calls make document size structurally irrelevant, and
  // the shared passages+rules prompt prefix stays provider-cacheable.
  const prevTexts = new Set((previous ?? []).map((p) => p.text))
  // group the previous draft into ORDERED sections for revision inheritance.
  // Matching is by NORMALIZED heading (case/punctuation-insensitive) and each
  // previous section is CONSUMED once — so a re-plan that renames or lightly
  // reformats a heading still reuses that section's verified prose, and no
  // section is ever handed to two plan sections. The whole previous draft is
  // ALSO shown to every section writer (prevDraftBlock), so even an unmatched
  // section is revised with full sight, never blind.

  let plan: { heading: string | null; brief: string }[] | null = null
  let planFeedback: string | undefined
  for (let attempt = 0; attempt < 3 && !plan; attempt++) {
    try {
      const { object } = await generateObject({
        // inner calls need the lead loop's resilience: retry connection-class failures
        maxRetries: 8,
        model: opts.writer,
        schema: SectionPlan,
        prompt: planPrompt(opts.instructions, hits, opts.brief, previous, planFeedback),
      })
      plan = object.sections
    } catch (err) {
      planFeedback =
        "your previous output was not valid JSON for the required schema " +
        "(sections: array of {heading, brief}). Return ONLY schema-valid output. " +
        `(${err instanceof Error ? err.message.slice(0, 120) : "invalid output"})`
    }
  }
  if (!plan) {
    // PREVENTION layer: rebuild structure from a line format code can parse —
    // a JSON wobble on a small model must never fail the whole draft
    try {
      const { text } = await generateText({
        maxRetries: 8,
        model: opts.writer,
        prompt: planPrompt(opts.instructions, hits, opts.brief, previous, planFeedback) + LENIENT_PLAN_FORMAT,
      })
      const lenient = parseLenientPlan(text)
      if (lenient.length > 0) plan = lenient
    } catch {
      /* provider genuinely down — the error below stands */
    }
  }
  if (!plan) {
    return { error: "the writer could not plan the document structure after 4 attempts — simplify the instructions" }
  }

  const sentences: {
    text: string
    cites: string[]
    heading: string | null
    block?: "p" | "li" | "h3"
    ordered?: boolean
    newPara?: boolean
  }[] = []
  const invalidByIdx = new Map<number, string[]>()
  // raw (pre-verification) tables, each tagged with its section heading
  type RawTable = { heading: string | null; caption: string | null; columns: string[]; rows: { text: string; cites: string[] }[][] }
  const rawTables: RawTable[] = []
  // previous tables grouped by normalized section heading (revision reuse hint)
  const prevTablesByHeading = new Map<string, DraftTable[]>()
  for (const t of previousTables) {
    const k = normalizeHeading(t.heading)
    const l = prevTablesByHeading.get(k) ?? []
    l.push(t)
    prevTablesByHeading.set(k, l)
  }
  const clean = cleanSentenceText
  const revision = mapRevision(previous, plan.map((p) => p.heading))
  for (let si = 0; si < plan.length; si++) {
    const sec = plan[si]!
    const prevSec = revision.inherited[si]
    let secUnits: ParsedUnit[] | null = null
    let secTables: RawTable[] = []
    let secInvalid = new Map<number, string[]>()
    let feedback: string | undefined
    for (let attempt = 0; attempt < 4; attempt++) {
      let parsed: ReturnType<typeof parseAnnotatedMarkdown>
      try {
        const { text } = await generateText({
          maxRetries: 8,
          model: opts.writer,
          prompt: plain
            ? plainSectionPrompt({
                instructions: opts.instructions,
                brief: opts.brief,
                plan,
                index: si,
                tail: sentences.slice(-2).map((s) => s.text),
                prevDraft: previous,
                previous: prevSec,
                feedback,
              }) + MD_FORMAT_RULES_PLAIN
            : sectionPrompt({
                instructions: opts.instructions,
                hits,
                identity,
                brief: opts.brief,
                plan,
                index: si,
                tail: sentences.slice(-2).map((s) => s.text),
                prevDraft: previous,
                previous: prevSec,
                previousTables: prevTablesByHeading.get(normalizeHeading(sec.heading)),
                feedback,
              }) + MD_FORMAT_RULES,
        })
        parsed = parseAnnotatedMarkdown(text)
      } catch (err) {
        feedback = `the previous attempt failed (${err instanceof Error ? err.message.slice(0, 100) : "call error"}) — write the section again, following the OUTPUT FORMAT exactly`
        continue
      }
      if (parsed.units.length === 0 && parsed.tables.length === 0) {
        feedback = plain
          ? "nothing parseable came back — follow the OUTPUT FORMAT exactly: one sentence " +
            "per line, blank lines between paragraphs"
          : "nothing parseable came back — follow the OUTPUT FORMAT exactly: one sentence per " +
            "line, each factual line ending with its [[c:chunkId]] annotation"
        continue
      }
      if (parsed.html.length > 0) {
        feedback = `HTML is not allowed (saw: "${parsed.html[0]}") — plain markdown lines, GFM tables, nothing else`
        continue
      }
      const cleanedUnits = parsed.units
        .map((u) => ({ ...u, text: clean(u.text), cites: plain ? [] : u.cites }))
        .filter((u) => u.text.length > 0)
      const cleanedTables: RawTable[] = parsed.tables.map((t) => ({
        heading: sec.heading,
        caption: t.caption ? clean(t.caption) : null,
        columns: t.columns.map(clean),
        rows: t.rows.map((row) => row.map((c) => ({ text: clean(c.text), cites: plain ? [] : c.cites }))),
      }))
      secUnits = cleanedUnits
      secTables = cleanedTables
      secInvalid = new Map()
      cleanedUnits.forEach((s, j) => {
        const bad = s.cites.filter((c) => !allowed.has(c))
        if (bad.length) secInvalid.set(j, bad)
      })
      // table data cells are cited like sentences — invalid ids feed back too
      const tableBadCites = cleanedTables.flatMap((t) =>
        t.rows.flat().flatMap((c) => c.cites.filter((x) => !allowed.has(x))),
      )
      // residual-markup gate: pipes/HTML surviving INSIDE a parsed unit mean a
      // malformed table the parser could not lift out. Previous-draft text is exempt.
      const markup = cleanedUnits.filter((s) => hasDraftMarkup(s.text) && !prevTexts.has(s.text))
      if (secInvalid.size === 0 && markup.length === 0 && tableBadCites.length === 0) break
      feedback = [
        secInvalid.size > 0 || tableBadCites.length > 0
          ? `you cited chunk ids that do not exist: ${[...new Set([...[...secInvalid.values()].flat(), ...tableBadCites])].join(", ")}. Use only the ids shown in PASSAGES, inside [[c:…]] annotations.`
          : "",
        markup.length > 0
          ? `${markup.length} line(s) still carry raw table/HTML markup (e.g. "${markup[0]!.text.slice(0, 80)}…") — a table must be a complete GFM block (header row, |---| separator, data rows); prose lines stay plain.`
          : "",
      ]
        .filter(Boolean)
        .join(" ")
    }
    if (!secUnits) {
      return {
        error: `the writer failed to produce usable output for section ${si + 1}${sec.heading ? ` ("${sec.heading}")` : ""} after 4 attempts — simplify that section's scope or instructions`,
      }
    }
    const base = sentences.length
    secInvalid.forEach((bad, j) => invalidByIdx.set(base + j, bad))
    sentences.push(
      ...secUnits.map((s, j) => ({
        text: j === 0 && s.block === "p" ? stripHeadingEcho(s.text, sec.heading) : s.text,
        cites: s.cites,
        block: s.block,
        ...(s.ordered !== undefined ? { ordered: s.ordered } : {}),
        ...(s.newPara ? { newPara: true } : {}),
        heading: j === 0 ? sec.heading : null,
      })),
    )
    rawTables.push(...secTables)
  }

  // TABLE PASS — promise-driven, never topic-driven (per user correction:
  // nothing decides FOR the agent what a document needs). It runs ONLY when
  // the agent's OWN drafting instructions asked for a table/matrix and the
  // writer returned none: the agent said table, so it delivers a table — or
  // the pass fails and the downstream signals state the miss honestly. A
  // document whose instructions never mentioned a table is never touched.
  const instructionsPromiseTable = /\btable\b|\bmatrix\b/i.test(opts.instructions)
  if (instructionsPromiseTable && rawTables.length === 0 && hits.length >= 8) {
    try {
      const { text } = await generateText({
        maxRetries: 3,
        model: opts.writer,
        prompt:
          `PASSAGES:\n${passagesBlock(hits, identity)}\n\n` +
          "Build THE comparison table for this document — the studies compared across the " +
          "dimensions it discusses (typical columns: Study/Work · Method/Approach · " +
          "Data/Setting · Key finding · Limitation; adapt to the material).\n" +
          "OUTPUT: exactly ONE GFM table (header row, |---| separator, data rows) and " +
          "nothing else — no prose. Every FACTUAL cell ends with its [[c:chunkId]] " +
          "annotation from the passages above; label cells carry none. An optional " +
          "caption goes on a single *italic* line above the table. Never invent a value " +
          "not present in a passage.\n\n" +
          `THE DOCUMENT'S INSTRUCTIONS (for context):\n${opts.instructions}`,
      })
      const t = parseAnnotatedMarkdown(text).tables[0]
      if (t) {
        const cleanedRows = t.rows.map((row) =>
          row.map((c) => ({ text: clean(c.text), cites: c.cites.filter((x) => allowed.has(x)) })),
        )
        if (cleanedRows.flat().some((c) => c.cites.length > 0)) {
          // attach under the last content section so the renderer places it
          const lastHeading = [...sentences].reverse().find((s) => s.heading)?.heading ?? null
          rawTables.push({
            heading: lastHeading,
            caption: t.caption ? clean(t.caption) : null,
            columns: t.columns.map(clean),
            rows: cleanedRows,
          })
        }
      }
    } catch {
      // table pass failed — prose stands; the promise-miss note below tells
      // the agent to say so rather than claim or silently drop it
    }
  }
  const tablePromiseMissed = instructionsPromiseTable && rawTables.length === 0

  // coverage guard: a revision whose new plan left previous sections unmatched
  // has DROPPED them. That can be intentional ("remove the limitations section")
  // — so it is surfaced as a fact (below), never blocked.
  const droppedSections = revision.dropped

  // 3. verify each cited sentence AND each cited table cell (verifier +
  // verbatim-quote gate) — a table cell is a mini-sentence, held to the same
  // bar. BOUNDED concurrency: an unbounded Promise.all fired ~100 simultaneous
  // provider connections, which reliably got sockets killed and failed the
  // whole draft. A small pool keeps throughput without the connection flood.
  const gradeCites = async (
    text: string,
    rawCites: string[],
  ): Promise<{ cites: string[]; invalidCites: string[]; quotes: string[]; verdict: SentenceVerdict }> => {
    const invalid = rawCites.filter((c) => !allowed.has(c))
    const valid = rawCites.filter((c) => allowed.has(c))
    if (valid.length === 0) {
      return { cites: [], invalidCites: invalid, quotes: [], verdict: invalid.length > 0 ? "unsupported" : "uncited" }
    }
    const passages = valid.map((c) => byId.get(c)!.text)
    for (let attempt = 0; ; attempt++) {
      try {
        const v = await verifyClaim(opts.verifier, text, passages)
        return { cites: valid, invalidCites: invalid, quotes: v.quotes, verdict: v.verdict }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        // schema mismatches from small verifier models are as retryable as
        // network blips — one raw 'No object generated' must not kill a
        // whole draft pass (observed live)
        const retryable = isTransientStreamError(msg) || /no object generated|did not match schema/i.test(msg)
        if (attempt >= 3 || !retryable) throw err
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt + Math.random() * 300))
      }
    }
  }
  const verifySentence = async (s: (typeof sentences)[number]): Promise<DraftSentence> => {
    // sub-headings carry no claims: never verified, never counted
    if (s.block === "h3") {
      return { text: s.text, cites: [], invalidCites: [], quotes: [], verdict: "uncited", heading: s.heading, block: "h3" }
    }
    const valid = s.cites.filter((c) => allowed.has(c))
    // unchanged sentence from the previous draft -> keep its verdict, skip re-verification
    const kept = valid.length > 0 && previous?.find((p) => p.text === s.text && p.cites.join() === valid.join())
    if (kept)
      return {
        ...kept,
        heading: s.heading,
        block: s.block,
        ...(s.ordered !== undefined ? { ordered: s.ordered } : {}),
        ...(s.newPara ? { newPara: true } : {}),
        invalidCites: s.cites.filter((c) => !allowed.has(c)),
        revised: false,
      }
    const g = await gradeCites(s.text, s.cites)
    return {
      text: s.text,
      ...g,
      heading: s.heading,
      block: s.block,
      ...(s.ordered !== undefined ? { ordered: s.ordered } : {}),
      ...(s.newPara ? { newPara: true } : {}),
      revised: previous ? true : undefined,
    }
  }

  const results: DraftSentence[] = new Array(sentences.length)
  // pre-shape verified tables so cell slots can be filled by the pool in place
  const tables: DraftTable[] = rawTables.map((t) => ({
    heading: t.heading,
    caption: t.caption,
    columns: t.columns,
    rows: t.rows.map((row) => row.map(() => null as unknown as DraftCell)),
  }))
  if (plain) {
    // no claims to verify — every unit is the author's own text by design;
    // zero verifier calls are spent
    sentences.forEach((s, i) => {
      results[i] = {
        text: s.text,
        cites: [],
        invalidCites: [],
        quotes: [],
        verdict: "uncited",
        heading: s.heading,
        block: s.block,
        ...(s.ordered !== undefined ? { ordered: s.ordered } : {}),
        ...(s.newPara ? { newPara: true } : {}),
      }
    })
    rawTables.forEach((t, ti) =>
      t.rows.forEach((row, ri) =>
        row.forEach((cell, ci) => {
          tables[ti]!.rows[ri]![ci] = { text: cell.text, cites: [], invalidCites: [], quotes: [], verdict: "uncited" }
        }),
      ),
    )
  } else {
    const jobs: (() => Promise<void>)[] = []
    sentences.forEach((s, i) => jobs.push(async () => { results[i] = await verifySentence(s) }))
    rawTables.forEach((t, ti) =>
      t.rows.forEach((row, ri) =>
        row.forEach((cell, ci) =>
          jobs.push(async () => {
            const g = await gradeCites(cell.text, cell.cites)
            tables[ti]!.rows[ri]![ci] = { text: cell.text, ...g }
          }),
        ),
      ),
    )
    const POOL = 6
    let next = 0
    await Promise.all(
      Array.from({ length: Math.min(POOL, jobs.length) }, async () => {
        for (;;) {
          const i = next++
          if (i >= jobs.length) return
          await jobs[i]!()
        }
      }),
    )
  }

  // every verified claim = a sentence OR a table cell that carries cites; the
  // summary (and the export gate) count them together, so a table claim is held
  // to the same bar as prose. Uncited cells are labels/structure, not counted.
  const cellClaims = tables.flatMap((t) => t.rows.flat()).filter((c) => c.cites.length > 0)
  const claimUnits: { verdict: SentenceVerdict }[] = [...results, ...cellClaims]

  // 4. persist verdicts + write the artifact into the workspace
  const now = Date.now()
  const insert = db.query(
    "INSERT OR REPLACE INTO verdicts (id, claim, chunk_id, verdict, quote, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
  ;[...results, ...cellClaims].forEach((r, i) =>
    r.cites.forEach((c) =>
      insert.run(`${now}:${i}:${c}`, r.text, c, r.verdict === "uncited" ? "unsupported" : r.verdict, r.quotes[0] ?? null, "verifier-role", now),
    ),
  )

  const summary = {
    supported: claimUnits.filter((r) => r.verdict === "supported").length,
    partial: claimUnits.filter((r) => r.verdict === "partial").length,
    unsupported: claimUnits.filter((r) => r.verdict === "unsupported").length,
    // "uncited author position" is a PROSE notion — table label cells and
    // sub-headings are structure, not claims
    uncited: results.filter((r) => r.verdict === "uncited" && r.block !== "h3").length,
  }
  const usedSources = [...new Set([...results.flatMap((r) => r.cites), ...cellClaims.flatMap((c) => c.cites)])]
    .filter((c) => byId.has(c)) // never crash on an orphaned cite
    .map((c) => {
      const h = byId.get(c)!
      return { chunkId: c, path: h.sourcePath, page: h.page, grade: h.grade }
    })

  mkdirSync(join(workspace.root, "drafts"), { recursive: true })
  // one document = one stable file, updated in place; timestamps only as fallback
  const slug = opts.document || `draft-${now}`
  const version = prevVersion + 1
  const file = join("drafts", `${slug}.md`)
  // the WORKING draft renders through the same body renderer as the export:
  // visible [n] markers on every verified sentence and table cell, plus a
  // References section — the file a user opens BEFORE export must already
  // look like science, never unattributed narration
  const chunkPath = new Map(usedSources.map((s) => [s.chunkId, s.path]))
  const refOrder = orderSourcesByFirstCite([...results, ...cellClaims], chunkPath)
  const refNum = new Map(refOrder.map((p, i) => [p, i + 1]))
  const citeNums = (cites: string[]) =>
    [...new Set(cites.map((c) => refNum.get(chunkPath.get(c) ?? "")).filter((n): n is number => n != null))]
  const gradeOf = new Map(usedSources.map((s) => [s.path, s.grade]))
  const citeText =
    opts.citationStyle === "author-year"
      ? (cites: string[]) => {
          const names = [...new Set(cites.map((c) => chunkPath.get(c)).filter((x): x is string => !!x))]
            .map((path) => shortIdentity(identity.get(path) ?? path.split("/").pop() ?? path))
          return names.length ? `(${names.join("; ")})` : null
        }
      : undefined
  const body = renderDraftBody(results, tables, citeNums, citeText)
  const refsSection = refOrder.length
    ? "\n\n## References\n\n" +
      refOrder.map((p) => `[${refNum.get(p)}] ${p} (${gradeOf.get(p) ?? "unknown"})`).join("\n") +
      "\n\n*(working-draft references — the export renders the full registry bibliography)*"
    : ""
  const md = plain
    ? body + "\n"
    : body +
      refsSection +
      "\n\n---\nVerification: " +
      `${summary.supported} supported · ${summary.partial} partial · ${summary.unsupported} unsupported · ${summary.uncited} uncited\n`
  writeFileSync(join(workspace.root, file), md)
  // the READING projection: linked citations, print-grade, zero model tokens
  const htmlFile = join("drafts", `${slug}.html`)
  try {
    const firstPage = new Map<string, number | null>()
    for (const u of usedSources) if (!firstPage.has(u.path)) firstPage.set(u.path, u.page)
    writeFileSync(
      join(workspace.root, htmlFile),
      renderDraftHtml({
        title: slug.replace(/-/g, " "),
        sentences: results,
        tables,
        refs: refOrder.map((path, i) => ({
          num: i + 1,
          path,
          label: identity.get(path) ?? path,
          grade: gradeOf.get(path) ?? "unknown",
          page: firstPage.get(path) ?? null,
        })),
        citeNums,
        citeText,
        summaryLine: `${summary.supported} supported · ${summary.partial} partial · ${summary.unsupported} unsupported · ${summary.uncited} uncited`,
        plain,
      }),
    )
  } catch {
    /* the reading projection must never fail the draft */
  }
  const dataFile = join("drafts", `${slug}.json`)
  writeFileSync(
    join(workspace.root, dataFile),
    JSON.stringify({ file, dataFile, version, sentences: results, tables, sources: usedSources, summary, verified: !plain }, null, 2),
  )

  return {
    file,
    dataFile,
    htmlFile,
    version,
    sentences: results,
    tables,
    sources: usedSources,
    summary,
    verified: !plain,
    ...(plainFallback
      ? {
          mode_note:
            "0 citable passages were available, so this was produced as a PLAIN document — " +
            "no citations, no verification chrome (there was nothing to verify). If it " +
            "SHOULD be literature-grounded, ingest and READ the sources first, then " +
            "redraft; if plain was the intent, pass verified:false next time and skip " +
            "queries entirely.",
        }
      : {}),
    ...(excludedUnread.size > 0 ? { excludedUnread: [...excludedUnread] } : {}),
    ...(droppedSections.length > 0 ? { droppedSections } : {}),
    ...(tablePromiseMissed
      ? {
          table_promise_missed:
            "your instructions asked for a table, but none could be built from the opened " +
            "passages (even a dedicated attempt). Tell the user plainly — what the table was " +
            "meant to show and why it could not be grounded — and never claim it exists. If it " +
            "matters, read the sources that hold the missing values, then revise.",
        }
      : {}),
  }
}

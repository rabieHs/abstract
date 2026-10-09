import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Database, Workspace } from "@abstract/core"
import { renderDraftBody, type DraftResult } from "./draft.ts"
import { funnel } from "./ledger.ts"
import { readingProgress } from "./notes.ts"

/**
 * Export: numbered citations + bibliography rendered ONLY from registry
 * metadata (csl_json), a .bib file, and the claim→passage audit JSON.
 * The model writes none of it.
 */

interface CslRecord {
  DOI?: string
  type?: string
  title?: string[] | string
  author?: { family?: string; given?: string; name?: string }[]
  "container-title"?: string[] | string
  issued?: { "date-parts"?: number[][] }
  [k: string]: unknown
}

interface SourceRow {
  path: string
  doi: string | null
  title: string | null
  grade: string
  csl_json: string | null
}

function first(v: string[] | string | undefined): string | null {
  if (!v) return null
  return Array.isArray(v) ? (v[0] ?? null) : v
}

export function cslYear(csl: CslRecord): number | null {
  return csl.issued?.["date-parts"]?.[0]?.[0] ?? null
}

export function cslAuthors(csl: CslRecord): string {
  const list = (csl.author ?? []).map((a) => a.family ?? a.name ?? "").filter(Boolean)
  if (list.length === 0) return "Unknown"
  if (list.length === 1) return list[0]!
  if (list.length === 2) return `${list[0]} and ${list[1]}`
  return `${list[0]} et al.`
}

/** Human-readable reference line, built purely from registry metadata. */
export function renderReference(src: SourceRow): string {
  if (!src.csl_json) return `${src.title ?? src.path} — local source, unverified (${src.grade}).`
  const csl = JSON.parse(src.csl_json) as CslRecord
  const parts = [
    cslAuthors(csl),
    cslYear(csl) ? `(${cslYear(csl)})` : null,
    `“${first(csl.title) ?? src.title ?? src.path}.”`,
    first(csl["container-title"]),
    csl.DOI ? `doi:${csl.DOI}` : null,
  ].filter(Boolean)
  return parts.join(" ")
}

export function renderBibtex(key: string, src: SourceRow): string {
  if (!src.csl_json) {
    return `@misc{${key},\n  title = {${src.title ?? src.path}},\n  note = {Local source, unverified (${src.grade})}\n}`
  }
  const csl = JSON.parse(src.csl_json) as CslRecord
  const kind =
    csl.type === "journal-article" ? "article"
    : csl.type === "proceedings-article" ? "inproceedings"
    : csl.type === "book-chapter" ? "incollection"
    : "misc"
  const authors = (csl.author ?? [])
    .map((a) => (a.family ? `${a.family}, ${a.given ?? ""}`.trim().replace(/,$/, "") : (a.name ?? "")))
    .filter(Boolean)
    .join(" and ")
  const fields: [string, string | number | null][] = [
    ["author", authors || null],
    ["title", first(csl.title)],
    [kind === "article" ? "journal" : "booktitle", first(csl["container-title"])],
    ["year", cslYear(csl)],
    ["doi", csl.DOI ?? null],
  ]
  const body = fields
    .filter(([, v]) => v !== null && v !== "")
    .map(([k, v]) => `  ${k} = {${v}}`)
    .join(",\n")
  return `@${kind}{${key},\n${body}\n}`
}

export async function checkDoi(
  f: typeof fetch,
  doi: string,
): Promise<{ resolves: boolean; retracted: boolean; retractionKnown: boolean }> {
  // existence: the doi.org handle registry covers ALL registrars — Crossref
  // AND DataCite (arXiv DOIs live there; a Crossref-only check false-flags them)
  const handlePath = doi.split("/").map(encodeURIComponent).join("/")
  let resolves = false
  try {
    const r = await f(`https://doi.org/api/handles/${handlePath}`)
    resolves = r.ok && ((await r.json()) as { responseCode?: number }).responseCode === 1
  } catch {
    resolves = false
  }
  // retraction watch only exists in Crossref; DataCite DOIs simply have no record there
  let retracted = false
  let retractionKnown = false
  try {
    const r = await f(`https://api.crossref.org/works/${encodeURIComponent(doi)}`)
    if (r.ok) {
      const msg = (
        (await r.json()) as {
          message?: { "update-to"?: { type?: string }[]; title?: string[] | string }
        }
      ).message
      retracted =
        (msg?.["update-to"] ?? []).some((u) => /retract|withdraw/i.test(u.type ?? "")) ||
        // many retracted records carry no update-to; the publisher prefixes the
        // title instead — colon required so papers ABOUT retraction don't flag
        [msg?.title ?? []].flat().some((t) => /^\s*(RETRACTED(\s+ARTICLE)?|WITHDRAWN)\s*:/i.test(t))
      retractionKnown = true
      resolves = true // Crossref has it even if the handle API hiccupped
    } else if (r.status === 404) {
      // DataCite-registered DOI: Crossref has no retraction data for it, and
      // that is a definitive answer, not an outage
      retractionKnown = true
    }
  } catch {
    // Crossref unavailable — the audit must not silently record "not retracted"
  }
  return { resolves, retracted, retractionKnown }
}

export interface ExportResult {
  files: { document: string; latex: string; bibliography: string; audit: string }
  references: number
  warnings: string[]
}

/** escape LaTeX special characters in prose */
function texEscape(s: string): string {
  return s
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/([&%$#_{}])/g, "\\$1")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}")
    .replace(/[“”]/g, "''")
    .replace(/[‘’]/g, "'")
}

/** a compilable article .tex — sections, numbered \cite, thebibliography from registry data */
function renderLatex(
  sentences: DraftResult["sentences"],
  tables: DraftResult["tables"],
  refNum: Map<string, number>,
  chunkPath: Map<string, string>,
  refs: { num: number; text: string }[],
  title: string,
): string {
  const citeCmd = (cites: string[]) => {
    const nums = [...new Set(cites.map((c) => refNum.get(chunkPath.get(c) ?? "")).filter(Boolean))]
    return nums.length ? `~\\cite{${nums.map((n) => `ref${n}`).join(",")}}` : ""
  }
  const norm = (h: string | null) => (h ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
  const tablesByHeading = new Map<string, DraftResult["tables"]>()
  for (const t of tables) {
    const k = norm(t.heading)
    const l = tablesByHeading.get(k) ?? []
    l.push(t)
    tablesByHeading.set(k, l)
  }
  const tabularTex = (t: DraftResult["tables"][number]) => {
    const spec = t.columns.map(() => "l").join(" ")
    const head = t.columns.map((c) => `\\textbf{${texEscape(c)}}`).join(" & ") + " \\\\ \\hline"
    const rows = t.rows
      .map((r) => t.columns.map((_, ci) => (r[ci] ? texEscape(r[ci]!.text) + citeCmd(r[ci]!.cites) : "")).join(" & ") + " \\\\")
      .join("\n")
    const cap = t.caption ? `\n\\caption{${texEscape(t.caption)}}` : ""
    return `\n\\begin{table}[h]\\centering${cap}\n\\begin{tabular}{${spec}}\n\\hline\n${head}\n${rows}\n\\hline\n\\end{tabular}\n\\end{table}\n`
  }
  let curHeading: string | null = null
  let body = ""
  const flush = () => {
    for (const t of tablesByHeading.get(norm(curHeading)) ?? []) body += tabularTex(t)
  }
  sentences.forEach((s) => {
    const line = texEscape(s.text) + citeCmd(s.cites)
    if (s.heading) {
      flush()
      body += `\n\\section{${texEscape(s.heading)}}\n${line}`
      curHeading = s.heading
    } else {
      body += " " + line
    }
  })
  flush()
  const bib = refs
    .map((r) => `\\bibitem{ref${r.num}} ${texEscape(r.text)}`)
    .join("\n")
  return `\\documentclass[10pt]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\title{${texEscape(title)}}
\\date{}
\\begin{document}
\\maketitle
${body}

\\begin{thebibliography}{${refs.length}}
${bib}
\\end{thebibliography}
\\end{document}
`
}

export async function exportDraft(
  db: Database,
  workspace: Workspace,
  dataFile: string,
  opts: { acknowledge?: boolean; checkDois?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<ExportResult | { error: string }> {
  const draft = JSON.parse(
    readFileSync(join(workspace.root, dataFile), "utf8"),
  ) as DraftResult
  // a PLAIN document (verified:false) carries no citations BY DESIGN — its
  // .md/.html are already the final artifacts; there is no bibliography or
  // audit to build and nothing to warn about
  if (draft.verified === false) {
    return {
      files: { document: draft.file, html: draft.file.replace(/\.md$/, ".html") },
      note:
        "plain document — citation-free by design; the .md/.html above ARE the final " +
        "artifacts. Bibliography, DOI checks, and the claim audit apply only to verified drafts.",
    } as unknown as ExportResult
  }
  const tables = draft.tables ?? []
  // verified table cells are cited claims too — fold them into every place that
  // walks "cited units": reference numbering, the stale-evidence gate, the audit
  const tableCells = tables.flatMap((t) => t.rows.flat()).filter((c) => c.cites.length > 0)
  const citedUnits: { text: string; cites: string[]; verdict: DraftResult["sentences"][number]["verdict"] }[] = [
    ...draft.sentences,
    ...tableCells,
  ]

  if (draft.summary.unsupported > 0 && !opts.acknowledge) {
    return {
      error:
        `${draft.summary.unsupported} sentence(s) are UNSUPPORTED. Fix them (redraft) or ` +
        `export anyway with acknowledge: true — the audit file will record the acknowledgement.`,
    }
  }

  // stale-evidence gate: a verdict is only as good as its evidence. If a cited
  // chunk no longer exists (its source was edited and re-indexed), the old
  // "supported" cannot be trusted — block like unsupported unless acknowledged.
  const chunkExists = db.query("SELECT 1 FROM chunks WHERE id = ?")
  const staleSentences = citedUnits.filter((s) =>
    s.cites.some((c) => !chunkExists.get(c)),
  )
  if (staleSentences.length > 0 && !opts.acknowledge) {
    return {
      error:
        `${staleSentences.length} sentence(s) cite passages that no longer exist — their ` +
        `source files were edited since drafting, so the verdicts are stale. Re-draft ` +
        `(draft_section revise=) to re-verify, or export anyway with acknowledge: true.`,
    }
  }

  // ordered unique sources by first citation (prose first, then table cells)
  const srcRows = new Map<string, SourceRow>()
  const order: string[] = []
  for (const s of citedUnits)
    for (const c of s.cites) {
      const path = draft.sources.find((x) => x.chunkId === c)?.path
      if (!path || srcRows.has(path)) continue
      const row = db
        .query("SELECT path, doi, title, grade, csl_json FROM sources WHERE path = ?")
        .get(path) as SourceRow | null
      if (row) {
        srcRows.set(path, row)
        order.push(path)
      }
    }

  const refNum = new Map(order.map((p, i) => [p, i + 1]))
  const chunkPath = new Map(draft.sources.map((s) => [s.chunkId, s.path]))

  const warnings: string[] = []
  const doiChecks: Record<
    string,
    { resolves: boolean; retracted: boolean; retractionKnown?: boolean } | "skipped"
  > = {}
  for (const p of order) {
    const row = srcRows.get(p)!
    if (!row.doi) continue
    if (opts.checkDois === false) {
      doiChecks[row.doi] = "skipped"
      continue
    }
    const chk = await checkDoi(opts.fetchImpl ?? fetch, row.doi)
    doiChecks[row.doi] = chk
    if (!chk.resolves) warnings.push(`DOI does not resolve: ${row.doi} (${p})`)
    if (chk.retracted) warnings.push(`RETRACTED source cited: ${row.doi} (${p})`)
    if (!chk.retractionKnown)
      warnings.push(`retraction status UNKNOWN (registry unreachable): ${row.doi} (${p})`)
  }
  for (const p of order) {
    const g = srcRows.get(p)!.grade
    if (g !== "peer_reviewed") warnings.push(`non-peer-reviewed source: ${p} (${g})`)
  }
  if (staleSentences.length > 0) {
    warnings.push(
      `${staleSentences.length} sentence(s) exported with STALE evidence (source edited since drafting) — acknowledged`,
    )
  }
  // transparency: uncited sentences are the author's own positions, not verified
  // claims — the reader of the audit and the exporter must both see the count
  if (draft.summary.uncited > 0) {
    warnings.push(
      `${draft.summary.uncited} sentence(s) are the author's own position (uncited — by design for reviews/opinion pieces, but never verified)`,
    )
  }

  const citeNums = (cites: string[]) =>
    [...new Set(cites.map((c) => refNum.get(chunkPath.get(c) ?? "")).filter((n): n is number => n != null))]
  // ONE body renderer, shared with the working draft (draft.ts) — numbered
  // [n] markers on every cited sentence and table cell
  const body = renderDraftBody(draft.sentences, tables, citeNums)
  const refsMd = order
    .map((p) => `[${refNum.get(p)}] ${renderReference(srcRows.get(p)!)}`)
    .join("\n")
  const bib = order.map((p) => renderBibtex(`ref${refNum.get(p)}`, srcRows.get(p)!)).join("\n\n")

  // S12 — process transparency: a review's methods are reproducible only if
  // the search + screening + reading record travels WITH the document. When
  // the ledger has data, a compact record rides the export; the full flow
  // lives in drafts/prisma-flow.md (export_prisma_flow). Per-source read
  // depth goes to the audit either way.
  const searchCount = (db.query("SELECT COUNT(*) n FROM searches").get() as { n: number }).n
  const f = funnel(db)
  const readDepth: Record<string, string> = {}
  for (const p of order) {
    const prog = readingProgress(db, p)
    readDepth[p] = prog ? `${prog.readPages}/${prog.totalPages} pages read` : "no pages logged"
  }
  const processMd =
    searchCount > 0 || f.identified > 0
      ? `\n\n## Search & screening record (auto-generated from the ledger)\n\n` +
        `${searchCount} quer${searchCount === 1 ? "y" : "ies"} recorded as run` +
        (f.identified > 0
          ? `; candidates: ${f.identified} identified → ${f.screened} screened → ${f.included} included (${f.excluded} excluded)`
          : "") +
        `.\nPer-source read depth: ` +
        order.map((p) => `${p} (${readDepth[p]})`).join("; ") +
        `.\nFull record incl. queries and exclusion reasons: drafts/prisma-flow.md (export_prisma_flow).\n`
      : ""

  const base = dataFile.replace(/\.json$/, "")
  const files = {
    document: `${base}.final.md`,
    latex: `${base}.tex`,
    bibliography: `${base}.bib`,
    audit: `${base}.audit.json`,
  }
  writeFileSync(join(workspace.root, files.document), `${body}\n\n## References\n\n${refsMd}\n${processMd}`)
  writeFileSync(
    join(workspace.root, files.latex),
    renderLatex(
      draft.sentences,
      tables,
      refNum,
      chunkPath,
      order.map((p) => ({ num: refNum.get(p)!, text: renderReference(srcRows.get(p)!) })),
      base.split("/").pop()?.replace(/-/g, " ") ?? "Draft",
    ),
  )
  writeFileSync(join(workspace.root, files.bibliography), bib + "\n")
  writeFileSync(
    join(workspace.root, files.audit),
    JSON.stringify(
      {
        draft: dataFile,
        summary: draft.summary,
        acknowledgedUnsupported: draft.summary.unsupported > 0 ? (opts.acknowledge ?? false) : undefined,
        authorPositions: draft.summary.uncited,
        staleEvidence: staleSentences.length,
        doiChecks,
        process: { searches: searchCount, funnel: f, readDepth },
        warnings,
        sentences: draft.sentences.map((s) => ({
          text: s.text,
          verdict: s.verdict,
          evidenceQuotes: s.quotes,
          sources: s.cites.map((c) => {
            const src = draft.sources.find((x) => x.chunkId === c)!
            return { chunkId: c, path: src.path, page: src.page, grade: src.grade }
          }),
        })),
        tables: tables.map((t) => ({
          heading: t.heading,
          caption: t.caption,
          columns: t.columns,
          rows: t.rows.map((r) =>
            r.map((c) => ({
              text: c.text,
              verdict: c.verdict,
              evidenceQuotes: c.quotes,
              sources: c.cites.map((ci) => {
                const src = draft.sources.find((x) => x.chunkId === ci)
                return src ? { chunkId: ci, path: src.path, page: src.page, grade: src.grade } : { chunkId: ci }
              }),
            })),
          ),
        })),
      },
      null,
      2,
    ),
  )
  return { files, references: order.length, warnings }
}

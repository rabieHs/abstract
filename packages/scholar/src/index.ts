import { getJson } from "./http.ts"
import { searchArxiv } from "./arxiv.ts"
import { searchCrossref } from "./crossref.ts"
import { searchOpenAlex } from "./openalex.ts"
import type { ScholarResult } from "./types.ts"

export type { ScholarResult } from "./types.ts"
export { searchArxiv } from "./arxiv.ts"
export { searchCrossref } from "./crossref.ts"
export { openalexCiting, openalexShortId, openalexWorkByDoi, openalexWorksByIds, searchOpenAlex } from "./openalex.ts"
export { referencesFromCsl, snowballByDoi, type CslReference, type SnowballHops } from "./snowball.ts"

function dedupeKey(r: ScholarResult): string {
  if (r.doi) return `doi:${r.doi.toLowerCase()}`
  return (
    "t:" +
    r.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
  )
}

/** merge duplicates, preferring the record with more filled fields */
export function dedupe(results: ScholarResult[]): ScholarResult[] {
  const byKey = new Map<string, ScholarResult>()
  const filled = (r: ScholarResult) =>
    [r.doi, r.abstract, r.venue, r.pdfUrl, r.citedBy, r.year].filter((v) => v != null).length
  for (const r of results) {
    const k = dedupeKey(r)
    const prev = byKey.get(k)
    if (!prev) byKey.set(k, r)
    else {
      const best = filled(r) > filled(prev) ? { ...prev, ...pruneNulls(r) } : { ...r, ...pruneNulls(prev) }
      byKey.set(k, best)
    }
  }
  return [...byKey.values()]
}

function pruneNulls(r: ScholarResult): Partial<ScholarResult> {
  return Object.fromEntries(Object.entries(r).filter(([, v]) => v != null)) as Partial<ScholarResult>
}

export interface SearchScholarOpts {
  yearFrom?: number
  yearTo?: number
  /** citations (default, foundational-first) | recency (newest-first —
   *  raw citation counts bury recent work) | relevance (registry ranking,
   *  interleaved — arXiv results are not buried by their null citedBy) */
  sort?: "citations" | "recency" | "relevance"
}

/** fan out to all connectors, dedupe, rank */
export async function searchScholar(
  query: string,
  limit = 10,
  fetchImpl?: typeof fetch,
  opts: SearchScholarOpts = {},
): Promise<ScholarResult[]> {
  const settled = await Promise.allSettled([
    searchOpenAlex(query, limit, fetchImpl, { yearFrom: opts.yearFrom, yearTo: opts.yearTo, sort: opts.sort }),
    searchCrossref(query, limit, fetchImpl),
    searchArxiv(query, Math.min(limit, 6), fetchImpl),
  ])
  const all = settled.flatMap((s) => (s.status === "fulfilled" ? s.value : []))
  // year bounds apply to every connector (client-side for those without
  // server filters); unknown-year records are kept, never silently dropped
  const bounded = all.filter(
    (r) =>
      r.year == null ||
      ((opts.yearFrom == null || r.year >= opts.yearFrom) && (opts.yearTo == null || r.year <= opts.yearTo)),
  )
  const deduped = dedupe(bounded)
  const sorted =
    opts.sort === "recency"
      ? deduped.sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || (b.citedBy ?? 0) - (a.citedBy ?? 0))
      : opts.sort === "relevance"
        ? deduped // dedupe preserves arrival order: each registry's own ranking, interleaved
        : deduped.sort((a, b) => (b.citedBy ?? 0) - (a.citedBy ?? 0) || (b.year ?? 0) - (a.year ?? 0))
  return sorted.slice(0, limit)
}

/** Browser-shaped headers for fetching PDFs: many publishers serve an HTML
 *  "verify you're human"/cookie page to header-less requests but the real PDF
 *  to something that looks like a browser. Retrieving open-access papers only. */
export const PDF_FETCH_HEADERS: Record<string, string> = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  accept: "application/pdf,text/html;q=0.9,*/*;q=0.8",
}

interface OaLocation {
  url_for_pdf?: string | null
  url?: string | null
}

/**
 * RANKED list of URLs to try for a paper's open-access PDF, best first: a
 * direct pdfUrl, arXiv, then EVERY Unpaywall open-access location — all the
 * direct `url_for_pdf` links first (any repository/mirror), landing-page `url`s
 * last. A single publisher landing page is no longer the end of the road: the
 * repository or arXiv copy in the same record is tried next.
 */
/** Pull a DOI out of a publisher URL (dl.acm.org/doi/pdf/10.x/…, wiley,
 *  springer, doi.org/…): the fallback OA lookup needs a DOI even when only a
 *  pdfUrl was handed in. */
export function extractDoiFromUrl(url: string): string | null {
  const m = /10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+/.exec(url)
  if (!m) return null
  return m[0].replace(/\.pdf$/i, "").replace(/[).,;]+$/, "")
}

export async function resolvePdfCandidates(
  r: { pdfUrl?: string | null; doi?: string | null },
  fetchImpl?: typeof fetch,
): Promise<string[]> {
  const out: string[] = []
  const push = (u?: string | null) => {
    if (u && !out.includes(u)) out.push(u)
  }
  push(r.pdfUrl)
  // an arXiv abs/pdf link → make sure the canonical PDF is a candidate
  const arxivInUrl = r.pdfUrl && /arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})/i.exec(r.pdfUrl)
  if (arxivInUrl) push(`https://arxiv.org/pdf/${arxivInUrl[1]}`)

  // effective DOI: the one passed, OR one recovered from the pdfUrl. Publisher
  // PDF links embed the DOI, so a pdfUrl-only fetch STILL gets the OA fallback
  // (arXiv/repository copies) instead of dead-ending on a paywalled/blocked link.
  const doi = r.doi ?? (r.pdfUrl ? extractDoiFromUrl(r.pdfUrl) : null)
  if (doi) {
    // arXiv DOIs are DataCite, not covered by Unpaywall — construct the link
    const arxiv = /^10\.48550\/arxiv\.(.+)$/i.exec(doi)
    if (arxiv) push(`https://arxiv.org/pdf/${arxiv[1]}`)
    else {
      const email = process.env["UNPAYWALL_EMAIL"] ?? "abstract@example.org"
      const data = await getJson<{
        best_oa_location?: OaLocation | null
        oa_locations?: OaLocation[] | null
      }>(`https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${email}`, { fetchImpl })
      const locs = [
        ...(data?.best_oa_location ? [data.best_oa_location] : []),
        ...(data?.oa_locations ?? []),
      ]
      for (const l of locs) push(l?.url_for_pdf) // direct PDFs first
      for (const l of locs) push(l?.url) // landing pages as a last resort
    }
  }
  return out
}

/** Back-compat single-URL resolver: the top-ranked candidate. */
export async function resolvePdfUrl(
  r: { pdfUrl?: string | null; doi?: string | null },
  fetchImpl?: typeof fetch,
): Promise<string | null> {
  return (await resolvePdfCandidates(r, fetchImpl))[0] ?? null
}

/** decode the HTML entities that appear inside attribute values — repositories
 *  routinely entity-encode the URL in citation_pdf_url (e.g. `&#x2F;` for "/"),
 *  and an undecoded value builds a broken link */
export function decodeHtmlEntities(s: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'" }
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === "#") {
      const cp = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m
    }
    return named[code.toLowerCase()] ?? m
  })
}

/**
 * Many publisher landing pages embed the direct PDF link in a
 * `<meta name="citation_pdf_url" content="…">` tag (the Highwire/Google Scholar
 * convention). Pull it out so a landing page can be turned into its PDF.
 * Pure + testable; decodes HTML entities and resolves relative links.
 */
export function extractCitationPdfUrl(html: string, baseUrl: string): string | null {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if (!/\b(?:name|property)\s*=\s*["']citation_pdf_url["']/i.test(tag)) continue
    const m = /\bcontent\s*=\s*["']([^"']+)["']/i.exec(tag)
    if (m?.[1]) {
      try {
        return new URL(decodeHtmlEntities(m[1]), baseUrl).toString()
      } catch {
        return null
      }
    }
  }
  return null
}

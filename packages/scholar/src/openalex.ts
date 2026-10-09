import { getJson } from "./http.ts"
import type { ScholarResult } from "./types.ts"

interface OAWork {
  id: string
  display_name?: string
  publication_year?: number
  doi?: string | null
  cited_by_count?: number
  abstract_inverted_index?: Record<string, number[]> | null
  primary_location?: { source?: { display_name?: string } | null; landing_page_url?: string | null } | null
  open_access?: { oa_url?: string | null } | null
  authorships?: { author?: { display_name?: string } }[]
  /** OpenAlex ids of the works THIS work references — the free backward hop */
  referenced_works?: string[]
}

function abstractFrom(inv: Record<string, number[]> | null | undefined): string | null {
  if (!inv) return null
  const words: string[] = []
  for (const [w, positions] of Object.entries(inv)) for (const p of positions) words[p] = w
  const s = words.filter(Boolean).join(" ")
  return s.length > 0 ? s.slice(0, 1500) : null
}

/** short OpenAlex id ("W123…") from the full URL form */
export function openalexShortId(id: string): string {
  return id.replace(/^https:\/\/openalex\.org\//, "")
}

function toResult(w: OAWork): ScholarResult {
  return {
    source: "openalex" as const,
    id: w.id,
    title: w.display_name ?? "(untitled)",
    authors: (w.authorships ?? []).map((a) => a.author?.display_name ?? "").filter(Boolean).slice(0, 6),
    year: w.publication_year ?? null,
    venue: w.primary_location?.source?.display_name ?? null,
    doi: w.doi?.replace(/^https:\/\/doi\.org\//, "") ?? null,
    abstract: abstractFrom(w.abstract_inverted_index),
    url: w.primary_location?.landing_page_url ?? w.id,
    pdfUrl: w.open_access?.oa_url ?? null,
    citedBy: w.cited_by_count ?? null,
  }
}

export interface OpenAlexSearchOpts {
  yearFrom?: number
  yearTo?: number
  /** relevance = OpenAlex's own ranking (default for a search); citations / recency = server-side sort */
  sort?: "relevance" | "citations" | "recency"
}

export async function searchOpenAlex(
  query: string,
  limit = 8,
  fetchImpl?: typeof fetch,
  opts: OpenAlexSearchOpts = {},
): Promise<ScholarResult[]> {
  const filters: string[] = []
  if (opts.yearFrom) filters.push(`from_publication_date:${opts.yearFrom}-01-01`)
  if (opts.yearTo) filters.push(`to_publication_date:${opts.yearTo}-12-31`)
  const sort =
    opts.sort === "citations" ? "&sort=cited_by_count:desc"
    : opts.sort === "recency" ? "&sort=publication_date:desc"
    : "" // relevance_score is OpenAlex's default ordering for a search
  const data = await getJson<{ results?: OAWork[] }>(
    `https://api.openalex.org/works?per-page=${limit}&search=${encodeURIComponent(query)}` +
      (filters.length ? `&filter=${filters.join(",")}` : "") +
      sort,
    { fetchImpl },
  )
  return (data?.results ?? []).map(toResult)
}

/** one work by DOI, including its reference list (the backward hop) */
export async function openalexWorkByDoi(
  doi: string,
  fetchImpl?: typeof fetch,
): Promise<(ScholarResult & { openalexId: string; referencedWorks: string[] }) | null> {
  const w = await getJson<OAWork>(
    `https://api.openalex.org/works/doi:${encodeURIComponent(doi)}`,
    { fetchImpl },
  )
  if (!w?.id) return null
  return {
    ...toResult(w),
    openalexId: openalexShortId(w.id),
    referencedWorks: (w.referenced_works ?? []).map(openalexShortId),
  }
}

/** hydrate metadata for a batch of OpenAlex ids (backward-hop candidates) */
export async function openalexWorksByIds(
  ids: string[],
  fetchImpl?: typeof fetch,
): Promise<ScholarResult[]> {
  const out: ScholarResult[] = []
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50)
    const data = await getJson<{ results?: OAWork[] }>(
      `https://api.openalex.org/works?per-page=${batch.length}&filter=openalex_id:${batch.join("|")}`,
      { fetchImpl },
    )
    out.push(...(data?.results ?? []).map(toResult))
  }
  return out
}

/** works CITING the given work (the forward hop): filter=cites:W… */
export async function openalexCiting(
  openalexId: string,
  limit = 25,
  fetchImpl?: typeof fetch,
): Promise<ScholarResult[]> {
  const data = await getJson<{ results?: OAWork[] }>(
    `https://api.openalex.org/works?per-page=${Math.min(limit, 100)}&filter=cites:${openalexId}&sort=cited_by_count:desc`,
    { fetchImpl },
  )
  return (data?.results ?? []).map(toResult)
}

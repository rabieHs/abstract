import { getJson } from "./http.ts"
import type { ScholarResult } from "./types.ts"

interface CrItem {
  DOI?: string
  title?: string[]
  author?: { family?: string; given?: string; name?: string }[]
  issued?: { "date-parts"?: number[][] }
  "container-title"?: string[]
  "is-referenced-by-count"?: number
  abstract?: string
  URL?: string
}

export async function searchCrossref(
  query: string,
  limit = 8,
  fetchImpl?: typeof fetch,
): Promise<ScholarResult[]> {
  const data = await getJson<{ message?: { items?: CrItem[] } }>(
    `https://api.crossref.org/works?rows=${limit}&query.bibliographic=${encodeURIComponent(query)}`,
    { fetchImpl },
  )
  return (data?.message?.items ?? [])
    .filter((i) => i.title?.[0])
    .map((i) => ({
      source: "crossref" as const,
      id: i.DOI ?? i.title![0]!,
      title: i.title![0]!,
      authors: (i.author ?? [])
        .map((a) => [a.given, a.family].filter(Boolean).join(" ") || (a.name ?? ""))
        .filter(Boolean)
        .slice(0, 6),
      year: i.issued?.["date-parts"]?.[0]?.[0] ?? null,
      venue: i["container-title"]?.[0] ?? null,
      doi: i.DOI ?? null,
      abstract: i.abstract ? i.abstract.replace(/<[^>]+>/g, "").slice(0, 1500) : null,
      url: i.URL ?? (i.DOI ? `https://doi.org/${i.DOI}` : null),
      pdfUrl: null,
      citedBy: i["is-referenced-by-count"] ?? null,
    }))
}

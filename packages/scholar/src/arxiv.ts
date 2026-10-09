import { getText } from "./http.ts"
import type { ScholarResult } from "./types.ts"

function tag(entry: string, name: string): string | null {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(entry)
  return m ? m[1]!.replace(/\s+/g, " ").trim() : null
}

export async function searchArxiv(
  query: string,
  limit = 8,
  fetchImpl?: typeof fetch,
): Promise<ScholarResult[]> {
  const xml = await getText(
    `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&max_results=${limit}`,
    { minIntervalMs: 3000, fetchImpl },
  )
  if (!xml) return []
  const out: ScholarResult[] = []
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1]!
    const id = tag(e, "id") ?? ""
    const arxivId = id.replace(/^https?:\/\/arxiv\.org\/abs\//, "")
    if (!arxivId) continue
    const pdf = /<link[^>]*title="pdf"[^>]*href="([^"]+)"/.exec(e)?.[1] ?? `https://arxiv.org/pdf/${arxivId}`
    const doi = tag(e, "arxiv:doi") ?? `10.48550/arXiv.${arxivId.replace(/v\d+$/, "")}`
    out.push({
      source: "arxiv",
      id: arxivId,
      title: tag(e, "title") ?? "(untitled)",
      authors: [...e.matchAll(/<name>([^<]+)<\/name>/g)].map((a) => a[1]!.trim()).slice(0, 6),
      year: Number(tag(e, "published")?.slice(0, 4)) || null,
      venue: "arXiv",
      doi,
      abstract: tag(e, "summary")?.slice(0, 1500) ?? null,
      url: id,
      pdfUrl: pdf,
      citedBy: null,
    })
  }
  return out
}

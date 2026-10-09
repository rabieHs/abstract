/**
 * The metadata gate. Resolves a document against Crossref/OpenAlex so that
 * citation metadata is ALWAYS copied from a registry response — never written
 * by a model. Unresolved sources stay grade "note" and are visibly unverified.
 */

export type Grade = "peer_reviewed" | "preprint" | "note"

export interface ResolvedMeta {
  matched: "doi" | "title" | "none"
  doi: string | null
  title: string | null
  /** CSL-JSON-ish record straight from the registry */
  csl: Record<string, unknown> | null
  grade: Grade
}

const DOI_RE = /\b(10\.\d{4,9}\/[^\s"<>]+)/

export function extractDoi(text: string): string | null {
  const m = DOI_RE.exec(text)
  if (!m) return null
  return m[1]!.replace(/[.,;)\]]+$/, "")
}

function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2),
  )
}

/** token-set containment ratio: how much of the shorter title is in the longer */
export function titleSimilarity(a: string, b: string): number {
  const ta = tokens(a)
  const tb = tokens(b)
  if (ta.size === 0 || tb.size === 0) return 0
  const [small, large] = ta.size <= tb.size ? [ta, tb] : [tb, ta]
  let hit = 0
  for (const t of small) if (large.has(t)) hit++
  return hit / small.size
}

export function gradeFor(doi: string | null, type: string | undefined): Grade {
  if (doi?.startsWith("10.48550/")) return "preprint" // arXiv
  const t = (type ?? "").toLowerCase()
  if (t.includes("preprint") || t === "posted-content") return "preprint"
  if (["journal-article", "proceedings-article", "book-chapter", "article"].includes(t))
    return "peer_reviewed"
  return t ? "peer_reviewed" : "note"
}

/** First plausible title line from extracted text (PDF page 1 or md heading). */
export function guessTitle(text: string, filename: string): string {
  const heading = /^#\s+(.+)$/m.exec(text)
  if (heading) return heading[1]!.trim()
  for (const line of text.split("\n").map((l) => l.trim())) {
    if (line.length >= 20 && line.length <= 200 && !DOI_RE.test(line)) return line
  }
  return filename.replace(/\.[a-z]+$/i, "").replace(/[-_]/g, " ")
}

const NONE: ResolvedMeta = { matched: "none", doi: null, title: null, csl: null, grade: "note" }

async function getJson(f: typeof fetch, url: string): Promise<any | null> {
  try {
    const r = await f(url, { headers: { "user-agent": "abstract/0.1 (+https://github.com/rabieHs/abstract)" } })
    if (!r.ok) return null
    return await r.json()
  } catch {
    return null
  }
}

export async function resolveMetadata(opts: {
  text: string
  filename: string
  fetchImpl?: typeof fetch
  /** an AUTHORITATIVE DOI from the caller (e.g. fetch_paper downloaded BY this
   *  DOI) — tried before anything extracted or guessed. Without it, a fetch
   *  that knew its exact DOI still fell through to title matching, which was
   *  observed matching WRONG registry records (SSRN/Authorea doubles). */
  doiHint?: string | null
}): Promise<ResolvedMeta> {
  const f = opts.fetchImpl ?? fetch
  const head = opts.text.slice(0, 6000)

  const doiCandidates = [opts.doiHint?.trim(), extractDoi(head)].filter(
    (d, i, a): d is string => !!d && a.indexOf(d) === i,
  )
  for (const doi of doiCandidates) {
    const cr = await getJson(f, `https://api.crossref.org/works/${encodeURIComponent(doi)}`)
    const msg = cr?.message
    if (msg?.title?.[0]) {
      return {
        matched: "doi",
        doi: msg.DOI ?? doi,
        title: msg.title[0],
        csl: msg,
        grade: gradeFor(msg.DOI ?? doi, msg.type),
      }
    }
    const oa = await getJson(f, `https://api.openalex.org/works/doi:${encodeURIComponent(doi)}`)
    if (oa?.title) {
      return { matched: "doi", doi, title: oa.title, csl: oa, grade: gradeFor(doi, oa.type) }
    }
  }

  const guess = guessTitle(head, opts.filename)
  if (guess.length < 15) return NONE

  const cr = await getJson(
    f,
    `https://api.crossref.org/works?rows=3&query.bibliographic=${encodeURIComponent(guess)}`,
  )
  for (const item of cr?.message?.items ?? []) {
    const t = item?.title?.[0]
    if (t && titleSimilarity(guess, t) >= 0.9) {
      return {
        matched: "title",
        doi: item.DOI ?? null,
        title: t,
        csl: item,
        grade: gradeFor(item.DOI ?? null, item.type),
      }
    }
  }

  const oa = await getJson(
    f,
    `https://api.openalex.org/works?per-page=3&search=${encodeURIComponent(guess)}`,
  )
  for (const item of oa?.results ?? []) {
    if (item?.title && titleSimilarity(guess, item.title) >= 0.9) {
      const d = (item.doi as string | null)?.replace(/^https:\/\/doi\.org\//, "") ?? null
      return { matched: "title", doi: d, title: item.title, csl: item, grade: gradeFor(d, item.type) }
    }
  }
  return NONE
}

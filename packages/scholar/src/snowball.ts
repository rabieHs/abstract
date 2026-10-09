import type { ScholarResult } from "./types.ts"
import { openalexCiting, openalexWorkByDoi, openalexWorksByIds } from "./openalex.ts"

/**
 * Snowballing (Wohlin 2014) — the way professional corpora are actually
 * built: take a key paper, walk its reference list BACKWARD (what it builds
 * on) and its citations FORWARD (who builds on it), screen, iterate until a
 * hop adds nothing new. Citation links are terminology-independent, so this
 * surfaces the related work — including tools and methods — that keyword
 * search from the model's own vocabulary can never find.
 */

export interface CslReference {
  doi: string | null
  title: string | null
  raw: string
}

/**
 * References already sitting in a stored Crossref/OpenAlex CSL record — the
 * ZERO-NETWORK backward pass. Every registry-matched paper in the library
 * has been carrying its reference list on disk since ingest; this reads it.
 */
export function referencesFromCsl(csl: Record<string, unknown> | null | undefined): CslReference[] {
  const refs = (csl as { reference?: unknown[] } | null | undefined)?.reference
  if (!Array.isArray(refs)) return []
  return refs
    .map((r) => {
      const o = r as {
        DOI?: string
        doi?: string
        "article-title"?: string
        "volume-title"?: string
        unstructured?: string
      }
      const doi = (o.DOI ?? o.doi)?.toLowerCase() ?? null
      const title = o["article-title"] ?? o["volume-title"] ?? null
      return { doi, title, raw: o.unstructured ?? title ?? doi ?? "" }
    })
    .filter((r) => r.doi || r.title || r.raw)
}

export interface SnowballHops {
  seed: { doi: string; title: string | null; openalexId: string }
  /** what the seed builds on — foundational first (citations desc) */
  backward: ScholarResult[]
  /** who builds on the seed — newest first, then citations */
  forward: ScholarResult[]
}

export async function snowballByDoi(
  doi: string,
  opts: { direction?: "both" | "backward" | "forward"; limit?: number; fetchImpl?: typeof fetch } = {},
): Promise<SnowballHops | { error: string }> {
  const dir = opts.direction ?? "both"
  const limit = opts.limit ?? 20
  const work = await openalexWorkByDoi(doi, opts.fetchImpl)
  if (!work) return { error: `OpenAlex has no record for DOI ${doi}` }
  const backward =
    dir !== "forward"
      ? await openalexWorksByIds(work.referencedWorks.slice(0, 100), opts.fetchImpl)
      : []
  const forward = dir !== "backward" ? await openalexCiting(work.openalexId, limit, opts.fetchImpl) : []
  backward.sort((a, b) => (b.citedBy ?? 0) - (a.citedBy ?? 0))
  forward.sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || (b.citedBy ?? 0) - (a.citedBy ?? 0))
  return {
    seed: { doi, title: work.title, openalexId: work.openalexId },
    backward: backward.slice(0, limit),
    forward: forward.slice(0, limit),
  }
}

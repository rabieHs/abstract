import type {} from "@abstract/core"

/**
 * Reference-integrity primitives. The REVIEWING itself is done by the main
 * agent — reading page by page, looking at every figure (view_page / ask_document),
 * noting as it goes, guided by the system prompt and venue review skills.
 * Only the deterministic pieces live in code (see check_references in tools).
 */

export function scanDois(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(/\b(10\.\d{4,9}\/[^\s"<>)\]]+)/g)) {
    out.add(m[1]!.replace(/[.,;]+$/, ""))
  }
  return [...out]
}

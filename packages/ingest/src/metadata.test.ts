import { describe, expect, test } from "bun:test"
import { extractDoi, gradeFor, guessTitle, resolveMetadata, titleSimilarity } from "./metadata.ts"

describe("extractDoi", () => {
  test("finds and trims a DOI", () => {
    expect(extractDoi("see https://doi.org/10.1038/nature14539, fig 2")).toBe("10.1038/nature14539")
  })
  test("null when absent", () => {
    expect(extractDoi("no identifiers here")).toBeNull()
  })
})

describe("titleSimilarity", () => {
  test("near-identical titles score high", () => {
    expect(
      titleSimilarity("Deep learning", "Deep Learning"),
    ).toBe(1)
  })
  test("different titles score low", () => {
    expect(
      titleSimilarity("Deep learning for protein folding", "Urban transit ridership models"),
    ).toBeLessThan(0.3)
  })
})

describe("gradeFor", () => {
  test("arXiv DOI prefix is preprint", () => {
    expect(gradeFor("10.48550/arXiv.2404.10774", "posted-content")).toBe("preprint")
  })
  test("journal-article is peer_reviewed", () => {
    expect(gradeFor("10.1038/nature14539", "journal-article")).toBe("peer_reviewed")
  })
  test("no type and no doi is note", () => {
    expect(gradeFor(null, undefined)).toBe("note")
  })
})

describe("guessTitle", () => {
  test("prefers markdown heading", () => {
    expect(guessTitle("# A Study of Solar Cookers\n\nintro...", "x.md")).toBe(
      "A Study of Solar Cookers",
    )
  })
  test("falls back to filename", () => {
    expect(guessTitle("short", "my-paper_draft.pdf")).toBe("my paper draft")
  })
})

const fakeFetch = (routes: Record<string, unknown>): typeof fetch =>
  (async (url: unknown) => {
    const u = String(url)
    for (const [frag, body] of Object.entries(routes)) {
      if (u.includes(frag)) return new Response(JSON.stringify(body), { status: 200 })
    }
    return new Response("not found", { status: 404 })
  }) as typeof fetch

describe("resolveMetadata", () => {
  test("DOI path uses Crossref record verbatim", async () => {
    const r = await resolveMetadata({
      text: "Title page. doi: 10.1000/test.123",
      filename: "p.pdf",
      fetchImpl: fakeFetch({
        "api.crossref.org/works/10.1000": {
          message: { DOI: "10.1000/test.123", title: ["A Real Paper"], type: "journal-article" },
        },
      }),
    })
    expect(r.matched).toBe("doi")
    expect(r.title).toBe("A Real Paper")
    expect(r.grade).toBe("peer_reviewed")
  })

  test("title path requires >=0.9 similarity", async () => {
    const r = await resolveMetadata({
      text: "# Frugal Benchmarks for Energy Efficient Models\n\nbody",
      filename: "p.md",
      fetchImpl: fakeFetch({
        "query.bibliographic": {
          message: { items: [{ DOI: "10.9/x", title: ["Completely Unrelated Work"], type: "journal-article" }] },
        },
        "api.openalex.org/works?": { results: [] },
      }),
    })
    expect(r.matched).toBe("none")
    expect(r.grade).toBe("note")
  })

  test("offline degrades to note, never throws", async () => {
    const r = await resolveMetadata({
      text: "doi: 10.1000/test.123",
      filename: "p.pdf",
      fetchImpl: (async () => {
        throw new Error("offline")
      }) as unknown as typeof fetch,
    })
    expect(r.matched).toBe("none")
    expect(r.grade).toBe("note")
  })
})

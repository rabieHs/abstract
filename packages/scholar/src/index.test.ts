import { describe, expect, test } from "bun:test"
import { dedupe, searchArxiv, searchCrossref, searchOpenAlex } from "./index.ts"
import type { ScholarResult } from "./types.ts"

const fake = (body: unknown, isText = false): typeof fetch =>
  (async () =>
    new Response(isText ? String(body) : JSON.stringify(body), {
      status: 200,
    })) as unknown as typeof fetch

describe("openalex parsing", () => {
  test("maps work + reconstructs abstract", async () => {
    const r = await searchOpenAlex("x", 5, fake({
      results: [{
        id: "https://openalex.org/W1", display_name: "Frugal AI Benchmarks",
        publication_year: 2025, doi: "https://doi.org/10.1234/abc",
        cited_by_count: 42,
        abstract_inverted_index: { Frugal: [0], models: [1], win: [2] },
        primary_location: { source: { display_name: "NeurIPS" } },
        open_access: { oa_url: "https://x/pdf" },
        authorships: [{ author: { display_name: "A. Researcher" } }],
      }],
    }))
    expect(r).toHaveLength(1)
    expect(r[0]!.doi).toBe("10.1234/abc")
    expect(r[0]!.abstract).toBe("Frugal models win")
    expect(r[0]!.venue).toBe("NeurIPS")
    expect(r[0]!.pdfUrl).toBe("https://x/pdf")
    expect(r[0]!.citedBy).toBe(42)
  })
})

describe("crossref parsing", () => {
  test("maps item and strips abstract markup", async () => {
    const r = await searchCrossref("x", 5, fake({
      message: { items: [{
        DOI: "10.9/z", title: ["A Paper"],
        author: [{ given: "Jo", family: "Doe" }],
        issued: { "date-parts": [[2024]] },
        "container-title": ["Fancy Journal"],
        "is-referenced-by-count": 7,
        abstract: "<jats:p>Real text</jats:p>",
      }] },
    }))
    expect(r[0]!.title).toBe("A Paper")
    expect(r[0]!.authors[0]).toBe("Jo Doe")
    expect(r[0]!.abstract).toBe("Real text")
    expect(r[0]!.year).toBe(2024)
  })
})

describe("arxiv parsing", () => {
  test("parses atom entries with pdf link and derived doi", async () => {
    const atom = `<feed><entry>
      <id>http://arxiv.org/abs/2404.10774v2</id>
      <title>MiniCheck: Efficient Fact-Checking</title>
      <summary>We propose...</summary>
      <published>2024-04-16T00:00:00Z</published>
      <author><name>Liyan Tang</name></author>
      <link title="pdf" href="http://arxiv.org/pdf/2404.10774v2"/>
    </entry></feed>`
    const r = await searchArxiv("x", 5, fake(atom, true))
    expect(r).toHaveLength(1)
    expect(r[0]!.id).toBe("2404.10774v2")
    expect(r[0]!.doi).toBe("10.48550/arXiv.2404.10774")
    expect(r[0]!.pdfUrl).toContain("/pdf/")
    expect(r[0]!.year).toBe(2024)
  })
})

describe("dedupe", () => {
  const base: ScholarResult = {
    source: "crossref", id: "10.1/a", title: "Same Paper Title", authors: [], year: 2024,
    venue: null, doi: "10.1/a", abstract: null, url: null, pdfUrl: null, citedBy: 5,
  }
  test("merges by DOI, keeping filled fields from both", () => {
    const merged = dedupe([
      base,
      { ...base, source: "openalex", venue: "ICML", citedBy: null, pdfUrl: "https://oa/pdf" },
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0]!.venue).toBe("ICML")
    expect(merged[0]!.pdfUrl).toBe("https://oa/pdf")
    expect(merged[0]!.citedBy).toBe(5)
  })
  test("merges by normalized title when DOI missing", () => {
    const merged = dedupe([
      { ...base, doi: null, id: "x" },
      { ...base, doi: null, id: "y", source: "arxiv", title: "Same  Paper — Title!" },
    ])
    expect(merged).toHaveLength(1)
  })
})

import { resolvePdfCandidates, resolvePdfUrl, extractCitationPdfUrl } from "./index.ts"

const jsonFetch = (body: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch

describe("resolvePdfCandidates", () => {
  test("direct pdfUrl is ranked first, before any Unpaywall lookup", async () => {
    const c = await resolvePdfCandidates({ pdfUrl: "https://host/a.pdf", doi: null })
    expect(c[0]).toBe("https://host/a.pdf")
  })

  test("arXiv DOI builds the pdf link, no network", async () => {
    const c = await resolvePdfCandidates({ doi: "10.48550/arxiv.2401.00001" })
    expect(c).toContain("https://arxiv.org/pdf/2401.00001")
  })

  test("every OA location contributes; direct PDFs rank before landing pages", async () => {
    const c = await resolvePdfCandidates(
      { doi: "10.1/x" },
      jsonFetch({
        best_oa_location: { url: "https://publisher/landing", url_for_pdf: null },
        oa_locations: [
          { url: "https://publisher/landing", url_for_pdf: null },
          { url: "https://repo/record", url_for_pdf: "https://repo/paper.pdf" },
        ],
      }),
    )
    // the repository's direct PDF must come before the publisher landing page
    expect(c.indexOf("https://repo/paper.pdf")).toBeLessThan(c.indexOf("https://publisher/landing"))
    // deduped
    expect(c.filter((u) => u === "https://publisher/landing")).toHaveLength(1)
  })

  test("resolvePdfUrl returns the top candidate (back-compat)", async () => {
    const u = await resolvePdfUrl({ pdfUrl: "https://host/a.pdf" })
    expect(u).toBe("https://host/a.pdf")
  })
})

describe("extractCitationPdfUrl", () => {
  test("pulls the citation_pdf_url meta and resolves relative links", () => {
    const html = `<html><head>
      <meta name="citation_title" content="X">
      <meta name="citation_pdf_url" content="/content/10/1/e1.full.pdf">
    </head></html>`
    expect(extractCitationPdfUrl(html, "https://journal.org/article/abc")).toBe(
      "https://journal.org/content/10/1/e1.full.pdf",
    )
  })

  test("handles attribute order and absolute urls", () => {
    const html = `<meta content="https://cdn.org/p.pdf" name="citation_pdf_url" />`
    expect(extractCitationPdfUrl(html, "https://journal.org/x")).toBe("https://cdn.org/p.pdf")
  })

  test("returns null when the tag is absent", () => {
    expect(extractCitationPdfUrl("<html><body>no meta</body></html>", "https://x/y")).toBeNull()
  })
})

import { decodeHtmlEntities } from "./index.ts"

describe("citation_pdf_url with HTML entities (real repository case)", () => {
  test("decodeHtmlEntities handles hex, decimal, and named", () => {
    expect(decodeHtmlEntities("a&#x2F;b&#x3A;c")).toBe("a/b:c")
    expect(decodeHtmlEntities("x&#38;y&amp;z")).toBe("x&y&z")
  })

  test("extracts the real Jyväskylä entity-encoded PDF url (regression: immonen2022)", () => {
    // the exact form the JYX repository emits — entity-encoded ':' and '/'
    const html =
      '<meta name="citation_pdf_url" content="https&#x3A;&#x2F;&#x2F;jyx.jyu.fi&#x2F;bitstreams&#x2F;10a58d15&#x2F;download">'
    expect(extractCitationPdfUrl(html, "https://jyx.jyu.fi/jyx/Record/x")).toBe(
      "https://jyx.jyu.fi/bitstreams/10a58d15/download",
    )
  })
})

import { extractDoiFromUrl } from "./index.ts"

describe("DOI recovery from publisher URLs (pdfUrl-only fetch)", () => {
  test("extractDoiFromUrl pulls the DOI from common publisher links", () => {
    expect(extractDoiFromUrl("https://dl.acm.org/doi/pdf/10.1145/3442188.3445901")).toBe("10.1145/3442188.3445901")
    expect(extractDoiFromUrl("https://onlinelibrary.wiley.com/doi/10.1155/2022/7437023")).toBe("10.1155/2022/7437023")
    expect(extractDoiFromUrl("https://arxiv.org/pdf/1912.05511")).toBeNull() // no DOI in arXiv url
  })

  test("a publisher pdfUrl with NO doi still yields the OA (arXiv) fallback", async () => {
    const c = await resolvePdfCandidates(
      { pdfUrl: "https://dl.acm.org/doi/pdf/10.1145/3442188.3445901", doi: null },
      jsonFetch({ best_oa_location: { url_for_pdf: "https://arxiv.org/pdf/1912.05511", url: null }, oa_locations: [] }),
    )
    // publisher link first, but the recovered-DOI OA copy is now a candidate too
    expect(c).toContain("https://arxiv.org/pdf/1912.05511")
  })

  test("an arXiv abs pdfUrl adds the canonical pdf link", async () => {
    const c = await resolvePdfCandidates({ pdfUrl: "https://arxiv.org/abs/1910.09700" })
    expect(c).toContain("https://arxiv.org/pdf/1910.09700")
  })
})

import { referencesFromCsl, snowballByDoi } from "./snowball.ts"
import { openalexCiting, openalexWorkByDoi } from "./openalex.ts"
import { searchScholar } from "./index.ts"

describe("snowballing (S3 — citation chains)", () => {
  test("referencesFromCsl reads the reference arrays already stored at ingest", () => {
    const refs = referencesFromCsl({
      reference: [
        { DOI: "10.1/AAA", "article-title": "Foundational Work" },
        { unstructured: "Some Author. Old Paper. 1999." },
        {},
      ],
    })
    expect(refs).toHaveLength(2)
    expect(refs[0]).toEqual({ doi: "10.1/aaa", title: "Foundational Work", raw: "Foundational Work" })
    expect(refs[1]!.raw).toContain("Old Paper")
  })
  test("referencesFromCsl tolerates missing/foreign CSL", () => {
    expect(referencesFromCsl(null)).toEqual([])
    expect(referencesFromCsl({ title: ["no refs here"] })).toEqual([])
  })

  const oaWork = (over: Record<string, unknown>) => ({
    id: "https://openalex.org/W1",
    display_name: "Seed Paper",
    publication_year: 2024,
    doi: "https://doi.org/10.5/seed",
    cited_by_count: 10,
    ...over,
  })

  test("snowballByDoi: backward from referenced_works, forward from cites filter", async () => {
    const calls: string[] = []
    const fakeFetch = (async (url: string) => {
      calls.push(url)
      if (url.includes("/works/doi:")) {
        return new Response(JSON.stringify(oaWork({ referenced_works: ["https://openalex.org/W2"] })))
      }
      if (url.includes("filter=openalex_id:W2")) {
        return new Response(JSON.stringify({ results: [oaWork({ id: "https://openalex.org/W2", display_name: "Ancestor", cited_by_count: 500 })] }))
      }
      if (url.includes("filter=cites:W1")) {
        return new Response(JSON.stringify({ results: [oaWork({ id: "https://openalex.org/W3", display_name: "Descendant", publication_year: 2026 })] }))
      }
      return new Response("{}", { status: 404 })
    }) as unknown as typeof fetch
    const r = await snowballByDoi("10.5/seed", { fetchImpl: fakeFetch })
    if ("error" in r) throw new Error(r.error)
    expect(r.seed.openalexId).toBe("W1")
    expect(r.backward.map((b) => b.title)).toEqual(["Ancestor"])
    expect(r.forward.map((f) => f.title)).toEqual(["Descendant"])
    expect(calls.some((u) => u.includes("filter=cites:W1"))).toBe(true)
  })

  test("snowballByDoi is honest when OpenAlex has no record", async () => {
    const fake404 = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch
    const r = await snowballByDoi("10.9/none", { fetchImpl: fake404 })
    expect("error" in r).toBe(true)
  })

  test("openalexCiting builds the forward filter URL", async () => {
    let url = ""
    const f = (async (u: string) => {
      url = u
      return new Response(JSON.stringify({ results: [] }))
    }) as unknown as typeof fetch
    await openalexCiting("W42", 10, f)
    expect(url).toContain("filter=cites:W42")
    expect(url).toContain("per-page=10")
  })

  test("openalexWorkByDoi exposes short ids", async () => {
    const f = (async () =>
      new Response(JSON.stringify(oaWork({ referenced_works: ["https://openalex.org/W7"] })))) as unknown as typeof fetch
    const w = await openalexWorkByDoi("10.5/short-id-probe", f)
    expect(w!.openalexId).toBe("W1")
    expect(w!.referencedWorks).toEqual(["W7"])
  })
})

describe("searchScholar v2 options (S2)", () => {
  const mk = (title: string, year: number, citedBy: number | null): ScholarResult => ({
    source: "openalex", id: title, title, authors: [], year, venue: null, doi: null,
    abstract: null, url: "", pdfUrl: null, citedBy,
  })
  const fakeAll = (results: ScholarResult[]) =>
    (async (url: string) => {
      if (url.includes("openalex.org")) {
        return new Response(JSON.stringify({ results: results.map((r) => ({
          id: r.id, display_name: r.title, publication_year: r.year, cited_by_count: r.citedBy,
        })) }))
      }
      // crossref/arxiv return nothing in these tests
      if (url.includes("crossref.org")) return new Response(JSON.stringify({ message: { items: [] } }))
      return new Response("<feed></feed>")
    }) as unknown as typeof fetch

  test("recency sort surfaces new work that citation sort buries", async () => {
    const results = [mk("Old Classic", 2015, 5000), mk("Brand New", 2026, 2)]
    const byCites = await searchScholar("q-cites", 5, fakeAll(results), { sort: "citations" })
    const byRecency = await searchScholar("q-recency", 5, fakeAll(results), { sort: "recency" })
    expect(byCites[0]!.title).toBe("Old Classic")
    expect(byRecency[0]!.title).toBe("Brand New")
  }, 30_000)

  test("year bounds filter known-year results and keep unknown-year ones", async () => {
    const results = [mk("In Range", 2023, 1), mk("Too Old", 2010, 1)]
    const r = await searchScholar("q-year", 5, fakeAll(results), { yearFrom: 2019 })
    expect(r.map((x) => x.title)).toContain("In Range")
    expect(r.map((x) => x.title)).not.toContain("Too Old")
  }, 30_000)

  test("openalex URL carries server-side year filters", async () => {
    let url = ""
    const f = (async (u: string) => {
      if (u.includes("openalex.org")) url = u
      if (u.includes("crossref.org")) return new Response(JSON.stringify({ message: { items: [] } }))
      if (u.includes("openalex.org")) return new Response(JSON.stringify({ results: [] }))
      return new Response("<feed></feed>")
    }) as unknown as typeof fetch
    await searchScholar("q-filters", 5, f, { yearFrom: 2019, yearTo: 2026 })
    expect(url).toContain("from_publication_date:2019-01-01")
    expect(url).toContain("to_publication_date:2026-12-31")
  }, 30_000)
})

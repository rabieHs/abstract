import { describe, expect, test } from "bun:test"
import { scanDois } from "./review.ts"

describe("reference-integrity scan", () => {
  test("extracts and dedupes DOIs from manuscript text", () => {
    const text = `As shown in [1] (doi:10.1038/nature14539), and again
      https://doi.org/10.48550/arXiv.2404.10774. We cite 10.1038/nature14539 twice.`
    const dois = scanDois(text)
    expect(dois).toHaveLength(2)
    expect(dois).toContain("10.1038/nature14539")
    expect(dois).toContain("10.48550/arXiv.2404.10774")
  })

  test("trims trailing punctuation and ignores plain text", () => {
    expect(scanDois("see 10.1234/abc.def, thanks")).toEqual(["10.1234/abc.def"])
    expect(scanDois("no identifiers at all")).toEqual([])
  })
})

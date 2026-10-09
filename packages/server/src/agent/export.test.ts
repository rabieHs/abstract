import { describe, expect, test } from "bun:test"
import { cslAuthors, cslYear, renderBibtex, renderReference } from "./export.ts"

const CSL = JSON.stringify({
  DOI: "10.1038/nature14539",
  type: "journal-article",
  title: ["Deep learning"],
  author: [
    { family: "LeCun", given: "Yann" },
    { family: "Bengio", given: "Yoshua" },
    { family: "Hinton", given: "Geoffrey" },
  ],
  "container-title": ["Nature"],
  issued: { "date-parts": [[2015, 5]] },
})

const row = { path: "sources/dl.pdf", doi: "10.1038/nature14539", title: "Deep learning", grade: "peer_reviewed", csl_json: CSL }
const noteRow = { path: "notes.md", doi: null, title: "My notes", grade: "note", csl_json: null }

describe("citation rendering from registry metadata", () => {
  test("readable reference", () => {
    const ref = renderReference(row)
    expect(ref).toContain("LeCun et al.")
    expect(ref).toContain("(2015)")
    expect(ref).toContain("Deep learning")
    expect(ref).toContain("Nature")
    expect(ref).toContain("doi:10.1038/nature14539")
  })

  test("bibtex entry", () => {
    const bib = renderBibtex("ref1", row)
    expect(bib).toStartWith("@article{ref1,")
    expect(bib).toContain("author = {LeCun, Yann and Bengio, Yoshua and Hinton, Geoffrey}")
    expect(bib).toContain("journal = {Nature}")
    expect(bib).toContain("year = {2015}")
    expect(bib).toContain("doi = {10.1038/nature14539}")
  })

  test("unresolved local source is honestly marked", () => {
    expect(renderReference(noteRow)).toContain("unverified")
    expect(renderBibtex("ref2", noteRow)).toContain("@misc{ref2,")
    expect(renderBibtex("ref2", noteRow)).toContain("unverified")
  })

  test("csl helpers", () => {
    const csl = JSON.parse(CSL)
    expect(cslYear(csl)).toBe(2015)
    expect(cslAuthors(csl)).toBe("LeCun et al.")
  })
})

export interface ScholarResult {
  source: "openalex" | "crossref" | "arxiv"
  id: string
  title: string
  authors: string[]
  year: number | null
  venue: string | null
  doi: string | null
  abstract: string | null
  url: string | null
  /** direct open-access PDF when known (arXiv always; others via Unpaywall) */
  pdfUrl: string | null
  citedBy: number | null
}

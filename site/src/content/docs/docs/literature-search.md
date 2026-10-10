---
title: Literature search and screening
description: How abstract searches, follows citations, fetches papers, and keeps a PRISMA-style screening record.
---

Ask in plain words and the agent searches for you. You don't need special syntax:

> Find the most cited work since 2020 on evaluating LLM factuality, screen it, and fetch the
> important papers.

## Where it searches

Each search queries **OpenAlex**, **Crossref**, and **arXiv** at once and merges the results,
removing duplicates by DOI or title. The agent can narrow by year and sort by citations (the
default), recency, or relevance. Just say what you want ("since 2021", "newest first").

## Following citations

When a paper is central, the agent **snowballs** from it: backward to the works it cites and
forward to the works that cite it (using OpenAlex). Results show which papers are already in your
library.

As the search goes on, abstract watches for **saturation**: when new rounds stop turning up new
papers, the agent is told coverage is converging, so it knows when to stop searching.

## Fetching papers

The agent downloads **open-access** PDFs into `sources/` and ingests them. It looks for open
copies through the search results, Unpaywall, and the paper's landing page, and skips duplicates
by DOI, file name, and title. If no open-access copy exists, it says so; it never pretends to
have read a paywalled paper. You can always add a PDF yourself.

## The screening record

Every search is logged with its query and number of hits, and every paper it surfaces becomes a
**candidate**. The agent records include/exclude decisions with a reason for each.

- The **screening** bar at the top of the Files panel shows the funnel:
  *identified · screened · included*.
- Ask "export the PRISMA flow" to get `drafts/prisma-flow.md`: the searches as run, a flow
  diagram (identified → screened → included/excluded → retrieved), and the exclusion reasons.
- Exported drafts can include a **search & screening record** generated from the same log, for
  your methods section.

## Checking an idea

Ask "is this idea new?" and the agent runs a **novelty scan**: several concept queries, a map of
which papers combine your concepts, and one hop through the papers that cite the closest match.

## Related tools

- **Check references:** ask the agent to check every DOI in a manuscript (Markdown, text,
  LaTeX, BibTeX, or an ingested PDF; up to 40 DOIs) for resolution and retraction.
- **Extraction matrix:** for systematic reviews, the agent can record study characteristics in a
  matrix. Each value must come with a verbatim quote from the paper.
- **Synthesis:** ask for agreements, tensions, and open gaps across at least two papers it has
  read.
- **Concept map:** the agent can map a paper's concepts and relations to navigate a large library.

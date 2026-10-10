---
title: Verified drafting
description: How abstract writes documents, checks every cited sentence, and shows you the evidence.
---

Ask for a document by what it is — a related-work section, a literature-review chapter, an
introduction, a rebuttal — and the agent writes it as a **named document** in `drafts/`.

> Write a verified related-work section on frugal AI benchmarks, numeric citations.

## How a verified draft is made

1. **Retrieve.** The agent searches your library for the passages it needs. Only sources it has
   **opened** (read, viewed, or summarized) can be cited.
2. **Write.** It plans the sections and writes each in Markdown, attaching the exact passage
   behind every factual claim.
3. **Verify.** Every cited sentence — and every factual cell of every table — is checked against
   the passage it cites, in parallel.

## The verdicts

| Verdict | Meaning |
|---|---|
| <span class="verdict ok">supported</span> | Every part of the claim follows from the cited passage, backed by a word-for-word quote. |
| <span class="verdict partial">partial</span> | Some of the claim is supported, or the claim is stronger than the evidence ("proves" vs "suggests"). |
| <span class="verdict bad">unsupported</span> | The cited passage doesn't support the claim, or the citation is invalid. |
| uncited | No citation — the author's own position. Counted, never verified. |

The rule behind <span class="verdict ok">supported</span> is strict and enforced in code: the
check must quote the source **verbatim**, and the quote must really appear in the cited passage
(ignoring only spacing, case, and curly-vs-straight punctuation). If it doesn't, the sentence is
downgraded to <span class="verdict partial">partial</span>. Numbers must match exactly, and when
in doubt the weaker verdict wins.

Headings are never verified. Each draft ends with a tally, for example
*Verification: 18 supported · 2 partial · 1 unsupported · 3 uncited*.

## Reading a draft

In the chat, the draft view colors each sentence by its verdict:

- **Hover** a sentence to see the verbatim quote that backs it.
- **Click** it to open the **source pane**: the passage with the quote highlighted, the source's
  grade, and the PDF at the cited page.

If a source file was edited or removed after the draft was written, its passages show *This
passage is no longer in the library* — revise the draft to re-check those sentences.

## Revising

Ask for changes in plain words — "shorten section 2", "add a comparison table", "fix the
unsupported sentences". Using the **same document name** revises the same file in place, and
sentences you didn't change keep their verdicts without being checked again. The draft's version
number goes up with each revision; earlier versions aren't kept as separate files.

## Tables

Comparison tables and extraction matrices are verified **cell by cell**, like sentences. If you ask
for a table and the first pass doesn't produce one, the agent runs a dedicated table pass.

## Citation style

Numeric `[1]` is the default. Ask for **author–year** to get citations like *(Hooker et al., 2020)*.
Bibliographies are always built from the registry records, never written by the model.

## Plain documents

Not everything needs citations. For emails, motivation letters, outlines, statements, or
conversation summaries, the agent writes a **plain** document — no verification, no verdict colors,
no export gate. A draft also falls back to plain when there's nothing citable to draw on yet; the
agent tells you when that happens. To turn a plain document into a verified one, ask for it
explicitly.

## Where drafts live

| File | What it is |
|---|---|
| `drafts/<name>.md` | the working draft, with `[n]` markers, references, and the verdict tally |
| `drafts/<name>.html` | a reading view with linked citations and an optional verification overlay |
| `drafts/<name>.json` | data the app uses to revise and export |

The Files panel shows only the `.md`. Use the **PDF** button on it to print or save a PDF.

## Limits that keep runs sane

In one turn the agent creates at most **3 new documents**, and runs at most **3 write-and-verify
passes** per document. If it hits a limit it tells you; send another message to continue.

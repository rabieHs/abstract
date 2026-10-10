---
title: Export
description: Export a verified draft to Markdown, LaTeX, and BibTeX with an audit file — and what the export gate checks.
---

Click **Export** on a verified draft in the chat, or ask the agent to export it. Files are written
next to the draft in `drafts/`:

| File | Contents |
|---|---|
| `<name>.final.md` | the text with numbered citations, a **References** list built from registry records, and an optional search & screening record |
| `<name>.tex` | a compilable LaTeX article with `\cite` commands and a bibliography; tables become `tabular` |
| `<name>.bib` | BibTeX entries. Sources without a registry match become `@misc` with the note *Local source, unverified* |
| `<name>.audit.json` | the evidence trail: every sentence and table cell with its verdict, quotes, and source, plus DOI checks, the search process, and warnings |

The Files panel lists only Markdown files inside `drafts/`, so you'll see `<name>.final.md` there.
The `.tex`, `.bib`, and `.audit.json` files are in the same `drafts/` folder on disk — open the
workspace folder in Finder or your file manager to get them.

## The export gate

Before writing anything, export checks the draft. It **stops** when:

- any sentence is <span class="verdict bad">unsupported</span>, or
- any sentence cites a passage that **no longer exists** (its source was edited or removed).

The message says how many sentences are affected. Fix them — ask the agent to revise — and export
again. <span class="verdict partial">Partial</span> sentences don't block export; they're listed in
the audit file.

:::note[Exporting anyway]
If you decide to export with unsupported sentences, tell the agent so explicitly ("export it anyway,
I accept the unsupported sentences"). Only the agent can pass this acknowledgement — the Export
button can't — and the audit file records that you accepted them.
:::

## DOI and retraction checks

At export, every cited source with a DOI is checked live:

- **Does the DOI resolve?** (via doi.org) — if not: *DOI does not resolve*.
- **Is it retracted or withdrawn?** (via Crossref) — if so: *RETRACTED source cited*.
- If the registry can't be reached: *retraction status UNKNOWN*.

Warnings also list sources that aren't peer-reviewed and how many sentences are your own uncited
positions. All of this goes into the audit file.

## Plain documents

Plain documents (emails, letters, outlines) have nothing to verify, so there's no export step — the
`.md` and `.html` in `drafts/` are the result. Use the **PDF** button in the Files panel to print.

## Checking someone else's manuscript

To check a manuscript you didn't write with abstract, ask the agent to **check its references**. It
checks up to 40 DOIs in a Markdown, text, LaTeX, or BibTeX file — or an ingested PDF — for
resolution and retraction.

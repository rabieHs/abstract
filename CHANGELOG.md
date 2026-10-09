# Changelog

All notable changes to abstract are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [0.1.0] — 2026-10-09

The first open-source release.

### Added

- **Continue with ChatGPT** — run abstract on a ChatGPT Plus or Pro plan through OpenAI's Sign in
  with ChatGPT, with no API key. Includes the usage link, a first-use notice, a "Using ChatGPT plan"
  label in the chat, and a clear message when the plan's usage limit is reached.
- One model, picked in the chat box, runs every task. Models come from Anthropic, OpenAI, Google,
  OpenRouter, Ollama, or a ChatGPT plan, and each provider lists only its recent models.
- A research agent that ingests PDFs, Markdown, and text; searches OpenAlex, Crossref, and arXiv;
  follows citation chains; and keeps a PRISMA-style screening log.
- Verified drafting: per-sentence entailment checks with verbatim evidence, verified comparison
  tables, and gated export to Markdown, LaTeX, and BibTeX with a claim-to-passage audit file.
- Memory notes you approve, and skills written as `SKILL.md` files.

### Changed

- Global settings moved from `~/.openpaper` to `~/.abstract`. The folder is moved automatically the
  first time the new version starts; workspace `.openpaper` folders are unchanged.

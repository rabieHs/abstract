# Contributing to abstract

Thanks for helping. This guide covers the development setup and what a good pull request looks like.

## Setup

You need [Bun](https://bun.sh) 1.1 or newer.

```bash
bun install
bun run build        # build the web UI once (the CLI serves apps/web/dist)
bun run dev          # start the app from source; it opens your last workspace
```

For UI work, run the Vite dev server alongside it — it hot-reloads and proxies `/api` to the app:

```bash
bun run dev --no-open        # terminal 1: the app server on http://localhost:4477
bun run dev:web              # terminal 2: the UI on http://localhost:5173
```

To try a model, connect a provider in Settings or export a key (for example `ANTHROPIC_API_KEY`).

## Project layout

| Path | What lives there |
|---|---|
| `apps/cli` | the `abstract` command: opens a workspace, starts the local server |
| `apps/web` | the React UI |
| `packages/core` | config, workspace, SQLite schema, memory |
| `packages/providers` | model providers, recent-model lists, and the chat model choice, including Continue with ChatGPT |
| `packages/ingest` | file ingestion, chunking, and the registry metadata gate |
| `packages/scholar` | OpenAlex / Crossref / arXiv search and citation chains |
| `packages/verifier` | the claim-against-passage entailment verifier |
| `packages/server` | the HTTP server, the agent loop, and its tools |

[ARCHITECTURE.md](ARCHITECTURE.md) explains how the pieces fit together.

## Website and docs

The site at [useabstract.co](https://useabstract.co) lives in `site/` — an Astro project with
Starlight docs, kept outside the app's workspaces so `bun install` at the root doesn't pull it in.

```bash
cd site
bun install
bun run dev        # http://localhost:4321
```

Docs pages are Markdown in `site/src/content/docs/docs/`; the landing page is
`site/src/pages/index.astro`. Keep the docs true to the code — when you change behavior, update the
page that describes it.

## Before you open a pull request

```bash
bun run typecheck
bun test packages
```

Both must pass.

## Ground rules

- **Integrity stays in code.** Bibliographic metadata comes from registry responses, cited sentences
  go through the verifier, and export gates on unsupported claims. Don't move any of these into
  prompt text or behind a flag that defaults to off.
- **Local-first.** The app must work without any hosted service of ours. New network calls need a
  clear reason and belong in the README's "Your data" section.
- **Keep changes focused.** One concern per pull request, with tests for behavior you add or fix.

## Reporting bugs

Open an issue with what you did, what you expected, and what happened. For agent behavior, include
the model you used and, if you can, the session (Settings shows which model ran each role).

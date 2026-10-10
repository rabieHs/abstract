---
title: Privacy and your data
description: What abstract stores, what leaves your computer, and how to keep everything local.
---

abstract has **no account and no server of its own**. It runs on your computer, and the app only
listens on `127.0.0.1`, so other machines on your network can't reach it.

## What's stored, and where

| Data | Location |
|---|---|
| Your papers, drafts, figures, analysis | your workspace folder |
| Library index, conversations, memory, reading notes, screening record | `<workspace>/.openpaper/` |
| API keys, chosen model, settings | `~/.abstract/config.json` |
| ChatGPT sign-in | `~/.abstract/chatgpt-auth.json` (readable only by you) |
| Skills and rules | `~/.abstract/skills/`, `~/.abstract/rules/` |

To delete a project completely, delete its workspace folder. To remove all settings and keys,
delete `~/.abstract`.

## What leaves your computer

**To the model provider you chose** (OpenAI, Anthropic, Google, OpenRouter, or your ChatGPT plan):

- your messages and any attached files,
- the passages the agent retrieves to write and to verify,
- **whole files** in these cases: each newly ingested PDF (once, to catalog its figures and
  tables), scanned PDFs (for OCR), files the agent looks at as a whole when you ask about them,
  and page images it renders to view figures.

**To scholarly services** — search queries, DOI lookups, and open-access lookups:
OpenAlex, Crossref, arXiv, Unpaywall (with the email in `UNPAYWALL_EMAIL`), and doi.org.

**To publishers and repositories** — when the agent downloads an open-access PDF.

**To OpenAI's sign-in service** — only if you use Continue with ChatGPT.

**To GitHub** — only when you install or update: the installer downloads the program and its
checksums from GitHub Releases. The app itself doesn't check for updates or send usage data.

## Keeping document content local

Use [Ollama](/docs/models/#a-local-model-with-ollama) as your only provider. Model requests —
including whole files — then stay on your machine. Literature search and DOI checks still contact
the scholarly services above when the agent uses them.

## Analysis scripts

When the agent runs Python on your data, the script runs in your workspace folder with a minimal
environment: **none of your API keys** are passed to it, and it has time and output limits.
Scripts aren't meant to make network calls, but that isn't technically blocked — review what you
ask it to run.

---
title: Configuration
description: Settings files, budgets, environment variables, and rules.
---

Most people never edit a file: **Settings** in the app covers models and keys. This page is for
everything else.

## Where things live

```text
~/.local/bin/abstract  the program (when installed with the installer)

~/.abstract/
  config.json          keys, chosen model, port, recent workspaces, budgets
  chatgpt-auth.json    your ChatGPT sign-in (readable only by you)
  skills/              your skills, shared by every workspace
  rules/               your rules (optional)

<workspace>/
  sources/  drafts/  figures/  analysis/
  .openpaper/          library database, conversations, memory, reading notes
```

The standalone program also unpacks its interface once per version into your cache folder
(`~/Library/Caches/abstract` on macOS, `~/.cache/abstract` on Linux). It's safe to delete.

## config.json

```json
{
  "providers": {
    "anthropic": { "apiKey": "sk-ant-…" },
    "ollama": { "baseURL": "http://localhost:11434" }
  },
  "roles": {
    "orchestrator": "anthropic/claude-sonnet-5-5"
  },
  "port": 4477,
  "recentWorkspaces": ["/Users/you/Abstract/thesis"],
  "budgets": {}
}
```

| Field | Meaning |
|---|---|
| `providers` | API keys (`apiKey`) and the Ollama address (`baseURL`). Set these in Settings. |
| `roles.orchestrator` | The model picked in the chat box, as `provider/model`. It runs every task. |
| `roles.embeddings` | Optional: force an embedding model, e.g. `"openai/text-embedding-3-small"`. |
| `port` | Default port (4477). |
| `recentWorkspaces` | Shown on the Workspaces screen; the first existing one opens by default. |
| `budgets` | Limits for long runs (see below). |

If the file can't be read, abstract starts with defaults and prints a warning.

## Budgets

Long tasks are bounded by these settings, all optional. Set any of them to `0` to turn that limit
off.

| Setting | Default | What it does |
|---|---|---|
| `turnSoftInputTokens` | `1500000` | Past this many input tokens, the agent is asked once to pace itself and wrap up. |
| `turnHardInputTokens` | `3000000` | The ceiling for one segment of work. |
| `maxAutoContinues` | `2` | When the ceiling is hit with the plan still open, earlier steps are summarized and work continues in a fresh segment, up to this many times. |
| `compactAtInputTokens` | `110000` | When the conversation context grows past this, it's summarized mid-turn to keep fitting the model. Raise it for long-context models. |
| `nativeTaskBudgetTokens` | `0` | Anthropic only: also send a native task budget to the model. |

```json
{ "budgets": { "turnSoftInputTokens": 800000, "maxAutoContinues": 0 } }
```

Independently of these, one message can run for at most 3 hours.

## Environment variables

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `OPENROUTER_API_KEY` | Provider keys. They take precedence over keys saved in Settings. |
| `OLLAMA_HOST` | The Ollama server address (default `http://localhost:11434`). Takes precedence over Settings. |
| `UNPAYWALL_EMAIL` | The email sent to Unpaywall when looking for open-access copies. Set your own to follow Unpaywall's usage etiquette. |
| `ABSTRACT_SKILLS_DIR` | Use a different skills folder. |
| `ABSTRACT_RULES_DIR` | Use a different rules folder. |
| `ABSTRACT_CHATGPT_STORE` | Use a different file for the ChatGPT sign-in. |
| `ABSTRACT_NO_PLAN` | Set to anything to turn off the agent's task plan. |

## Rules

Rules let you **forbid** specific agent actions. Put JSON files in `~/.abstract/rules/`. Each file
holds one rule or a list of rules:

```json
{
  "name": "no-arxiv-fetch",
  "tool": "fetch_paper",
  "input_matches": "arxiv\\.org",
  "action": "block",
  "message": "this project forbids fetching from arXiv mirrors"
}
```

| Field | Meaning |
|---|---|
| `name` | A label shown when the rule fires (defaults to the file name). |
| `tool` | The action to match: an exact tool name, `*` for all, or a prefix ending in `*`. |
| `input_matches` | Optional. A case-insensitive regular expression tested against the action's input. |
| `action` | Must be `"block"`. Rules can only forbid, never allow. |
| `message` | The reason. The agent is told this and works around it. |

Rules are read at the start of each message. When one fires, the agent sees
`blocked by your rule "no-arxiv-fetch": …` and takes another route. Common tool names:
`fetch_paper`, `search_scholar`, `snowball`, `run_code`, `edit_source`, `draft_section`,
`export_draft`, `delegate`.

# Abstract — Architecture (v0.3)

*Chat-first, adaptive, local-first, multi-provider. Visual companion: the "Agentic
architecture & usage scenarios" artifact (2026-07-14).*

## Form factor

`abstract` is a CLI that starts a local server and opens the workspace in the browser —
the same shape as local coding agents:

```bash
npm install -g @abstract/cli   # or: npx @abstract/cli
abstract                  # opens the workspace
abstract ~/pfe            # open a specific workspace folder
```

Local-first by design: sources, drafts, indexes, memory, and API keys all live on the user's
machine (`~/.abstract` + per-workspace data). Requests go directly from the local server to
the model provider. No account required. This is a trust feature, not just a convenience —
researchers will not upload unpublished manuscripts and grant ideas to a hosted black box.
A hosted layer (sync, teams, shared libraries) is a later business decision, never a
requirement.

## 0. Design axioms

1. **Drafting is agentic, verification is deterministic, approval is human.**
2. **One agent, adaptive depth.** No modes, no wizards. Intent is read from the message; the
   agent decides whether to answer, search, or open a multi-checkpoint project — and proposes
   its plan in chat before doing big work.
3. **Gates are welded inside tools, not into workflows.** The LLM never *writes* a citation —
   it can only *select* chunk IDs from already-verified sources. Verification executes inside
   the tool call; the agent cannot reach the user's document except through it.
4. **Everything visible.** Live activity feed (every tool call streamed, interruptible);
   per-sentence verification badges; click-through to source passages; nothing learned silently.

## 1. System planes

```
┌─────────────────────────────────────────────────────────────────┐
│ ① WORKSPACE   chat · live activity feed · sources panel         │
│               artifacts pane (badged drafts) · source pane      │
│               memory dashboard · export (+ audit file)          │
├─────────────────────────────────────────────────────────────────┤
│ ② ORCHESTRATOR  one agent loop; behaviors it may choose:        │
│    quick answer · find papers · lit-review · drafting           │
│    reviewer mode · rebuttal · gap analysis                      │
│    tools: search_library search_scholar ingest_source           │
│           read_chunks propose_outline draft_section             │
│           verify_claims render_citations request_approval       │
│           memory.read/write export                              │
├─────────────────────────────────────────────────────────────────┤
│ ③ VERIFICATION PLANE  (deterministic; welded inside tools)      │
│    structural gate → entailment verifier → citation renderer    │
│    prose quality gate → export auditor                          │
├─────────────────────────────────────────────────────────────────┤
│ ④ GROUNDING   ingestion (PDF/md/image/URL) → metadata gate      │
│               (Crossref/OpenAlex → source grade) → chunking →   │
│               hybrid retrieval (vector + BM25, rank fusion)     │
│               connectors: OpenAlex · S2 · Crossref · arXiv ·    │
│               Unpaywall                                         │
├─────────────────────────────────────────────────────────────────┤
│ ⑤ STORES      SQLite (sqlite-vec + FTS5) · files on disk ·      │
│               provenance graph (claim→passage→paper)            │
└─────────────────────────────────────────────────────────────────┘
   MEMORY RAIL (alongside ①–③): style card · preferences ·
   project state · writing patterns  → injected into every call
   feedback events (edit diffs) → nightly distiller → proposed
   rules, approved in the memory dashboard
```

## 2. Adaptive depth (how "no workflow" works)

The orchestrator is a single conversational loop, like a coding agent's. Depth examples:

| Input | What the agent decides |
|---|---|
| "what does entailment mean in NLI?" | Answers directly. No retrieval, no gates. |
| "which of my papers measure energy per inference?" | `search_library` → passage-pinned answer. |
| "find recent work on graph neural networks for molecules" | `search_scholar` live → screening table in chat. |
| "write the related work for my ICTAI paper" | Proposes a plan in chat; unfolds checkpoints as questions. |

Checkpoints (`request_approval`) pause the run and persist state; they are in-chat questions
with rich artifact surfaces (screening table, outline board, badged sections), never separate
screens. The five canonical gates for big writing tasks: search plan → screening → outline →
per-section review → export audit acknowledgment.

## 3. Grounding pipeline

**Ingestion — one path for every source type:**

1. Upload/URL → local storage. PDF parsed by the **Python parsing sidecar** — primary engine
   **docling** (best 2026 benchmark) with **GROBID** (Java/Docker) for reference-list + TEI
   coordinates; fallback `unpdf` text extraction (degraded, flagged). Final engine choice at
   the ingestion milestone, benchmarked on the founder's own PDF corpus. Markdown/text taken
   raw; images read via model vision; web pages fetched and boilerplate-stripped.
2. **Metadata gate (deterministic):** extracted title/DOI → Crossref + OpenAlex; fuzzy title
   match (token-set ratio > 0.9) + first author + year. Match → `sources` row with `csl_json`
   *from Crossref, never from the model* + grade `peer_reviewed | preprint`. No match → grade
   `web | note`, citable only with a visible grade badge. Version pitfalls (preprint vs
   camera-ready, workshop papers absent from Crossref) are a known hard spot — surface
   ambiguity to the user rather than guessing.
3. **Chunking:** section-aware, 300–500 tokens, with `(page, char_start, char_end)` provenance
   for click-to-passage.
4. **Index:** sqlite-vec (dense; embedding model is provider-selectable, see §6) + SQLite
   FTS5 (BM25); reciprocal-rank fusion. Zero-setup, lives inside the workspace.

**External corpus:** connectors to OpenAlex, Semantic Scholar, Crossref, arXiv, Unpaywall
(adapted from OpenScience's Apache-licensed `science/connectors/literature/` — keep LICENSE +
NOTICE attribution). Selected papers resolve an OA PDF via Unpaywall and run through the same
ingestion path. Result: **every citable unit is a chunk with a resolved `source_id` and a
grade** — one substrate for "my sources + the world."

## 4. Verification plane (the moat)

All deterministic code, executing inside tool calls:

1. **Structural gate** (inside `draft_section`): the writer must emit
   `[{sentence, citation_chunk_ids[]}]` (schema-enforced). Any chunk ID not retrieved in this
   session → section rejected and regenerated. Fabricated references are structurally
   impossible.
2. **Entailment verifier** (inside `draft_section` / `verify_claims`): each (claim, chunk) pair
   → verdict `supported | partial | unsupported` + a supporting quote that must be a **verbatim
   substring** of the chunk (server-checked). Unsupported → writer retries (max 2) → then
   flagged red, never silently kept or dropped. Verdicts persist per sentence → the document is
   a claim-level provenance graph. Start with a strong small model (Haiku-class) + the quote
   check; evaluate self-hosted NLI (MiniCheck-class) later. **Synthesis claims** ("most prior
   work…") verify against *claim sets* spanning multiple chunks — this is the hard research
   problem; see §9.
3. **Citation renderer**: bibliography rendered from `csl_json` via citeproc (APA/IEEE/BibTeX).
   The model never writes a reference entry.
4. **Prose quality gate**: flags AI-pattern writing — filler transitions, uniform sentence
   rhythm, vague intensifiers, list-itis — as quality findings the user sees. Explicitly *not*
   a detector-evasion tool.
5. **Export auditor** (inside `export`): every DOI resolves, metadata matches, retraction feed
   checked (Crossref/Retraction Watch), unsupported-claim count acknowledged. Ships the
   **audit file**: claim → passage → source, machine-readable + human-readable.

UI badge vocabulary: 🟢 verified (passage entails claim) · 🟡 weak (topical match only) ·
🔴 unsupported (flagged, with a proposed search) — plus the source-grade chip.

## 5. Memory

SQLite, four surfaces, injected via prompt (no fine-tuning):

- `style_card` — ~400-token profile distilled from the user's prior papers (sentence length,
  hedging, terminology, citation density, voice).
- `writing_patterns` — venue/field prose norms learned from workspace papers.
- `preferences` — explicit key-values ("IEEE style", "British spelling").
- `projects` — research question, outline + per-section status, decision log (the checkpoint
  state machine lives here).
- `feedback_events` — every human edit as a diff. Nightly distiller (batch, cheap model) turns
  recurring patterns into *proposed* rules surfaced in the memory dashboard — accept/reject,
  nothing silent.

Prompt assembly with two cache breakpoints: [static platform prompt + tools] →
[style card + preferences + project brief] → volatile turn content.

## 6. Stack & libraries (local-first, solo-dev pragmatic)

**Language decision (evidence-verified 2026-07-14): TypeScript core + Python sidecars where
Python genuinely wins.** The agent loop (provider APIs, tool calling, MCP, streaming, SQLite,
browser UI) has full — often first-tier — TS support: Gemini CLI / opencode / Cline are TS, and the MCP TypeScript SDK is the tier-1
reference. When OpenAI outgrew TS for Codex CLI they rewrote in **Rust**, not Python. The
Python agent cluster (Aider, SWE-agent, OpenHands core, LangGraph/CrewAI, PaperQA2, STORM,
Nous Hermes Agent) is real, but clusters around ML-research proximity — and OpenHands still
ships a TS web UI, because the browser makes JS unavoidable in any case.

**Where Python wins for THIS product — run as sidecars over HTTP/subprocess (Jupyter pattern:
TS frontend, Python kernels):** scientific PDF parsing (docling — top of the May-2026 200-PDF
benchmark at 0.877 — marker, MinerU are all Python-only), NLI entailment verification
(MiniCheck/DeBERTa via vLLM or Ollama), and the verifier evaluation harness. These are
stateless batch workloads with clean process boundaries — the same pattern GROBID (Java)
already forces, and the same one OpenScience (Bun core + Python skill scripts) uses in production.

TypeScript everywhere in the core: one language across CLI, server, agent, and UI — and it
lets us port OpenScience's Apache-licensed TS connectors directly.

**Runtime & CLI**
- **Bun** + TypeScript monorepo; shipped as standalone per-platform executables (one-line installer) and as the `abstract-cli` npm package
  from day one. CLI via **clipanion** (or commander).
- **Hono** local HTTP server (binds 127.0.0.1, Host/Origin allowlist) serving the workspace UI
  + session API; **SSE** for streaming chat, tool calls, and the live activity feed.
- Jobs: in-process queue (**p-queue**) — a local app needs no external job runner.

**Agent & provider layer** → see §6b.

**Storage**
- **SQLite** (`bun:sqlite`) per workspace: sources, chunks, verdicts, memory, project state.
- **sqlite-vec** for dense vectors, **FTS5** for BM25 — hybrid retrieval with rank fusion.
- Source files (PDFs etc.) on disk under the workspace data dir; content-hash addressed.

**Ingestion & parsing**
- **GROBID** via Docker (optional but recommended; auto-detected) for section-aware PDF
  parsing with coordinates; fallback: **unpdf**/pdf.js text extraction (degraded, flagged).
- Web/blog URLs: **@mozilla/readability** + **turndown** (HTML → clean markdown).
- Images/figures: read via the selected vision-capable model.
- Metadata: **Crossref + OpenAlex REST** (connectors ported from OpenScience, TS → TS).

**Citations & export**
- **citeproc-js** + official **CSL styles** repo (APA/IEEE/thousands more) — same engine
  Zotero uses; BibTeX via **citation-js**.
- Export: **pandoc** (bundled or auto-detected) → LaTeX / DOCX / Markdown + the audit file
  (JSON + HTML rendering).
- Retractions: Crossref retraction metadata (includes Retraction Watch data).

**Frontend (workspace UI)**
- **Vite + React**, **Tailwind + shadcn/ui**, TanStack Query/Router.
- Draft review pane: **ProseMirror/TipTap** — per-sentence verification badges as decorations,
  tracked-change review for reviewer/rebuttal modes.
- Source pane: **pdf.js** with highlight overlay — click a claim, PDF scrolls to the passage.
- Math: **KaTeX**. Diagrams/figures render inline like OpenScience.

## 6b. Provider & model layer (multi-provider, multi-model)

**Abstraction: Vercel AI SDK** (`ai` + `@ai-sdk/*` providers) — one `streamText`/tool-calling
interface over every provider; model metadata (context, pricing, capabilities) from the
**models.dev** catalog (the approach opencode/OpenScience validated).

Supported out of the box:
- **Anthropic, OpenAI, Google, Mistral, DeepSeek, Groq, xAI** via their `@ai-sdk/*` packages
  and the user's own keys (BYOK — keys stored locally, requests go direct).
- **OpenRouter** as an aggregator (one key, ~200 models) for everything else.
- **Local models via Ollama** (and any OpenAI-compatible endpoint, e.g. llama.cpp, vLLM) —
  a fully-offline mode: local orchestrator + local embeddings (nomic-embed) + local verifier.

> **Update (0.1.0):** the shipped app uses ONE chat model, picked in the chat box, for every role
> below except embeddings (chosen automatically). The roles remain as internal labels; the table
> records the original per-role design.

**Models are selected per ROLE, not globally** — this is where Abstract differs from a
generic chat app:

| Role | Default tier | User-selectable? | Notes |
|---|---|---|---|
| Orchestrator/writer | frontier (Anthropic/OpenAI/Google class) | ✅ freely | quality of prose & planning |
| Entailment verifier | small-fast (Haiku/mini class) | ✅ with calibration | see below |
| Screener/extractor | small-fast | ✅ freely | bulk, cheap |
| Embeddings | Voyage / OpenAI / Gemini / nomic (local) | ✅ per workspace | switching = reindex |
| Memory distiller | small-fast | ✅ freely | nightly batch |

**Verifier calibration rule:** the verifier gates the brand, so model choice here is free but
never blind — each verifier model ships with (or locally measures, via the §9 spike harness)
a precision score on the entailment benchmark, shown next to the selection; and the **audit
file records which model verified every claim**. If a user picks a weak verifier, the audit
says so. Structural gates (chunk-ID validation, verbatim-quote check, DOI resolution,
citation rendering) are provider-independent deterministic code — they hold regardless of
model choice.

## 7. Reused from OpenScience (Apache-2.0, with attribution)

- `backend/cli/src/science/connectors/literature/` — 7 connectors + retry/rate-limit HTTP layer
  (TypeScript → TypeScript, near-direct port).
- `skills/writing/citation-management/scripts/validate_citations.py` — seed for the export
  auditor (extend: retraction feed, entailment).
- `skills/research/peer-review` + `skills/writing/venue-templates` — reviewer rubrics, venue
  expectations, rebuttal templates → seed content for reviewer mode.
- `science/provenance/store.ts` — content-addressed DAG pattern (make `claim→passage` a
  first-class edge; add the export surface they never built).

## 8. v0.1 scope

**Journey: "my folder → verified related-work section."**

IN: CLI → local server → browser workspace · provider settings (BYOK keys, model-per-role
selection, Ollama/local support) · workspace + source upload (PDF/md first) · ingestion +
metadata gate · folder chat with passage-pinned answers · one artifact type (related-work
draft) with outline checkpoint, per-section approval, verification badges, split-pane source
viewer · BibTeX export with metadata check + audit file · live activity feed.

OUT (v0.1): global search connectors (v0.2), reviewer mode, rebuttal journey, style learning
(static style-notes field instead), memory dashboard, teams, Zotero sync, web-URL ingestion.

## 9. Build order (verify the bet first)

1. **Week 0 spike — the verifier.** Corpus: ~30 pairs of (real related-work sentences ×
   candidate passages) from the founder's own papers, including synthesis claims. Measure
   entailment precision/recall, especially false-"verified" on synthesis. **Kill/pivot
   threshold: if false-verified can't be pushed near zero on hedged multi-source claims,
   redesign (e.g., claim-set verification, forced claim decomposition) before building
   anything else.**
2. Ingestion + metadata gate + hybrid retrieval (test corpus: `~/pfe`).
3. Folder chat with passage pins (Journey D — immediate daily value).
4. `draft_section` with structural gate + verifier + badges.
5. Citation renderer + export auditor + audit file.
6. Live activity feed polish; then v0.2: scholarly connectors, reviewer mode, rebuttal.

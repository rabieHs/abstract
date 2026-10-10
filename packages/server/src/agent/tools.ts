import { generateText, tool } from "ai"
import { z } from "zod"
import { join, relative, resolve, extname } from "node:path"
import { existsSync, readdirSync, statSync, readFileSync } from "node:fs"
import { addNote, memoryPressure, type Database, type Workspace } from "@abstract/core"
import { embedMissing, hybridSearch, ingestFile } from "@abstract/ingest"
import { effectiveRoleSpec, embedderForRole, resolveModel } from "@abstract/providers"
import {
  extractCitationPdfUrl, extractDoiFromUrl, PDF_FETCH_HEADERS, referencesFromCsl,
  resolvePdfCandidates, searchScholar, snowballByDoi,
} from "@abstract/scholar"
import { quoteIsVerbatim } from "@abstract/verifier"
import {
  linkCandidateToSource, logSearch, prismaFlowMarkdown, recordScreening, renderLibraryState,
  upsertCandidates,
} from "./ledger.ts"
import { mkdirSync, writeFileSync } from "node:fs"
import { draftSection, narrationLintRuns } from "./draft.ts"
import { statEntry } from "../tree.ts"
import { checkDoi, exportDraft } from "./export.ts"
import { blockedTasks, droppedTasks, getPlan, renderPlanLines, setPlan, startableTasks, type Todo } from "./plan.ts"
import { centralConcepts, extractGraph, graphSize, neighbors, sharedConcepts } from "./graph.ts"
import { listSkillFiles, listSkills, matchSkills, readSkill, readSkillFile, sanitizeSkillName, saveSkill } from "./skills.ts"
import { scanDois } from "./review.ts"
import { synthesizeSources } from "./synthesize.ts"
import { inventoryPdf } from "./visuals.ts"
import { renderView } from "./view.ts"
import { listNotes, logRead, pagesText, readingProgress, readNote, saveNote } from "./notes.ts"

const SOURCE_EXTS = new Set([".pdf", ".md", ".markdown", ".txt", ".tex", ".bib", ".png", ".jpg", ".jpeg"])
// "figures" holds view_page render artifacts — derived from sources, never a
// source itself (listing them would let renders be re-ingested and cited)
const IGNORED_DIRS = new Set(["node_modules", ".git", ".openpaper", "dist", "__pycache__", "figures"])
const MAX_FILES = 300
const MAX_READ_CHARS = 60_000

export function listSourceFiles(workspace: Workspace): { path: string; size: number }[] {
  const files: { path: string; size: number }[] = []
  walk(workspace.root, workspace.root, files)
  return files
}

function walk(dir: string, root: string, out: { path: string; size: number }[]): void {
  if (out.length >= MAX_FILES) return
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return // unreadable folder: skip it
  }
  for (const entry of entries) {
    if (out.length >= MAX_FILES) return
    if (entry.startsWith(".") || IGNORED_DIRS.has(entry)) continue
    const full = join(dir, entry)
    const stat = statEntry(full) // broken links skipped; linked folders not followed
    if (!stat) continue
    if (stat.isDirectory()) walk(full, root, out)
    else if (SOURCE_EXTS.has(extname(entry).toLowerCase())) {
      out.push({ path: relative(root, full), size: stat.size })
    }
  }
}

/** Resolve a workspace-relative path and refuse anything that escapes the workspace. */
function safePath(workspace: Workspace, p: string): string {
  const full = resolve(workspace.root, p)
  if (full !== workspace.root && !full.startsWith(workspace.root + "/")) {
    throw new Error(`path escapes the workspace: ${p}`)
  }
  return full
}

export function makeTools(workspace: Workspace, db: Database, currentSession?: string) {
  /** fresh (non-revise) drafts produced in THIS turn — the anti-redraft-spiral gate */
  const freshDraftsThisTurn: string[] = []
  /** draft passes per document THIS turn — the anti-perfectionism-spiral gate.
   *  Observed live: one turn ran FOUR full write+verify passes of the same
   *  document unprompted (~4× the writer+verifier spend) chasing marginal
   *  verdict gains. Initial + 2 self-revisions per turn; more needs the user. */
  const draftPassesThisTurn = new Map<string, number>()
  /** queries run THIS turn — the result-side teaching that one query ≠ a strategy */
  const searchesThisTurn: string[] = []
  // skills loaded THIS turn (use_skill); prior turns are read from the DB when
  // the plan echo needs them — together: what expertise is already in context
  const loadedSkillsThisTurn = new Set<string>()
  const skillsLoadedBefore = (): Set<string> => {
    const names = new Set(loadedSkillsThisTurn)
    if (!currentSession) return names
    const rows = db
      .query("SELECT parts FROM messages WHERE session_id = ? AND parts LIKE '%tool-use_skill%'")
      .all(currentSession) as { parts: string }[]
    for (const r of rows) {
      try {
        for (const p of JSON.parse(r.parts) as {
          type?: string
          input?: { name?: string }
          output?: { instructions?: string; error?: string }
        }[]) {
          // only a SUCCESSFUL load counts as "expertise in context" — an
          // interrupted or errored use_skill (no instructions delivered) must
          // not permanently silence the echo for the rest of the session
          if (
            p.type === "tool-use_skill" &&
            p.input?.name &&
            p.output?.instructions &&
            !p.output.error
          ) {
            names.add(p.input.name.toLowerCase().trim())
          }
        }
      } catch {
        /* unparseable historical row — skip */
      }
    }
    return names
  }
  /** A/B kill-switch for the plan feature (used by the enhancement benchmark) */
  const planDisabled = !!process.env["ABSTRACT_NO_PLAN"]

  /** vision-model transcription for scanned PDFs (empty text layer) */
  async function visionOcr(absPath: string, pages: number): Promise<string[]> {
    const spec = (await effectiveRoleSpec("screener")) ?? (await effectiveRoleSpec("orchestrator"))
    if (!spec) throw new Error("no vision model configured for OCR")
    const bytes = readFileSync(absPath)
    if (bytes.byteLength > 18_000_000) throw new Error("scanned PDF larger than 18MB — split it first")
    const model = resolveModel(spec)
    const out: string[] = new Array(pages).fill("")
    const BATCH = 10
    for (let from = 1; from <= pages; from += BATCH) {
      const to = Math.min(from + BATCH - 1, pages)
      const { text } = await generateText({
        // inner calls need the lead loop's resilience: retry connection-class failures
        maxRetries: 8,
        model,
        messages: [
          {
            role: "user",
            content: [
              { type: "file" as const, data: bytes, mediaType: "application/pdf" },
              {
                type: "text" as const,
                text:
                  `This PDF has no machine-readable text layer. Transcribe pages ${from} to ${to} ` +
                  "verbatim as plain text, in natural reading order (handle multi-column layouts " +
                  "correctly). Start each page with a line exactly like ===PAGE 3=== . Render " +
                  "tables as plain text rows. Do not summarize, comment, or omit body text.",
              },
            ],
          },
        ],
      })
      for (const m of text.matchAll(/===PAGE (\d+)===\n?([\s\S]*?)(?====PAGE \d+===|$)/g)) {
        const idx = parseInt(m[1]!, 10) - 1
        if (idx >= 0 && idx < pages) out[idx] = m[2]!.trim()
      }
    }
    return out
  }

  /** ingest + (for new PDFs) catalog figures/tables into the search index */
  async function ingestWithVisuals(rel: string, doiHint?: string | null) {
    // analysis/ artifacts are LOCAL COMPUTATION, never literature: registry
    // resolution must not title-match them to some paper (observed live: a
    // results summary graded peer_reviewed). They stay grade "note".
    const isAnalysis = rel.startsWith("analysis/")
    const r = await ingestFile(db, workspace, rel, { ocr: visionOcr, doiHint, resolve: !isAnalysis })
    if (r.kind !== "pdf" || r.alreadyIngested) return r
    const spec = (await effectiveRoleSpec("screener")) ?? (await effectiveRoleSpec("orchestrator"))
    if (!spec) return { ...r, visuals: { skipped: "no vision model configured" } }
    try {
      return { ...r, visuals: await inventoryPdf(db, workspace, rel, resolveModel(spec)) }
    } catch (err) {
      return { ...r, visuals: { skipped: err instanceof Error ? err.message : String(err) } }
    }
  }

  async function embedNew() {
    try {
      const embed = await embedderForRole()
      if (embed) await embedMissing(db, embed)
    } catch {
      // embeddings are an enhancement — never fail ingest/search over them
    }
  }

  const tools = {
    ingest_source: tool({
      description:
        "Ingest a file (pdf, md, txt) from the workspace into the searchable library: " +
        "extracts text, chunks it with page numbers, and indexes it. Idempotent.",
      inputSchema: z.object({
        path: z.string().describe("workspace-relative path, as returned by list_sources"),
      }),
      execute: async ({ path }) => {
        safePath(workspace, path)
        try {
          const r = await ingestWithVisuals(path)
          await embedNew()
          return r
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) }
        }
      },
    }),

    read_pages: tool({
      description:
        "Read a few pages of an ingested PDF at a time (max 6 per call) — the incremental " +
        "reading unit. NEVER try to read a whole long paper at once; page through it, saving " +
        "findings to the source's note as you go. Returns page-marked text and total pages.",
      inputSchema: z.object({
        path: z.string(),
        from_page: z.number().int().min(1),
        to_page: z.number().int().min(1),
      }),
      execute: async ({ path, from_page, to_page }) => {
        safePath(workspace, path)
        const readTo = Math.min(to_page, from_page + 5)
        const r = pagesText(db, path, from_page, readTo)
        if ("error" in r) return r
        logRead(db, path, from_page, readTo)
        // figures/tables cataloged on these pages: text extraction cannot show
        // them, so surface what exists and how to look at it
        const visuals = (
          db
            .query(
              `SELECT c.page, substr(c.text, 1, 160) AS t FROM chunks c
               JOIN sources s ON s.id = c.source_id
               WHERE s.path = ? AND c.page BETWEEN ? AND ? AND c.text LIKE '[VISUAL]%'
               ORDER BY c.page`,
            )
            .all(path, from_page, readTo) as { page: number; t: string }[]
        ).map((v) => `p.${v.page}: ${v.t.replace(/^\[VISUAL\]\s*/, "")}`)
        const prog = readingProgress(db, path)
        // tool outputs must be strict JSON values (no `undefined` fields) —
        // they are replayed as model messages by the resume loop
        return {
          ...r,
          // a silent clamp reads as "that was the whole range" — say it (C8)
          ...(to_page > readTo
            ? {
                clamped: {
                  requested: `${from_page}-${to_page}`,
                  delivered: `${from_page}-${readTo}`,
                  note: `pages are read 6 at a time — continue with read_pages from page ${readTo + 1}`,
                },
              }
            : {}),
          ...(visuals.length > 0
            ? {
                figures_on_these_pages: {
                  list: visuals,
                  hint: "text extraction cannot show these — if one matters to the task, LOOK at it (view_page for first-hand judgment, ask_document for a transcription) before relying on prose about it",
                },
              }
            : {}),
          ...(prog
            ? {
                coverage:
                  prog.unread === "none"
                    ? `full coverage: all ${prog.totalPages} pages have been read`
                    : `read ${prog.readPages}/${prog.totalPages} pages so far — UNREAD: ${prog.unread}. For full-document tasks continue until coverage is complete before claiming you read/analyzed it`,
              }
            : {}),
        }
      },
    }),

    save_note: tool({
      description:
        "Save to a source's private reading note (free-form markdown — write whatever serves " +
        "the user's need: findings, structure, key numbers WITH page refs, quotes, questions, " +
        "what a viewed figure shows, or table transcriptions from ask_document). Append as you read — do not " +
        "wait until the end. Notes are hidden from the file panel and are NEVER citable " +
        "evidence; cite only retrieved passages.",
      inputSchema: z.object({
        source_path: z.string().describe("the source file this note is about"),
        content: z.string().min(1),
        mode: z.enum(["append", "overwrite"]).default("append"),
      }),
      execute: async ({ source_path, content, mode }) => {
        safePath(workspace, source_path)
        return saveNote(workspace, source_path, content, mode)
      },
    }),

    read_note: tool({
      description:
        "Read the private note for a source (pass source_path), or list which sources have " +
        "notes (no argument). ALWAYS check here before re-reading a paper you may have read " +
        "before.",
      inputSchema: z.object({
        source_path: z.string().optional(),
      }),
      execute: async ({ source_path }) => {
        if (!source_path) return { sources_with_notes: listNotes(workspace) }
        const note = readNote(workspace, source_path)
        const progress = readingProgress(db, source_path)
        return note
          ? { source_path, note, reading_progress: progress }
          : { source_path, note: null, reading_progress: progress, hint: "no note yet" }
      },
    }),

    view_page: tool({
      description:
        "LOOK at a page with your own eyes. Renders the page (pdf, or a png/jpg file) to a " +
        "PNG saved under figures/ and attaches the ACTUAL PIXELS to your context — you see " +
        "the figure first-hand, holding your full working context, instead of reading a " +
        "second-hand description of it. Reach for this whenever your JUDGMENT of a visual " +
        "matters: architecture diagrams, result charts, UI screenshots, figure-versus-prose " +
        "checks, anything where detail decides. The last few views stay attached; if one " +
        "ages out, view it again. For bulk table transcription or questions across a whole " +
        "scanned document, ask_document is the economical companion.",
      inputSchema: z.object({
        path: z.string().describe("workspace-relative path to a pdf/png/jpg"),
        page: z.number().int().min(1).default(1).describe("page number (PDFs; 1-based)"),
      }),
      execute: async ({ path, page }) => {
        const full = safePath(workspace, path)
        const res = await renderView(workspace, path, full, page)
        if ("error" in res) return res
        logRead(db, path, res.page, res.page) // seeing a page OPENS the source (citable)
        return res
      },
    }),

    ask_document: tool({
      description:
        "Ask a side question of a whole document with full visual fidelity — the actual " +
        "file goes to the vision model, which answers your question in text. The workhorse " +
        "for TRANSCRIPTION and bulk lookups: a table's numbers as a pipe table, equations, " +
        "scanned documents with no text layer, or 'which page shows X'. The answer is a " +
        "second-hand report — when you need to JUDGE a specific figure yourself, view_page " +
        "puts the real pixels in front of you instead. Works on pdf, png, jpg. Ask a " +
        "focused question.",
      inputSchema: z.object({
        path: z.string().describe("workspace-relative path"),
        question: z
          .string()
          .describe("what to extract or explain, e.g. 'transcribe Table 2' or 'describe Figure 3'"),
      }),
      execute: async ({ path, question }) => {
        const full = safePath(workspace, path)
        const ext = extname(full).toLowerCase()
        const mediaType =
          ext === ".pdf" ? "application/pdf"
          : ext === ".png" ? "image/png"
          : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg"
          : null
        if (!mediaType) return { error: `ask_document supports pdf/png/jpg, got ${ext}` }
        const bytes = readFileSync(full)
        if (bytes.byteLength > 18_000_000) {
          return { error: "file larger than 18MB — split it or ask about a smaller document" }
        }
        const spec = await effectiveRoleSpec("orchestrator")
        if (!spec) return { error: "no model configured" }
        try {
          const { text } = await generateText({
            // inner calls need the lead loop's resilience: retry connection-class failures
            maxRetries: 8,
            model: resolveModel(spec),
            messages: [
              {
                role: "user",
                content: [
                  mediaType === "application/pdf"
                    ? { type: "file" as const, data: bytes, mediaType }
                    : { type: "image" as const, image: bytes },
                  {
                    type: "text" as const,
                    text:
                      "Answer strictly from this document. If the answer is not visible in it, say so. " +
                      "Answer in GitHub-flavored Markdown; transcribe tabular data as GFM pipe tables; " +
                      `never output raw HTML tags.\n\n${question}`,
                  },
                ],
              },
            ],
          })
          logRead(db, path, 1, 1) // a visual read OPENS the source (citable)
          return { answer: text, source: path, mode: "vision" }
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) }
        }
      },
    }),

    remember: tool({
      description:
        "Save a long-term memory note (style rule, preference, project fact, or lesson). " +
        "Two modes: explicit=true when the USER EXPLICITLY asked to remember something " +
        "('always…', 'from now on…', 'remember that…') — saved ACTIVE immediately, tell " +
        "them it's saved. explicit=false for preferences YOU INFERRED from their behavior " +
        "— saved PENDING their approval in the Memory panel; never claim an inferred note " +
        "is already in effect.",
      inputSchema: z.object({
        kind: z.enum(["style", "preference", "project", "lesson"]),
        content: z.string().min(8).max(400).describe("one concise, standing instruction"),
        explicit: z
          .boolean()
          .describe("true ONLY for a direct user request to remember; false when inferred"),
      }),
      execute: async ({ kind, content, explicit }) => {
        const note = addNote(db, kind, content, explicit)
        const pressure = memoryPressure(db)
        return {
          id: note.id,
          status: explicit
            ? "saved and active"
            : "pending user approval in the Memory panel",
          // error-not-truncate: an over-budget store asks for consolidation
          // instead of silently dropping old notes from recall
          ...(pressure ? { memory_note: pressure } : {}),
        }
      },
    }),

    search_scholar: tool({
      description:
        "Search the GLOBAL scholarly literature (OpenAlex + Crossref + arXiv, deduplicated). " +
        "Returns real metadata from the registries; every query is logged to the search " +
        "record and every result lands in the screening ledger. Use mode 'discovery' " +
        "(default) when building a corpus — queries must be CONCEPT-FIRST: topic terms and " +
        "their synonyms, NEVER tool/method/author names from your own prior knowledge (those " +
        "enter the vocabulary only after appearing in findings). Use mode 'known_item' only " +
        "to locate a specific paper you already know exists (e.g. from a reference list). " +
        "One call is one query, never a search strategy: run several reformulations and " +
        "screen from metadata before fetching. To cite a found paper, first fetch_paper it.",
      inputSchema: z.object({
        query: z.string(),
        k: z.number().int().min(1).max(30).default(12),
        mode: z.enum(["discovery", "known_item"]).default("discovery"),
        year_from: z.number().int().min(1900).optional().describe("only work published in/after this year"),
        year_to: z.number().int().min(1900).optional().describe("only work published in/before this year"),
        sort: z
          .enum(["citations", "recency", "relevance"])
          .default("citations")
          .describe(
            "citations = foundational-first (buries recent + arXiv work — pair with a recency " +
            "pass); recency = newest-first (REQUIRED at least once per discovery topic, or the " +
            "last 2 years are invisible); relevance = registry ranking interleaved",
          ),
      }),
      execute: async ({ query, k, mode, year_from, year_to, sort }) => {
        const results = await searchScholar(query, k, undefined, {
          yearFrom: year_from,
          yearTo: year_to,
          sort,
        })
        searchesThisTurn.push(query)
        let candidatesAdded: number | null = null
        try {
          logSearch(db, currentSession, "scholar", query, mode, results.length)
          candidatesAdded = upsertCandidates(
            db,
            results.map((r) => ({ title: r.title, doi: r.doi, year: r.year, venue: r.venue, citedBy: r.citedBy })),
            `query:${query.slice(0, 150)}`,
          ).added
        } catch {
          /* the ledger must never break a search */
        }
        return {
          results: results.map((r) => ({
            title: r.title, authors: r.authors, year: r.year, venue: r.venue,
            doi: r.doi, citedBy: r.citedBy, url: r.url, pdfUrl: r.pdfUrl,
            abstract: r.abstract?.slice(0, 400) ?? null,
          })),
          search_log: `${searchesThisTurn.length} quer${searchesThisTurn.length === 1 ? "y" : "ies"} this turn (recorded, with hit counts, for the methods section)`,
          // the saturation input: a reformulation that adds nothing NEW is a
          // convergence datum (Wohlin closure), not a wasted call
          ...(candidatesAdded !== null ? { new_candidates: candidatesAdded } : {}),
          ...(searchesThisTurn.length === 1 && results.length > 3
            ? {
                note:
                  "one query is one FRAMING, not a search strategy — run further reformulations " +
                  "(synonyms, subtopics, adjacent phrasings) and at least one recency-sorted pass " +
                  "before concluding coverage; snowball from whichever papers prove central",
              }
            : {}),
        }
      },
    }),

    snowball: tool({
      description:
        "Walk a paper's CITATION CHAIN — backward (the works it references: what it builds " +
        "on) and forward (the works citing it: who builds on or contests it). This is how " +
        "researchers actually build corpora: key papers lead to the real related work, " +
        "including tools and methods your own vocabulary would never surface. Use it on " +
        "EVERY paper that proves central to the topic, then screen the candidates " +
        "(record_screening) and fetch the ones that pass. Iterate: snowball newly included " +
        "papers too, until a hop adds nothing new — that closure, not a count, is what " +
        "'searched enough' means. Prefer a library source_path (its stored reference list " +
        "works even offline); a bare DOI also works.",
      inputSchema: z.object({
        source_path: z.string().optional().describe("a library paper — uses its registry metadata"),
        doi: z.string().optional().describe("or a DOI directly (e.g. from search results)"),
        direction: z.enum(["both", "backward", "forward"]).default("both"),
        k: z.number().int().min(1).max(50).default(20).describe("max candidates per direction"),
      }),
      execute: async ({ source_path, doi, direction, k }) => {
        let effDoi = doi ?? null
        let cslRefs: { doi: string | null; title: string | null; raw: string }[] = []
        if (source_path) {
          const row = db
            .query("SELECT doi, csl_json FROM sources WHERE path = ?")
            .get(source_path) as { doi: string | null; csl_json: string | null } | null
          if (!row) return { error: `no library source at ${source_path} — pass a doi instead` }
          effDoi = effDoi ?? row.doi
          if (row.csl_json) {
            try {
              cslRefs = referencesFromCsl(JSON.parse(row.csl_json))
            } catch {
              /* malformed stored CSL — network path still works */
            }
          }
        }
        if (!effDoi && cslRefs.length === 0) {
          return {
            error:
              "no DOI known for this paper and no stored reference list — snowball needs a " +
              "registry-matched source or an explicit doi. search_scholar (known_item) can find the DOI.",
          }
        }
        const seedLabel = source_path ?? effDoi ?? "?"
        const hops = effDoi ? await snowballByDoi(effDoi, { direction, limit: k }) : { error: "no doi" }
        const netFailed = "error" in hops
        // network backward hop wins (full metadata); the stored CSL reference
        // list is the zero-network fallback (titles/DOIs only)
        const backward = !netFailed
          ? hops.backward
          : direction !== "forward"
            ? cslRefs.slice(0, k).map((r) => ({
                title: r.title ?? r.raw.slice(0, 150), doi: r.doi, year: null as number | null,
                venue: null as string | null, citedBy: null as number | null,
              }))
            : []
        const forward = !netFailed ? hops.forward : []
        const inLibrary = new Set(
          (db.query("SELECT doi FROM sources WHERE doi IS NOT NULL").all() as { doi: string }[]).map((r) =>
            r.doi.toLowerCase(),
          ),
        )
        const tag = (list: { title: string; doi?: string | null; year?: number | null; venue?: string | null; citedBy?: number | null }[]) =>
          list.map((r) => ({
            title: r.title, doi: r.doi ?? null, year: r.year ?? null, venue: r.venue ?? null,
            citedBy: r.citedBy ?? null,
            ...(r.doi && inLibrary.has(r.doi.toLowerCase()) ? { already_in_library: true } : {}),
          }))
        let hopAdded: number | null = null
        try {
          logSearch(db, currentSession, `snowball:${direction}`, seedLabel, "snowball", backward.length + forward.length)
          const b = upsertCandidates(db, backward, `snowball:${seedLabel}:backward`)
          const f = upsertCandidates(db, forward, `snowball:${seedLabel}:forward`)
          hopAdded = b.added + f.added
        } catch {
          /* the ledger must never break a snowball */
        }
        return {
          seed: seedLabel,
          // Wohlin closure datum: a hop that adds nothing new means done
          ...(hopAdded !== null ? { new_candidates: hopAdded } : {}),
          ...(netFailed && backward.length > 0
            ? { note: "OpenAlex had no record — backward list comes from the paper's stored reference list (titles/DOIs only, no citation counts)" }
            : {}),
          ...(netFailed && backward.length === 0 ? { error: (hops as { error: string }).error } : {}),
          backward: tag(backward),
          forward: tag(forward),
          next:
            "screen these candidates (record_screening with include/exclude + reason), fetch " +
            "the included ones, and snowball the papers that prove central in turn — stop when " +
            "an iteration adds nothing new",
        }
      },
    }),

    record_screening: tool({
      description:
        "Record screening decisions in the ledger — the researcher's screening log. Every " +
        "candidate you consciously include or exclude gets a decision WITH a reason (screen " +
        "from title/abstract/venue metadata; cheap criteria first). The funnel and the " +
        "exportable PRISMA flow render from this record; an unscreened candidate counts " +
        "against coverage forever. Batch several decisions per call.",
      inputSchema: z.object({
        decisions: z
          .array(
            z.object({
              ref: z.string().describe("the candidate's DOI, or a distinctive part of its exact title"),
              decision: z.enum(["include", "exclude"]),
              reason: z.string().min(3).max(200).describe("the criterion applied, e.g. 'off-topic: edge only', 'core: joint fairness+energy metric'"),
              relevance: z.enum(["high", "related", "no"]).optional(),
            }),
          )
          .min(1)
          .max(30),
      }),
      execute: async ({ decisions }) => {
        const r = recordScreening(db, decisions)
        return {
          updated: r.updated,
          ...(r.unmatched.length > 0
            ? { unmatched: r.unmatched, note: "unmatched refs — use the DOI or a longer exact-title fragment" }
            : {}),
          library_state: renderLibraryState(db, workspace),
        }
      },
    }),

    novelty_scan: tool({
      description:
        "Check a research idea against the literature BEFORE months get invested in it. " +
        "You pass the idea plus 2-5 CONCEPT queries decomposing it (each one concept + " +
        "synonyms — the INTERSECTION of concepts is where novelty lives or dies). The scan " +
        "runs every query, maps which papers match how many concepts (multi-concept " +
        "matches = the closest prior art), and walks one forward-citation hop from the " +
        "closest neighbor so terminology-independent prior work surfaces too. The VERDICT " +
        "stays with you and the user: read the closest papers before any novelty claim, " +
        "state overlaps precisely ('X does A+B but not C'), and always bound the claim to " +
        "this search — novelty can only fail to be disproven, never be proven.",
      inputSchema: z.object({
        idea: z.string().min(10).describe("the claimed contribution, in 1-2 sentences"),
        concept_queries: z
          .array(z.string())
          .min(2)
          .max(5)
          .describe("concept-block queries, one concept (with synonyms) each"),
        k: z.number().int().min(5).max(25).default(12).describe("results per query"),
      }),
      execute: async ({ idea, concept_queries, k }) => {
        type Lite = { title: string; doi: string | null; year: number | null; venue: string | null; citedBy: number | null; abstract: string | null; url: string | null }
        const byKey = new Map<string, { r: Lite; matched: Set<string> }>()
        for (const q of concept_queries) {
          const results = await searchScholar(q, k, undefined, { sort: "relevance" })
          searchesThisTurn.push(q)
          try {
            logSearch(db, currentSession, "scholar", q, "novelty", results.length)
          } catch { /* ledger must never break the scan */ }
          for (const r of results) {
            const key = r.doi
              ? `doi:${r.doi.toLowerCase()}`
              : `t:${r.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}`
            const e = byKey.get(key) ?? {
              r: { title: r.title, doi: r.doi, year: r.year, venue: r.venue, citedBy: r.citedBy, abstract: r.abstract?.slice(0, 300) ?? null, url: r.url },
              matched: new Set<string>(),
            }
            e.matched.add(q)
            byKey.set(key, e)
          }
        }
        const entries = [...byKey.values()].sort(
          (a, b) => b.matched.size - a.matched.size || (b.r.citedBy ?? 0) - (a.r.citedBy ?? 0),
        )
        // one forward hop from the closest multi-concept neighbor: whoever
        // BUILDS ON the nearest prior art is prior art the queries may miss
        let buildingOnClosest: { title: string; doi: string | null; year: number | null; citedBy: number | null }[] = []
        const top = entries.find((e) => e.matched.size >= 2 && e.r.doi)
        if (top?.r.doi) {
          const hops = await snowballByDoi(top.r.doi, { direction: "forward", limit: 10 })
          if (!("error" in hops)) {
            buildingOnClosest = hops.forward.map((f) => ({ title: f.title, doi: f.doi, year: f.year, citedBy: f.citedBy }))
            try {
              logSearch(db, currentSession, "snowball:forward", top.r.doi, "novelty", buildingOnClosest.length)
            } catch { /* ledger must never break the scan */ }
          }
        }
        try {
          upsertCandidates(db, entries.slice(0, 40).map((e) => e.r), `novelty:${idea.slice(0, 120)}`)
        } catch { /* ledger must never break the scan */ }
        const closest = entries
          .filter((e) => e.matched.size >= 2)
          .slice(0, 10)
          .map((e) => ({ ...e.r, matched_concepts: e.matched.size, matched_queries: [...e.matched] }))
        return {
          idea,
          closest,
          single_concept_matches: entries.filter((e) => e.matched.size === 1).length,
          ...(buildingOnClosest.length > 0 ? { building_on_closest: buildingOnClosest } : {}),
          verdict_note:
            closest.length === 0
              ? "no paper matched 2+ concept queries WITHIN THIS SEARCH — absence of evidence, " +
                "not proof of novelty: reformulate the concepts once more (different synonyms), " +
                "snowball from the strongest single-concept matches, and only then report " +
                "'no close prior art found within my search'"
              : "read the closest 1-3 papers (fetch + screen) before any novelty verdict — a " +
                "novelty check READS NEAREST NEIGHBORS, it does not build a corpus (each fetch " +
                "costs ingest + vision inventory); state each overlap precisely ('does A+B but " +
                "not C') and bound the conclusion to this search",
        }
      },
    }),

    run_code: tool({
      description:
        "Run a small python3 ANALYSIS script on the user's own data files (CSV/JSON/text) " +
        "inside the workspace — statistics, aggregation, consistency checks, plots-as-data. " +
        "Numbers in any deliverable must come from EXECUTED computation, never from your " +
        "own arithmetic: run the analysis, then cite its artifact. The script runs with " +
        "cwd = workspace root, a wall-clock cap, capped output, and NO provider credentials " +
        "in its environment. Write outputs under analysis/ — they become workspace files " +
        "you can ingest and cite like any source. NOT for software development, network " +
        "calls, or anything outside analyzing the data at hand.",
      inputSchema: z.object({
        script: z
          .string()
          .min(10)
          .max(20_000)
          .describe("python3 (stdlib) script; read data by workspace-relative path; write outputs under analysis/"),
        timeout_s: z.number().int().min(1).max(120).default(60),
      }),
      execute: async ({ script, timeout_s }) => {
        // Boundary honesty: this is a LOCAL single-user tool. The enforced
        // walls are credential stripping + workspace cwd + time/output caps;
        // an OS-level jail (container/bwrap) is the hardening path if this
        // app ever runs multi-user.
        mkdirSync(join(workspace.root, "analysis"), { recursive: true })
        const stamp = Date.now()
        const scriptRel = join("analysis", `script-${stamp}.py`)
        writeFileSync(join(workspace.root, scriptRel), script)
        const before = new Set(readdirSync(join(workspace.root, "analysis")))
        const cleanEnv: Record<string, string> = {
          PATH: process.env["PATH"] ?? "/usr/bin:/bin",
          HOME: workspace.root,
          LANG: process.env["LANG"] ?? "en_US.UTF-8",
        }
        let killed = false
        const proc = Bun.spawn(["python3", scriptRel], {
          cwd: workspace.root,
          env: cleanEnv,
          stdout: "pipe",
          stderr: "pipe",
        })
        const timer = setTimeout(() => {
          killed = true
          proc.kill()
        }, timeout_s * 1000)
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ])
        clearTimeout(timer)
        const artifacts = [...readdirSync(join(workspace.root, "analysis"))]
          .filter((f) => !before.has(f))
          .map((f) => join("analysis", f))
        if (killed) {
          return {
            error: `the script exceeded its ${timeout_s}s wall-clock cap and was killed — simplify the analysis or raise timeout_s`,
            script: scriptRel,
            stdout: stdout.slice(0, 4000),
            stderr: stderr.slice(0, 4000),
          }
        }
        return {
          exit_code: exitCode,
          script: scriptRel,
          stdout: stdout.slice(0, 20_000) + (stdout.length > 20_000 ? "\n…[stdout capped]" : ""),
          ...(stderr.trim() ? { stderr: stderr.slice(0, 8_000) } : {}),
          ...(artifacts.length > 0 ? { artifacts } : {}),
          note:
            exitCode === 0
              ? "computed numbers you want to CITE in a draft: write them into an analysis/ file, ingest it, and cite the passage — the verifier then holds them to the same bar as paper quotes"
              : "non-zero exit — read stderr, fix the script, and re-run; never substitute your own arithmetic for a failed computation",
        }
      },
    }),

    save_protocol: tool({
      description:
        "Create or UPDATE the research PROTOCOL artifact — the methodology contract, " +
        "written BEFORE data: research questions (PICOC fields), hypotheses (H0/H1 with " +
        "declared-before-data semantics — a hypothesis added after results exists but is " +
        "labeled post-hoc/exploratory), the study design, and the named " +
        "threats-to-validity checklist where every applicable threat is MITIGATED (with " +
        "how) or explicitly ACCEPTED. Versioned: every update keeps the prior version in " +
        "history, never silently overwritten (Kitchenham). Renders " +
        "drafts/protocol-<slug>.md for the user + .json as the machine artifact. Use for " +
        "methodology design, and consult it when critiquing methods or drafting an " +
        "empirical paper's Methods/Threats sections.",
      inputSchema: z.object({
        slug: z.string().min(2).max(60).describe("stable protocol name, e.g. 'fate-bench-eval'"),
        rqs: z
          .array(
            z.object({
              id: z.string().describe("RQ1, RQ2, …"),
              question: z.string().min(10),
              population: z.string().optional(),
              intervention: z.string().optional(),
              comparison: z.string().optional(),
              outcome: z.string().optional(),
              context: z.string().optional(),
            }),
          )
          .min(1)
          .max(8),
        hypotheses: z
          .array(
            z.object({
              id: z.string().describe("H1, H2, …"),
              h0: z.string().min(5),
              h1: z.string().min(5),
              primary_outcome: z.string().min(3),
              declared_before_data: z
                .boolean()
                .describe("false = post-hoc, will be labeled exploratory in every render"),
            }),
          )
          .max(8)
          .default([]),
        design: z.string().min(10).max(2000).describe("datasets/subjects, procedure, baselines, metrics, analysis plan"),
        threats: z
          .array(
            z.object({
              category: z.enum(["internal", "external", "construct", "conclusion"]),
              name: z.string().min(3).describe("the NAMED threat, e.g. 'selection bias', 'mono-operation bias'"),
              status: z.enum(["mitigated", "accepted"]),
              how: z.string().min(5).describe("the mitigation, or why acceptance is defensible"),
            }),
          )
          .min(1)
          .max(20),
      }),
      execute: async ({ slug, rqs, hypotheses, design, threats }) => {
        const clean = slug.toLowerCase().trim().replace(/[\s_]+/g, "-").replace(/[^a-z0-9-]/g, "")
        mkdirSync(join(workspace.root, "drafts"), { recursive: true })
        const jsonRel = join("drafts", `protocol-${clean}.json`)
        const mdRel = join("drafts", `protocol-${clean}.md`)
        let version = 1
        let history: unknown[] = []
        try {
          const prev = JSON.parse(readFileSync(join(workspace.root, jsonRel), "utf8")) as {
            version: number
            history?: unknown[]
          }
          version = (prev.version ?? 0) + 1
          const { history: _h, ...prevBody } = prev as Record<string, unknown>
          history = [...(prev.history ?? []), prevBody]
        } catch {
          /* first version */
        }
        const artifact = { slug: clean, version, updated_at: new Date().toISOString(), rqs, hypotheses, design, threats, history }
        writeFileSync(join(workspace.root, jsonRel), JSON.stringify(artifact, null, 2))
        const md = [
          `# Research protocol — ${clean} (v${version})`,
          ``,
          `## Research questions`,
          ...rqs.map((q) => {
            const picoc = [
              q.population && `population: ${q.population}`,
              q.intervention && `intervention: ${q.intervention}`,
              q.comparison && `comparison: ${q.comparison}`,
              q.outcome && `outcome: ${q.outcome}`,
              q.context && `context: ${q.context}`,
            ].filter(Boolean)
            return `- **${q.id}** ${q.question}${picoc.length ? `\n  - ${picoc.join(" · ")}` : ""}`
          }),
          ``,
          ...(hypotheses.length
            ? [
                `## Hypotheses`,
                ...hypotheses.map(
                  (h) =>
                    `- **${h.id}**${h.declared_before_data ? "" : " *(post-hoc — exploratory)*"}: H0 ${h.h0} · H1 ${h.h1} · primary outcome: ${h.primary_outcome}`,
                ),
                ``,
              ]
            : []),
          `## Design`,
          design,
          ``,
          `## Threats to validity`,
          `| category | threat | status | how |`,
          `|---|---|---|---|`,
          ...threats.map((t) => `| ${t.category} | ${t.name} | ${t.status} | ${t.how.replace(/\|/g, "\\|")} |`),
          ``,
        ].join("\n")
        writeFileSync(join(workspace.root, mdRel), md)
        const accepted = threats.filter((t) => t.status === "accepted").length
        return {
          file: mdRel,
          dataFile: jsonRel,
          version,
          note:
            `protocol v${version} saved (${version > 1 ? "previous versions kept in history" : "initial"}); ` +
            `${threats.length} threats addressed (${accepted} accepted). Empirical drafts should reference this ` +
            "protocol; results that answer no RQ, or conclusions stronger than the design supports, are findings to flag.",
          ...(hypotheses.some((h) => !h.declared_before_data)
            ? { exploratory_note: "one or more hypotheses are post-hoc — they render as exploratory and must be reported as such" }
            : {}),
        }
      },
    }),

    export_prisma_flow: tool({
      description:
        "Render this review's search & screening record (PRISMA-style) from the ledger: " +
        "every query as run with source/datetime/hits, the identification→screening→" +
        "inclusion funnel as a mermaid flow, and per-reason exclusion counts. Counts come " +
        "from the database, never from memory. Use when the user wants the methods " +
        "appendix, the search record, or the flow diagram.",
      inputSchema: z.object({}),
      execute: async () => {
        const md = prismaFlowMarkdown(db)
        mkdirSync(join(workspace.root, "drafts"), { recursive: true })
        const file = join("drafts", "prisma-flow.md")
        writeFileSync(join(workspace.root, file), md)
        return { file, library_state: renderLibraryState(db, workspace) }
      },
    }),

    save_extraction: tool({
      description:
        "Record ONE structured extraction from a paper into the cross-paper matrix: a field " +
        "(rq | method | dataset | sample_n | metric | result | limitation | contribution | " +
        "custom name) with its value, the chunk id it came from, and a VERBATIM quote from " +
        "that chunk (paraphrases are rejected — copy the exact words). Extract AS YOU " +
        "deep-read: the matrix is what comparison tables and 'which studies used X?' " +
        "queries build from, instead of re-reading everything at write time.",
      inputSchema: z.object({
        source_path: z.string(),
        field: z.string().min(2).max(40).describe("rq | method | dataset | sample_n | metric | result | limitation | contribution | custom name"),
        value: z.string().min(1).max(500).describe("the extracted fact, compact (numbers included)"),
        chunk_id: z.string().describe("the chunk this was read from (from search_library/read results)"),
        quote: z.string().min(5).max(600).describe("VERBATIM span from that chunk supporting the value"),
      }),
      execute: async ({ source_path, field, value, chunk_id, quote }) => {
        const chunk = db
          .query(
            "SELECT c.text FROM chunks c JOIN sources s ON s.id = c.source_id WHERE c.id = ? AND s.path = ?",
          )
          .get(chunk_id, source_path) as { text: string } | null
        if (!chunk) {
          return { error: `chunk ${chunk_id} does not belong to ${source_path} — use a chunk id returned for that source` }
        }
        if (!quoteIsVerbatim(quote, [chunk.text])) {
          return {
            error:
              "the quote is not a verbatim span of that chunk — copy the exact words (the " +
              "matrix is only trustworthy because every cell is quote-anchored)",
          }
        }
        db.query(
          "INSERT INTO extractions (source_path, field, value, chunk_id, quote, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(source_path, field.toLowerCase().trim(), value, chunk_id, quote, Date.now())
        const stats = db
          .query("SELECT COUNT(DISTINCT source_path) s, COUNT(DISTINCT field) f, COUNT(*) n FROM extractions")
          .get() as { s: number; f: number; n: number }
        return { saved: true, matrix_state: `${stats.n} extractions · ${stats.s} papers × ${stats.f} fields` }
      },
    }),

    query_matrix: tool({
      description:
        "Query the extraction matrix across papers: filter by field, value substring, " +
        "and/or source. Answers cross-paper questions ('which studies used ImageNet and " +
        "what accuracy did each report?') from recorded, quote-anchored extractions — no " +
        "re-reading. Each row carries its chunk id: cite by retrieving that passage.",
      inputSchema: z.object({
        field: z.string().optional(),
        value_contains: z.string().optional(),
        source_path: z.string().optional(),
      }),
      execute: async ({ field, value_contains, source_path }) => {
        const conds: string[] = []
        const args: string[] = []
        if (field) {
          conds.push("field = ?")
          args.push(field.toLowerCase().trim())
        }
        if (value_contains) {
          conds.push("value LIKE ?")
          args.push(`%${value_contains.replace(/[%_]/g, "")}%`)
        }
        if (source_path) {
          conds.push("source_path = ?")
          args.push(source_path)
        }
        const rows = db
          .query(
            `SELECT source_path, field, value, quote, chunk_id FROM extractions` +
              (conds.length ? ` WHERE ${conds.join(" AND ")}` : "") +
              ` ORDER BY source_path, field LIMIT 200`,
          )
          .all(...args) as { source_path: string; field: string; value: string; quote: string; chunk_id: string }[]
        if (rows.length === 0) {
          return {
            rows: [],
            note: "no extractions match — the matrix fills as you save_extraction while deep-reading; nothing recorded means nothing was extracted, not that the literature is empty",
          }
        }
        return { rows }
      },
    }),

    fetch_paper: tool({
      description:
        "Download a paper's open-access PDF (by DOI or direct pdfUrl from search_scholar) " +
        "into the workspace library and ingest it through the metadata gate. Returns the " +
        "ingest result including grade. Fails honestly when no OA copy exists.",
      inputSchema: z.object({
        doi: z.string().optional(),
        pdfUrl: z.string().optional(),
        title: z
          .string()
          .optional()
          .describe(
            "the paper's title when you know it (from search/snowball results) — lets the " +
            "library detect the SAME paper across its preprint and published records",
          ),
        filename: z.string().describe("short filename, e.g. smith2024-frugal-ai.pdf"),
      }),
      execute: async ({ doi, pdfUrl, title, filename }) => {
        const noShrink =
          " — a failed fetch must never shrink a review: fetch the next candidate, try the " +
          "arXiv/preprint version, or search again; discuss it from metadata only if flagged unread"
        // DEDUPE: the same paper must never live twice under two filenames
        // (observed live: a DOI fetch + an arXiv retry of the same paper).
        // The effective DOI also becomes the ingest metadata hint, so a paper
        // fetched BY DOI can never be mis-matched to a different registry record.
        const arxivInPdfUrl = /arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})/i.exec(pdfUrl ?? "")?.[1] ?? null
        const effectiveDoi =
          doi?.trim() ??
          (arxivInPdfUrl ? `10.48550/arxiv.${arxivInPdfUrl}` : pdfUrl ? extractDoiFromUrl(pdfUrl) : null)
        const targetRel = join("sources", filename.replace(/[^\w.\- ]/g, "_").replace(/\.pdf$/i, "") + ".pdf")
        // preprint↔published crosswalk (S15): a paper's arXiv and publisher
        // records carry DIFFERENT DOIs — three nets: exact DOI, target
        // filename, and normalized TITLE against the library
        const normTitle = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
        const titleDupe = () => {
          if (!title || normTitle(title).length < 15) return null
          const want = normTitle(title)
          for (const row of db.query("SELECT path, title FROM sources WHERE title IS NOT NULL").all() as {
            path: string
            title: string
          }[]) {
            if (normTitle(row.title) === want) return { path: row.path }
          }
          return null
        }
        const dupe =
          (effectiveDoi
            ? (db.query("SELECT path FROM sources WHERE lower(doi) = lower(?)").get(effectiveDoi) as {
                path: string
              } | null)
            : null) ??
          (db.query("SELECT path FROM sources WHERE path = ?").get(targetRel) as { path: string } | null) ??
          titleDupe()
        if (dupe) {
          return {
            already_in_library: dupe.path,
            note: "this paper is already in the library under that path — read it there; fetching again would only duplicate the file",
          }
        }
        const candidates = await resolvePdfCandidates({ doi: doi ?? null, pdfUrl: pdfUrl ?? null })
        if (candidates.length === 0) {
          return { error: `no open-access PDF found${doi ? ` for ${doi}` : ""}${noShrink}` }
        }
        const isPdf = (b: Buffer) => b.subarray(0, 5).toString("latin1").startsWith("%PDF")
        // one GET with a browser identity; a header-less request gets served an
        // anti-bot/cookie HTML page by many hosts even for open-access PDFs
        const get = async (u: string): Promise<Buffer | { html: string; url: string } | null> => {
          const r = await fetch(u, { redirect: "follow", headers: PDF_FETCH_HEADERS })
          if (!r.ok) return null
          const b = Buffer.from(await r.arrayBuffer())
          if (isPdf(b)) return b
          const ct = r.headers.get("content-type") ?? ""
          const head = b.subarray(0, 512).toString("latin1").toLowerCase()
          if (ct.includes("html") || head.includes("<html") || head.includes("<!doctype"))
            return { html: b.toString("utf8"), url: r.url || u }
          return null // not a PDF, not HTML — unusable
        }
        try {
          let bytes: Buffer | null = null
          let httpFail = false
          for (const cand of candidates) {
            const got = await get(cand)
            if (got === null) {
              httpFail = true
              continue
            }
            if (Buffer.isBuffer(got)) {
              bytes = got
              break
            }
            // landing page → look for the embedded direct PDF link and try it
            const embedded = extractCitationPdfUrl(got.html, got.url)
            if (embedded) {
              const got2 = await get(embedded)
              if (Buffer.isBuffer(got2)) {
                bytes = got2
                break
              }
            }
          }
          if (!bytes) {
            return {
              error:
                (httpFail
                  ? "could not download a PDF from any open-access location (all returned an error or a landing page)"
                  : "the open-access link(s) returned a landing page, not a PDF, with no embedded PDF link") +
                noShrink,
            }
          }
          const name = filename.replace(/[^\w.\- ]/g, "_").replace(/\.pdf$/i, "") + ".pdf"
          mkdirSync(join(workspace.root, "sources"), { recursive: true })
          const rel = join("sources", name)
          writeFileSync(join(workspace.root, rel), bytes)
          const ingested = await ingestWithVisuals(rel, effectiveDoi)
          await embedNew()
          // close the ledger loop: the candidate row (if this paper was
          // surfaced by search/snowball) now points at its library file
          linkCandidateToSource(db, effectiveDoi ?? (ingested as { doi?: string | null }).doi ?? null, rel)
          return ingested
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) }
        }
      },
    }),

    draft_section: tool({
      description:
        "Write a VERIFIED document (or section) grounded in the ingested library. Plans the " +
        "structure, then writes and verifies it section by section (any length — a full " +
        "chapter is fine). Drafts sentences that may only cite retrieved chunk ids, and — " +
        "when the material is genuinely tabular — VERIFIED comparison/listing tables whose " +
        "every data cell is cite-checked exactly like a sentence (ask for a table in the " +
        "instructions, e.g. 'include a table comparing the tools across energy/latency/" +
        "accuracy'). Verifies every claim (entailment + verbatim quote), saves to drafts/, " +
        "returns per-sentence and per-cell verdicts. Use this for ANY writing with factual " +
        "claims from sources — never write such text yourself. The retrieval CANNOT see this " +
        "conversation: chat content that must appear (a review you gave, agreed points, an " +
        "outline) goes in brief, verbatim. TWO MODES — YOUR decision from what the user " +
        "needs: verified:true (default) for any document making claims from sources; " +
        "verified:false for a PLAIN document with no such claims (email, motivation " +
        "letter, outline, statement, summary of the conversation) — no queries needed, " +
        "no citations, no verification, rendered as a clean document.",
      inputSchema: z.object({
        document: z
          .string()
          .min(2)
          .max(60)
          .describe(
            "stable kebab-case name for THIS document, e.g. review-ecoserve or " +
            "lit-review-energy. ONE document = ONE name = ONE file in drafts/, updated in " +
            "place across the whole conversation — never invent a new name for another " +
            "pass over the same document",
          ),
        instructions: z
          .string()
          .describe("what the section should cover, its purpose, tone, target length"),
        queries: z
          .array(z.string())
          .min(1)
          .max(6)
          .optional()
          .describe(
            "search queries to retrieve grounding passages from the library — MAX 6. " +
            "Required for a verified draft; omit when verified:false",
          ),
        verified: z
          .boolean()
          .optional()
          .describe(
            "true (default): grounded document — every claim cited to retrieved passages " +
            "and verified (colors, verdicts, references). false: PLAIN document composed " +
            "from instructions + brief only — no citations, no verification chrome; for " +
            "documents that make NO claims from sources. NEVER false for prose stating " +
            "facts from the literature or from files",
          ),
        brief: z
          .string()
          .optional()
          .describe(
            "verbatim CONVERSATION content the draft must be built on — e.g. the review " +
            "you produced earlier, points the user agreed on, an outline. NEVER for facts " +
            "that live in a workspace FILE: ingest_source the file first so retrieval can " +
            "cite it — a file fact passed via brief ships UNCITED (author-position), which " +
            "defeats the point of grounding. Whatever is not here or in the library cannot " +
            "appear in the draft.",
          ),
        citation_style: z
          .enum(["numeric", "author-year"])
          .optional()
          .describe(
            "in-text citation style: numeric [n] (default, IEEE-like) or author-year " +
            "((Hooker et al., 2020)) — choose per the venue or the user's preference",
          ),
        revise: z
          .string()
          .optional()
          .describe(
            "dataFile of a draft to revise (from a previous draft_section result). " +
            "Usually UNNEEDED: calling again with the same document name automatically " +
            "revises that document. Pass this only to build a document from a DIFFERENT " +
            "existing draft file",
          ),
      }),
      execute: async ({ document, instructions, queries, brief, revise, citation_style, verified }) => {
        const slug = document.toLowerCase().trim().replace(/[\s_]+/g, "-").replace(/[^a-z0-9-]/g, "").slice(0, 60)
        if (slug.length < 2) return { error: `invalid document name: ${document}` }
        // one document = one file: an existing document is ALWAYS revised in
        // place (verdicts of unchanged sentences reused), never duplicated.
        // A full rewrite is just a revision that keeps nothing — no reset
        // switch exists, so version history can never be wiped by accident.
        let reviseOf = revise
        const dataPath = join("drafts", `${slug}.json`)
        if (!reviseOf && existsSync(join(workspace.root, dataPath))) {
          reviseOf = dataPath
        }
        // mode stickiness: a document created PLAIN stays plain across
        // revisions unless the agent explicitly upgrades it to verified:true
        if (verified === undefined && reviseOf) {
          try {
            const prevMode = JSON.parse(readFileSync(join(workspace.root, reviseOf), "utf8")) as {
              verified?: boolean
            }
            if (prevMode.verified === false) verified = false
          } catch {
            /* unreadable — the default (verified) stands */
          }
        }
        if (verified !== false && (!queries || queries.length === 0)) {
          return {
            error:
              "a verified draft needs 1-6 retrieval queries — or, if this document makes " +
              "no claims from sources (email, outline, statement), pass verified:false " +
              "for a plain, citation-free document",
          }
        }
        // gate against the redraft spiral: fresh full drafts burn verification
        // passes — three genuinely new documents per turn stay allowed
        if (!reviseOf && freshDraftsThisTurn.length >= 3) {
          return {
            error:
              `you already created ${freshDraftsThisTurn.length} new documents this turn ` +
              `(latest: ${freshDraftsThisTurn[freshDraftsThisTurn.length - 1]}). To keep improving one, ` +
              "call draft_section again with ITS document name — it revises in place. " +
              "Only the user can ask for more from-scratch documents.",
          }
        }
        // gate against the perfectionism spiral: each SUCCESSFUL pass re-runs
        // the writer AND the verification pool — real money. Initial + 2
        // self-revisions per turn; beyond that, polish is the USER's call.
        // FAILED attempts have their own counter — a schema hiccup must not
        // consume the budget and wall off recovery (observed live: a cornered
        // agent composed the review in chat, bypassing verification).
        const NEVER_CHAT =
          " NEVER compose the document in chat instead — that bypasses verification. Report " +
          "honestly to the user: what failed, what IS verified so far (synthesis, notes), " +
          "and ask how they want to proceed."
        const passes = draftPassesThisTurn.get(slug) ?? 0
        if (passes >= 3) {
          return {
            error:
              `this turn already ran ${passes} successful write+verify passes of "${slug}" — ` +
              "further self-revision is diminishing returns at real cost. Report the current " +
              "state (verification tallies, what remains imperfect) and let the USER decide " +
              "whether another pass is worth it." + NEVER_CHAT,
          }
        }
        const fails = draftPassesThisTurn.get(`${slug}:failed`) ?? 0
        if (fails >= 3) {
          return {
            error:
              `draft_section already failed ${fails} times on "${slug}" this turn — retrying the ` +
              "same way will not help. Simplify the structure (fewer/plainer sections, table as " +
              "prose if needed) ONCE, or stop." + NEVER_CHAT,
          }
        }
        const wSpec = await effectiveRoleSpec("orchestrator")
        const vSpec = await effectiveRoleSpec("verifier")
        if (!wSpec || !vSpec) return { error: "no model configured for writer/verifier roles" }
        // the revision's previous size must be read BEFORE draftSection
        // overwrites the file in place
        let wordsBefore: number | null = null
        if (reviseOf) {
          try {
            const prev = JSON.parse(readFileSync(join(workspace.root, reviseOf), "utf8")) as {
              sentences?: { text: string }[]
            }
            wordsBefore = (prev.sentences ?? []).reduce((n, s) => n + s.text.split(/\s+/).length, 0)
          } catch {
            /* previous unreadable — no size comparison */
          }
        }
        try {
          const r = await draftSection(db, workspace, {
            instructions,
            queries: queries ?? [],
            brief,
            verified,
            document: slug,
            citationStyle: citation_style,
            writer: resolveModel(wSpec),
            verifier: resolveModel(vSpec),
            embedder: await embedderForRole().catch(() => null),
            reviseOf,
          })
          if ("error" in r) {
            draftPassesThisTurn.set(`${slug}:failed`, fails + 1)
            return {
              ...r,
              error:
                r.error +
                " (If this keeps failing: report it honestly and deliver the verified pieces " +
                "you have — never compose the document in chat.)",
            }
          }
          draftPassesThisTurn.set(slug, passes + 1)
          if (!reviseOf) freshDraftsThisTurn.push(r.dataFile)
          // reality signals: the environment states facts, the model decides.
          const enrich: Record<string, unknown> = {}
          // grounding signals apply to VERIFIED documents only — a plain
          // (verified:false) composition has no citation duties to flag
          const grounded = r.verified !== false
          // 1. cited-but-never-opened sources — citing what was never even
          //    screened is invisible otherwise (retrieval works on ingest)
          const citedPaths = [...new Set(r.sources.map((s) => s.path))]
          const neverOpened = citedPaths.filter((p) => {
            const prog = readingProgress(db, p)
            return !(prog && prog.readPages > 0) && !readNote(workspace, p)
          })
          if (grounded && neverOpened.length > 0) {
            enrich["sources_never_read"] = neverOpened
            enrich["reading_warning"] =
              `${neverOpened.length} of ${citedPaths.length} sources cited in this draft were ` +
              "never opened (no pages read, no notes) — a researcher does not cite what they " +
              "have not at least screened. Screen them (read_pages) and revise, or state the " +
              "limitation plainly to the user."
          }
          // 1b. screening is triage, not extraction: a long source that was
          //     only skimmed AND has no reading note behind it has not yielded
          //     its methods/results. A saved note (or a visual read written to
          //     one) is the extraction record, so noted sources never flag —
          //     nor do short sources or scanned PDFs the agent worked via
          //     ask_document/view_page and noted. This is a fact, not a quota.
          const screenedOnly = citedPaths.filter((p) => {
            if (neverOpened.includes(p)) return false
            if (readNote(workspace, p)) return false // extraction landed in a note
            const prog = readingProgress(db, p)
            return prog != null && prog.totalPages >= 8 && prog.readPages <= 2
          })
          if (grounded && screenedOnly.length > 0) {
            enrich["evidence_depth"] =
              `${screenedOnly.length} of ${citedPaths.length} cited sources look only SKIMMED so ` +
              `far — a couple of pages read and no reading note: ${screenedOnly.slice(0, 8).join(", ")}` +
              (screenedOnly.length > 8 ? ", …" : "") +
              ". If a section leans on one of these, its claims are only as deep as that skim; " +
              "reading the pages that hold what it needs and noting them (or noting a view_page " +
              "look) would deepen it. Your call whether each is already deep enough for its role here."
          }
          // 1c. revision that dropped previous sections — intended or an
          //     accident of re-planning; stated so the agent can notice
          if ("droppedSections" in r && r.droppedSections && r.droppedSections.length > 0) {
            enrich["sections_dropped"] =
              `this revision no longer contains previous section(s): ${r.droppedSections.join("; ")}. ` +
              "If that was intended (the instructions asked to cut them), good; if not, the re-plan " +
              "lost them — draft again and keep the full structure."
          }
          // 2. revisions must face their own size change — silent halving of a
          //    document is not a fix
          if (wordsBefore != null) {
            const wordsAfter = r.sentences.reduce((n, s) => n + s.text.split(/\s+/).length, 0)
            enrich["revision_size"] =
              `${wordsBefore} → ${wordsAfter} words` +
              (wordsAfter < wordsBefore * 0.7
                ? " — this revision REMOVED a large share of the content; deleting weak claims is not fixing them unless the user asked for cuts"
                : "")
          }
          // 3. review-shaped documents are expected to carry the shape of
          //    science: comparison tables, breadth of the corpus, synthesis
          //    (not narration). Facts stated; the model decides. (S4/C8b)
          const reviewLike = grounded && /review|survey|state.of.the.art|related.work|literature|sota|comparison/i.test(
            `${slug} ${instructions}`,
          )
          if (reviewLike && r.tables.length === 0 && r.sentences.length > 20) {
            enrich["tables_expected_but_absent"] =
              "a review-scale document with ZERO comparison tables — benchmark, tooling, and " +
              "methods material reads better as a verified table (describe the table in the " +
              "instructions and it is cite-checked cell by cell). If prose is genuinely right " +
              "for this material, proceed — but decide, don't default."
          }
          if (reviewLike) {
            const openedTotal = (
              db.query("SELECT COUNT(DISTINCT source_path) AS n FROM read_log").get() as { n: number }
            ).n
            if (openedTotal >= 4 && citedPaths.length * 2 < openedTotal) {
              enrich["coverage_note"] =
                `this draft cites ${citedPaths.length} of ${openedTotal} opened sources — ` +
                "silently ignoring half the corpus is how reviews go shallow. Either widen the " +
                "retrieval queries so the rest contributes, or name the excluded sources and why " +
                "they fell out of scope."
            }
          }
          // disclosure pressure: a meaningfully-unsupported draft must never be
          // presented as fully verified — the reply states the tallies and
          // offers a revision pass (observed live: '206 verified sentences'
          // spin over 23 unsupported + 77 uncited)
          const totalClaims = r.summary.supported + r.summary.partial + r.summary.unsupported
          if (grounded && r.summary.unsupported > 0 && (r.summary.unsupported >= 5 || r.summary.unsupported * 10 >= totalClaims)) {
            enrich["verdict_note"] =
              `${r.summary.unsupported} claim(s) are UNSUPPORTED (of ${totalClaims} checked). In your ` +
              "reply, state the full verification tallies plainly and offer a revision pass — never " +
              "present this draft as fully verified."
          }
          const narrRuns = narrationLintRuns(r.sentences)
          if (grounded && narrRuns >= 2 && r.sentences.length > 12) {
            enrich["narration_note"] =
              `${narrRuns} stretch(es) walk papers one-by-one ('X et al. propose… Y et al. show…'). ` +
              "Synthesis organizes by IDEAS: open paragraphs with a claim about the literature and " +
              "support it from several sources; use contrast/continuity moves where sources connect."
          }
          if (grounded && r.sources.length === 0 && brief) {
            enrich["brief_only_note"] =
              "ZERO retrieved passages contributed — this document is built entirely from the " +
              "brief: author-position prose, uncited and unverified against any source. Fine for " +
              "an opinion piece or a write-up of the conversation; NOT a literature-grounded draft."
          }
          return { ...r, ...enrich }
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) }
        }
      },
    }),

    synthesize: tool({
      description:
        "Read ACROSS the ingested library to find INSIGHT, not summary: where papers agree, " +
        "where they CONTRADICT each other (each side grounded in a real passage), and what " +
        "the literature leaves OPEN — the gaps where a new contribution could sit. Use this " +
        "for literature reviews, related-work sections, and 'compare these papers' or 'what's " +
        "the state of the art / the open problems' requests, BEFORE writing. It returns a " +
        "grounded analysis; then pass that analysis to draft_section (as its brief) to write " +
        "the verified prose. Needs at least two ingested sources on the topic.",
      inputSchema: z.object({
        topic: z.string().describe("the question/theme to synthesize across sources"),
        queries: z
          .array(z.string())
          .min(1)
          .max(6)
          .describe("search queries to pull the relevant passages from every source"),
      }),
      execute: async ({ topic, queries }) => {
        const spec = await effectiveRoleSpec("orchestrator")
        if (!spec) return { error: "no model configured" }
        try {
          return await synthesizeSources(db, workspace, {
            topic,
            queries,
            model: resolveModel(spec),
            embedder: await embedderForRole().catch(() => null),
          })
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) }
        }
      },
    }),

    map_source: tool({
      description:
        "Read an ingested source into the shared CONCEPT GRAPH: extracts the concepts and " +
        "the relations stated between them (each anchored to the exact passage it came from). " +
        "Do this for papers you read deeply during a multi-paper task (a literature review, " +
        "a survey). Once mapped, you can later use `related` to see how papers connect " +
        "WITHOUT re-reading them. Worth it only for multi-source work — skip for a one-off " +
        "question.",
      inputSchema: z.object({
        path: z.string().describe("workspace-relative path to an ingested source"),
        from_page: z.number().int().min(1).optional(),
        to_page: z.number().int().min(1).optional(),
      }),
      execute: async ({ path, from_page, to_page }) => {
        safePath(workspace, path)
        const spec = (await effectiveRoleSpec("screener")) ?? (await effectiveRoleSpec("orchestrator"))
        if (!spec) return { error: "no model configured" }
        try {
          const r = await extractGraph(db, workspace, {
            sourcePath: path,
            model: resolveModel(spec),
            fromPage: from_page,
            toPage: to_page,
            // graph v2: same-meaning labels merge into one canonical node
            embedder: await embedderForRole().catch(() => null),
          })
          return "error" in r ? r : { ...r, graph: graphSize(db) }
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) }
        }
      },
    }),

    related: tool({
      description:
        "Navigate the concept graph built by map_source — find how the library connects " +
        "WITHOUT re-reading papers. Modes: 'neighbors' (what a concept links to, and where), " +
        "'shared' (concepts multiple papers both touch — the cross-paper links), 'central' " +
        "(the most connected concepts across everything). Every result carries the source and " +
        "chunk id, so open ONLY the passages you need to cite. The graph guides you to " +
        "evidence — it is never itself evidence; still verify claims via draft_section.",
      inputSchema: z.object({
        mode: z.enum(["neighbors", "shared", "central"]),
        concept: z.string().optional().describe("required for mode=neighbors: the concept to explore"),
      }),
      execute: async ({ mode, concept }) => {
        const size = graphSize(db)
        if (size.edges === 0) {
          return { hint: "the concept graph is empty — map_source the papers you've read first", graph: size }
        }
        if (mode === "neighbors") {
          if (!concept) return { error: "mode=neighbors needs a concept" }
          const hits = neighbors(db, concept)
          return hits.length
            ? { concept, connections: hits }
            : { concept, connections: [], hint: "not in the graph — try mode=central to see what is, or map more sources" }
        }
        if (mode === "shared") return { shared: sharedConcepts(db), graph: size }
        return { central: centralConcepts(db), graph: size }
      },
    }),

    edit_source: tool({
      description:
        "Edit a text file (md/txt/tex) in the workspace IN PLACE by exact search-and-" +
        "replace — THE way to apply fixes to the user's own manuscript when they want " +
        "changes in their file (not a new draft, not copy-paste instructions). old_text " +
        "must match exactly once; include enough surrounding context to make it unique. " +
        "The file is re-indexed if it was ingested. Cannot edit PDFs, .bib files " +
        "(bibliographies come only from export_draft's registry rendering), or anything " +
        "under drafts/ (those are verified artifacts — use draft_section revise=). New " +
        "factual prose about the literature must come from a verified draft_section first " +
        "— then inserting those verified sentences here is expected and allowed.",
      inputSchema: z.object({
        path: z.string().describe("workspace-relative path to the file"),
        old_text: z.string().min(1).describe("exact existing text to replace (must occur exactly once)"),
        new_text: z.string().describe("replacement text (may be empty to delete)"),
      }),
      execute: async ({ path, old_text, new_text }) => {
        const full = safePath(workspace, path)
        const rel = relative(workspace.root, full) // normalized form for DB lookups
        const ext = extname(full).toLowerCase()
        if (![".md", ".markdown", ".txt", ".tex"].includes(ext)) {
          return {
            error:
              ext === ".bib"
                ? "refused: .bib files are rendered only from registry metadata by export_draft — never edited by hand"
                : `edit_source only edits text files (md/txt/tex), got ${ext || "no extension"}`,
          }
        }
        if (rel.startsWith("drafts/") || rel.startsWith(".openpaper")) {
          return {
            error:
              "refused: files under drafts/ are verified artifacts — iterate with " +
              "draft_section revise= instead of editing the output in place",
          }
        }
        let text: string
        try {
          text = readFileSync(full, "utf8")
        } catch {
          return { error: `file not found: ${path}` }
        }
        const count = text.split(old_text).length - 1
        if (count === 0) {
          return { error: "old_text not found in the file — copy it exactly (whitespace matters), e.g. from read_source" }
        }
        if (count > 1) {
          return { error: `old_text occurs ${count} times — include more surrounding context so it matches exactly once` }
        }
        // split/join, NOT String.replace: replace() interprets $-patterns in the
        // replacement ($$, $&, $', $`) and silently corrupts math/LaTeX content
        writeFileSync(full, text.split(old_text).join(new_text))
        // re-index: content hash changed, so drop the stale rows and ingest fresh
        let reindexed = false
        const stale = db
          .query("SELECT id FROM sources WHERE path = ?")
          .all(rel) as { id: string }[]
        if (stale.length > 0) {
          for (const s of stale) {
            const chunkIds = (
              db.query("SELECT id FROM chunks WHERE source_id = ?").all(s.id) as { id: string }[]
            ).map((c) => c.id)
            for (const cid of chunkIds) {
              db.query("DELETE FROM verdicts WHERE chunk_id = ?").run(cid)
              db.query("DELETE FROM chunk_vecs WHERE chunk_id = ?").run(cid)
            }
            db.query("DELETE FROM sources WHERE id = ?").run(s.id)
          }
          try {
            await ingestFile(db, workspace, rel)
            await embedNew()
            reindexed = true
          } catch (err) {
            return {
              path: rel, edited: true, reindexed: false,
              warning: `file edited but re-indexing failed: ${err instanceof Error ? err.message : String(err)}`,
            }
          }
        }
        const preview = (s: string) => (s.length > 300 ? s.slice(0, 300) + "…" : s)
        return {
          path: rel,
          edited: true,
          reindexed,
          ...(reindexed
            ? {
                note: "the file was re-indexed: passage ids changed, so drafts citing the old text should be re-drafted or re-verified before export",
              }
            : {}),
          change: { removed: preview(old_text), added: preview(new_text) },
        }
      },
    }),

    update_plan: tool({
      description:
        "Maintain your working plan for MULTI-STEP tasks — a literature review across " +
        "several papers, drafting a full article, a review-and-fix cycle, anything that " +
        "fragments into 3+ distinct steps. Send the COMPLETE list every time (it replaces " +
        "the previous one): create it when you commit to a multi-step task, mark items " +
        "done the moment you finish them, add newly discovered work, keep exactly ONE " +
        "item in_progress, and send an empty list when the task is fully complete. " +
        "DEPENDENCIES: when a step genuinely requires another to finish first — drafting " +
        "requires the reading it cites, verifying requires the draft — declare it with " +
        "blocked_by (task ids t1, t2, … by position). A blocked task is flagged in your " +
        "plan at every step, so declare real dependencies and respect them. The current " +
        "plan is always shown to you in your instructions. Simple questions and one-step " +
        "tasks get NO plan — zero ceremony.",
      inputSchema: z.object({
        todos: z
          .array(
            z.object({
              content: z.string().min(3).max(200).describe("one concrete step, user-readable"),
              status: z.enum(["pending", "in_progress", "done"]),
              kind: z
                .enum(["search", "screen", "read", "synthesize", "draft", "verify", "review", "respond", "other"])
                .optional()
                .describe("what KIND of work this step is — lets the plan state reading-before-writing structurally"),
              blocked_by: z
                .array(z.string())
                .max(10)
                .optional()
                .describe('ids of steps that must be done first (e.g. ["t2","t3"]); ids are t1, t2, … by list position'),
            }),
          )
          .max(20)
          .describe("the FULL plan (replaces the previous list); [] clears it when the task is complete"),
      }),
      execute: async ({ todos }) => {
        if (!currentSession) return { error: "no session — plans are per-conversation" }
        const previous = getPlan(db, currentSession)
        setPlan(db, currentSession, todos as Todo[])
        const done = todos.filter((t) => t.status === "done").length
        // skills echo — a reality signal, not an order: surface the expertise
        // files matching this plan; whether one fits is the agent's judgment
        const loaded = skillsLoadedBefore()
        const matches =
          todos.length === 0
            ? []
            : matchSkills(
                todos.map((t) => t.content).join(" "),
                listSkills().filter((s) => s.status === "active"),
              ).filter((m) => !loaded.has(m.name))
        // echo the FULL normalized list (not just counters): the mid-turn
        // slimmer digests old tool results, and counters alone let the model
        // lose sight of which specific tasks remain and what blocks them
        const saved = getPlan(db, currentSession)
        const blocked = blockedTasks(saved)
        const startable = startableTasks(saved)
        const dropped = droppedTasks(previous, saved)
        return {
          saved: true,
          items: todos.length,
          done,
          note:
            todos.length === 0
              ? previous.length > 0
                ? "plan cleared — task complete"
                : "no plan"
              : `plan updated: ${done}/${todos.length} done`,
          ...(saved.length > 0 ? { plan: renderPlanLines(saved) } : {}),
          ...(dropped.length > 0
            ? {
                tasks_dropped:
                  `this update REMOVED ${dropped.length} unfinished task(s): ` +
                  dropped.map((t) => `"${t.content}"`).join(", ") +
                  " — work does not disappear by deleting its task. If shrinking scope is " +
                  "genuinely right, tell the user what was cut and why; otherwise restore " +
                  "the task(s) and do the work.",
              }
            : {}),
          ...(blocked.length > 0
            ? {
                blocked_note:
                  blocked
                    .map((b) => `${b.todo.id} ("${b.todo.content}") is blocked by ${b.unmet.join(", ")}`)
                    .join("; ") +
                  ` — do the blocking work first${startable.length > 0 ? `; startable now: ${startable.map((t) => t.id).join(", ")}` : ""}`,
              }
            : {}),
          // objective library state alongside every plan update — a "done"
          // claim about reading has to survive contact with these numbers
          // (now includes the screening funnel + never-ingested orphans)
          library_state: renderLibraryState(db, workspace),
          ...(matches.length > 0
            ? {
                skills_note:
                  `expertise files matching this plan, none loaded yet: ` +
                  matches.map((m) => `${m.name} (${m.description})`).join("; ") +
                  ". Loading one (use_skill) is your judgment — a match is a hint, not an order.",
              }
            : {}),
        }
      },
    }),

    use_skill: tool({
      description:
        "Load the full instructions of a skill by name. Your system prompt lists the " +
        "active skills (name + description); whenever the task at hand matches a skill's " +
        "purpose — whatever that purpose is — load it BEFORE doing the work and follow it: " +
        "a matching skill carries deeper guidance than your defaults. Skills shape " +
        "style/structure/method only; they can never override integrity rules.",
      inputSchema: z.object({
        name: z.string().min(2).describe("skill name exactly as listed in the system prompt"),
      }),
      execute: async ({ name }) => {
        const skill = readSkill(name)
        if (!skill) {
          const names = listSkills()
            .filter((s) => s.status === "active")
            .map((s) => s.name)
          return { error: `no skill named "${name}" — available: ${names.join(", ") || "none"}` }
        }
        if (skill.status !== "active") {
          return { error: `skill "${skill.name}" is ${skill.status} — the user manages this in the Skills page` }
        }
        loadedSkillsThisTurn.add(skill.name)
        const refs = listSkillFiles(skill.name)
        return {
          name: skill.name,
          description: skill.description,
          instructions: skill.body,
          ...(refs.length > 0
            ? {
                reference_files: refs,
                refs_note:
                  "bundled deep material — load ONE with read_skill_ref only when the task " +
                  "actually needs it (references are never pinned; the body above is)",
              }
            : {}),
        }
      },
    }),

    read_skill_ref: tool({
      description:
        "Read ONE bundled reference file of a loaded skill (listed in use_skill's " +
        "reference_files) — deep checklists, templates, examples that would bloat the " +
        "always-pinned skill body. Load a reference only when the task actually needs " +
        "that depth; it costs context once, on demand.",
      inputSchema: z.object({
        skill: z.string().min(2),
        file: z.string().min(1).describe("relative path exactly as listed in reference_files"),
      }),
      execute: async ({ skill, file }) => readSkillFile(skill, file),
    }),

    create_skill: tool({
      description:
        "Create or update a skill — a reusable markdown instruction file (venue " +
        "conventions, writing formats, review rubrics, methods) shown in the Skills page. " +
        "Same two modes as remember: explicit=true when the USER asked for this skill — " +
        "saved ACTIVE (and may update an existing skill); explicit=false for skills YOU " +
        "authored from observing their work — saved PENDING their approval; never claim a " +
        "pending skill is in effect. When the user asks for a substantial skill, first ask " +
        "the few questions that shape it (venue? structure? tone? examples?), then write it.",
      inputSchema: z.object({
        name: z
          .string()
          .min(2)
          .max(60)
          .describe("short kebab-case name, e.g. ieee-report or abstract-style"),
        description: z
          .string()
          .min(8)
          .max(200)
          .describe("one line: when this skill applies — it is how you will find it later"),
        instructions: z.string().min(20).describe("the skill body: concise markdown instructions"),
        explicit: z
          .boolean()
          .describe("true ONLY when the user directly asked for this skill; false when inferred"),
      }),
      execute: async ({ name, description, instructions, explicit }) => {
        let clean: string
        try {
          clean = sanitizeSkillName(name)
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) }
        }
        const existing = readSkill(clean)
        if (existing && !explicit) {
          return {
            error: `skill "${clean}" already exists — updating it requires the user's explicit request`,
          }
        }
        const saved = saveSkill({
          name: clean,
          description,
          body: instructions,
          status: explicit ? "active" : "pending",
        })
        return {
          name: saved.name,
          status: explicit
            ? existing
              ? "updated and active"
              : "saved and active"
            : "pending user approval in the Skills page",
        }
      },
    }),

    search_sessions: tool({
      description:
        "Search the user's OTHER conversations in this workspace for what was said or " +
        "decided there. Use when the user refers to a previous/another conversation. " +
        "Two steps: search broadly first (short snippets locate the right conversation), " +
        "then pass that session id to get the FULL text of its matching messages — do NOT " +
        "fire many snippet searches to reconstruct long content. Work that produced files " +
        "(drafts, notes) is often better found via search_library or list_sources.",
      inputSchema: z.object({
        query: z.string().min(2),
        k: z.number().int().min(1).max(10).default(5),
        session: z
          .string()
          .optional()
          .describe("a session id from a previous result: returns the full text of that conversation's matching messages"),
      }),
      execute: async ({ query, k, session }) => {
        const terms = [...new Set(query.split(/\s+/).filter((t) => t.length > 2))].slice(0, 8)
        if (terms.length === 0) return { hits: [], note: "query too short" }
        // FTS5 bm25 ranking; terms OR-ed and quoted (user text, not fts syntax)
        const match = terms.map((t) => `"${t.replaceAll('"', "")}"`).join(" OR ")
        let rows: {
          session_id: string; message_id: string; role: string; content: string
          snip: string; title: string | null; created_at: number
        }[]
        try {
          rows = db
            .query(
              // s.created_at (session start): message timestamps are rewritten
              // on every snapshot persist, so they don't say when things were said
              `SELECT f.session_id, f.message_id, f.role, f.content,
                      snippet(messages_fts, 3, '', '', '…', 40) AS snip,
                      s.title, s.created_at
               FROM messages_fts f JOIN sessions s ON s.id = f.session_id
               WHERE messages_fts MATCH ? AND f.session_id != ?
                 ${session ? "AND f.session_id = ?" : ""}
               ORDER BY bm25(messages_fts) LIMIT 60`,
            )
            .all(...(session ? [match, currentSession ?? "", session] : [match, currentSession ?? ""])) as typeof rows
        } catch {
          return { hits: [], note: "search failed — try simpler terms" }
        }
        const perSession = new Map<string, number>()
        const hits: { session: string; title: string | null; when: string; role: string; snippet: string }[] = []
        for (const r of rows) {
          if (!session && (perSession.get(r.session_id) ?? 0) >= 2) continue
          perSession.set(r.session_id, (perSession.get(r.session_id) ?? 0) + 1)
          hits.push({
            session: r.session_id,
            title: r.title,
            when: new Date(r.created_at).toISOString().slice(0, 16).replace("T", " "),
            role: r.role,
            // drill-down mode returns full text so long content survives one call
            snippet: session
              ? r.content.length > 6000
                ? r.content.slice(0, 6000) + "…"
                : r.content
              : r.snip,
          })
          if (hits.length >= k) break
        }
        return hits.length
          ? { hits }
          : { hits: [], note: "nothing in other conversations — the work may live in files: try search_library or list_sources" }
      },
    }),

    check_references: tool({
      description:
        "Deterministic reference-integrity scan of a manuscript: every DOI found in the " +
        "text is live-checked for resolution and retraction. Run it as part of reviewing " +
        "the user's manuscript. PDFs must be ingested first (the scan reads extracted text).",
      inputSchema: z.object({
        path: z.string().describe("workspace-relative path to the manuscript"),
      }),
      execute: async ({ path }) => {
        safePath(workspace, path)
        const ext = extname(path).toLowerCase()
        let text = ""
        if ([".md", ".markdown", ".txt", ".tex", ".bib"].includes(ext)) {
          text = readFileSync(join(workspace.root, path), "utf8")
        } else if (ext === ".pdf") {
          const rows = db
            .query(
              `SELECT c.text FROM chunks c JOIN sources s ON s.id = c.source_id
               WHERE s.path = ? ORDER BY c.page, c.char_start`,
            )
            .all(path) as { text: string }[]
          if (rows.length === 0) {
            return { error: "PDF not ingested — ingest_source it first so its text can be scanned" }
          }
          text = rows.map((r) => r.text).join("\n\n")
        } else {
          return { error: `unsupported file type: ${ext}` }
        }
        const dois = scanDois(text).slice(0, 40)
        const results: Record<string, { resolves: boolean; retracted: boolean }> = {}
        for (const d of dois) results[d] = await checkDoi(fetch, d)
        const problems = Object.entries(results)
          .filter(([, v]) => !v.resolves || v.retracted)
          .map(([d, v]) => `${d}${v.retracted ? " (RETRACTED)" : " (does not resolve)"}`)
        return {
          checked: dois.length,
          problems,
          note:
            dois.length === 0
              ? "no DOIs found in the text"
              : problems.length === 0
                ? "all references resolve; none retracted"
                : `${problems.length} reference problem(s) found`,
        }
      },
    }),

    export_draft: tool({
      description:
        "Export a verified draft: numbered citations, a bibliography rendered ONLY from " +
        "registry metadata, a .bib file, and the claim→passage audit JSON. Re-checks every " +
        "DOI (resolution + retraction) at export time. Refuses if unsupported sentences " +
        "remain, unless acknowledge is true.",
      inputSchema: z.object({
        dataFile: z.string().describe("the draft's dataFile path returned by draft_section"),
        acknowledge: z
          .boolean()
          .default(false)
          .describe("set true only if the user explicitly accepts exporting unsupported sentences"),
      }),
      execute: async ({ dataFile, acknowledge }) => {
        safePath(workspace, dataFile)
        try {
          return await exportDraft(db, workspace, dataFile, { acknowledge })
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) }
        }
      },
    }),

    search_library: tool({
      description:
        "Full-text search over all ingested sources. Returns passages with source path, " +
        "page number, and chunk id. ALWAYS cite answers using (path, p.N) from these hits — " +
        "never from memory.",
      inputSchema: z.object({
        query: z.string(),
        k: z.number().int().min(1).max(20).default(6),
      }),
      execute: async ({ query, k }) => {
        await embedNew() // one-time backfill for libraries ingested before embeddings
        const embed = await embedderForRole().catch(() => null)
        const hits = await hybridSearch(db, query, k, embed)
        return hits.length ? { hits } : { hits: [], note: "no matches — is the file ingested?" }
      },
    }),

    list_sources: tool({
      description:
        "List candidate source files in the workspace (pdf, md, txt, tex, bib). " +
        "Returns workspace-relative paths and sizes.",
      inputSchema: z.object({}),
      execute: async () => {
        const files = listSourceFiles(workspace)
        return { count: files.length, truncated: files.length >= MAX_FILES, files }
      },
    }),

    read_source: tool({
      description:
        "Read a text-based file (md, txt, tex, bib) from the workspace by relative path. " +
        "For PDFs use ingest_source + read_pages instead.",
      inputSchema: z.object({
        path: z.string().describe("workspace-relative path, as returned by list_sources"),
      }),
      execute: async ({ path }) => {
        const full = safePath(workspace, path)
        const ext = extname(full).toLowerCase()
        if (ext === ".pdf") {
          return {
            error: "read_source is for text files — for a PDF, ingest_source it then read_pages.",
          }
        }
        if (!SOURCE_EXTS.has(ext)) return { error: `unsupported file type: ${ext}` }
        const text = readFileSync(full, "utf8")
        logRead(db, path, 1, 1) // reading a text source OPENS it (citable)
        return {
          path,
          truncated: text.length > MAX_READ_CHARS,
          content: text.slice(0, MAX_READ_CHARS),
        }
      },
    }),
  }
  if (planDisabled) delete (tools as Partial<typeof tools>).update_plan
  return tools
}

import { Hono } from "hono"
import { serveStatic } from "hono/bun"
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  NoSuchToolError,
  stepCountIs,
  streamText,
  type LanguageModel,
  type ModelMessage,
  type UIMessage,
} from "ai"
import {
  addNote, deleteNote, listNotes, loadConfig, openDb, openWorkspace,
  recallForPrompt, saveConfig, setApproved,
  type MemoryKind, type Workspace,
} from "@abstract/core"
import {
  CALLBACK_PATH,
  chatgptSignOut,
  chatgptStatus,
  completeChatGPTLogin,
  effectiveRoleSpec,
  listProvidersLive,
  markChatGPTWelcomed,
  resolveModel,
  startChatGPTLogin,
  type Role,
} from "@abstract/providers"
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { ingestFile } from "@abstract/ingest"
import { exportDraft } from "./agent/export.ts"
export { exportDraft } from "./agent/export.ts"
import {
  ANTHROPIC_EPHEMERAL_CACHE, compactAccumulated, compactContext, markStableCachePoint,
  MIDTURN_COMPACT_CHARS, MIDTURN_COMPACT_TOKENS, slimModelMessages, summarizeCallFor,
} from "./agent/compact.ts"
import { funnel } from "./agent/ledger.ts"
import { evaluateRules, loadRules } from "./agent/rules.ts"
import { getPlan, planPrompt } from "./agent/plan.ts"
import {
  deleteSkill, listSkills, migrateWorkspaceSkills, pinActiveSkills, readSkill, saveSkill,
  seedDefaultSkills, setSkillStatus, skillsPrompt, type SkillStatus,
} from "./agent/skills.ts"
import {
  adjudicateStop, artifactMismatchNudge, claimsAbsentTable, classifyFailure, computeBackoffMs,
  continuationNudge, errorMessageOf, friendlyProviderError, gaveUpNotice, immediateTurnParts,
  interleaveInterjections, isContextLengthError, isTransientStreamError, lastAssistantText,
  mergeClientHistory, planReminder, promiseNudge, repairToolInput, repairToolName, retryDelayHintMs, sanitizeToolParts,
  shouldRemindPlan, summarizeToolOnlyTurn, systemReminder,
} from "./agent/turn.ts"
import { systemPrompt } from "./agent/system.ts"
import { attachViewedVisuals } from "./agent/view.ts"
import { listSourceFiles, makeTools } from "./agent/tools.ts"
import { subagentTools } from "./agent/subagent.ts"
import { buildTree, deletePath, makeFolder, moveFile } from "./tree.ts"

export interface ServerOptions {
  dir: string
  /** absolute path to the built web UI (apps/web/dist); optional in dev */
  staticDir?: string
}

/** reported to the UI: the chat model (used for every task) and the automatic embeddings model */
const ROLES: Role[] = ["orchestrator", "embeddings"]

function rememberWorkspace(root: string): void {
  const config = loadConfig()
  config.recentWorkspaces = [root, ...config.recentWorkspaces.filter((r) => r !== root)].slice(0, 8)
  saveConfig(config)
}

/* ------------------------------------------------------------------ *
 * crash-journal shutdown plumbing (module-level: signal handlers are
 * installed once even if createApp runs multiple times, e.g. in tests)
 * ------------------------------------------------------------------ */
const JOURNAL_FLUSHERS = new Set<() => void>()
let signalsInstalled = false
function registerJournalFlusher(flush: () => void): void {
  JOURNAL_FLUSHERS.add(flush)
  if (signalsInstalled) return
  signalsInstalled = true
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      for (const f of JOURNAL_FLUSHERS) {
        try {
          f()
        } catch {
          /* a failed flush must not block shutdown */
        }
      }
      process.exit(0)
    })
  }
}

/** stable key tying a journal row to the exact user request it belongs to */
export function journalUserKey(messages: UIMessage[]): string {
  const lastUser = [...messages].reverse().find((m) => m.role === "user")
  const text = JSON.stringify(lastUser?.parts ?? [])
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

export function createApp(options: ServerOptions) {
  let workspace: Workspace = openWorkspace(options.dir)
  let db = openDb(workspace.dbPath)
  rememberWorkspace(workspace.root)
  seedDefaultSkills() // default venue-review skills; never overwrites user edits
  migrateWorkspaceSkills(workspace) // adopt skills created when they were per-workspace
  /** in-flight chat runs, per session — stop + mid-run steering + reattach */
  const activeRuns = new Map<
    string,
    {
      ac: AbortController
      stopped: boolean
      /** interjections waiting for the next step boundary */
      pending: string[]
      /** interjections already shown to the model, with their delivery point */
      delivered: { text: string; afterToolCallId: string }[]
      /** crash journal: force-persist this run's completed steps NOW (sync) */
      flushJournal?: () => void
      /** every UI chunk emitted so far — replayed to a reattaching client */
      buffer: unknown[]
      /** live reattach subscribers (C7): buffered replay, then the live tail */
      listeners: Set<{ enqueue: (chunk: unknown) => void; close: () => void }>
      ended: boolean
      /** the turn's last draft artifact — the reply-vs-artifact honesty input */
      lastDraft: { file: string; tables: number } | null
    }
  >()
  /** reattach replay bound — beyond this a very late reattach loses the
   *  earliest chunks (the persisted turn still lands complete at the end) */
  const LIVE_BUFFER_MAX = 200_000
  // graceful shutdown: flush every in-flight run's journal before dying, so a
  // Ctrl-C or SIGTERM mid-run costs nothing — the next request resumes from
  // the journal instead of redoing hours of work
  registerJournalFlusher(() => {
    for (const r of activeRuns.values()) r.flushJournal?.()
  })
  const app = new Hono()

  // localhost-only hardening: reject cross-origin browser requests
  app.use("/api/*", async (c, next) => {
    const origin = c.req.header("origin")
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      return c.text("forbidden", 403)
    }
    await next()
  })

  app.get("/api/health", (c) =>
    c.json({ ok: true, name: "abstract", version: process.env["ABSTRACT_VERSION"] ?? "dev" }),
  )

  app.get("/api/workspace", (c) =>
    c.json({ name: workspace.name, root: workspace.root }),
  )

  app.get("/api/workspaces", (c) => {
    const config = loadConfig()
    return c.json({
      current: { name: workspace.name, root: workspace.root },
      recent: config.recentWorkspaces
        .filter((r) => existsSync(r))
        .map((r) => ({ root: r, name: r.split("/").pop() ?? r })),
    })
  })

  app.post("/api/workspaces/create", async (c) => {
    const body = (await c.req.json()) as { name?: string }
    const name = body.name?.trim().replace(/[^\w.\- ]/g, "")
    if (!name) return c.json({ error: "name required" }, 400)
    const path = join(homedir(), "Abstract", name)
    if (existsSync(path)) return c.json({ error: `already exists: ${path}` }, 400)
    mkdirSync(path, { recursive: true })
    const next = openWorkspace(path)
    const nextDb = openDb(next.dbPath)
    db.close()
    workspace = next
    db = nextDb
    rememberWorkspace(workspace.root)
    return c.json({ name: workspace.name, root: workspace.root })
  })

  app.post("/api/workspaces/open", async (c) => {
    const body = (await c.req.json()) as { path?: string }
    const path = body.path?.replace(/^~(?=\/|$)/, homedir())
    if (!path) return c.json({ error: "path required" }, 400)
    if (!existsSync(path) || !statSync(path).isDirectory()) {
      return c.json({ error: `not a directory: ${path}` }, 400)
    }
    const next = openWorkspace(path)
    const nextDb = openDb(next.dbPath)
    db.close()
    workspace = next
    db = nextDb
    rememberWorkspace(workspace.root)
    return c.json({ name: workspace.name, root: workspace.root })
  })

  app.post("/api/workspaces/delete", async (c) => {
    const body = (await c.req.json()) as { path?: string }
    const path = body.path?.replace(/^~(?=\/|$)/, homedir())
    if (!path) return c.json({ error: "path required" }, 400)
    const norm = path.replace(/\/+$/, "")
    if (!norm || norm === "/" || norm === homedir()) {
      return c.json({ error: "refusing to delete that directory" }, 400)
    }
    if (norm === workspace.root) {
      return c.json({ error: "this workspace is open — switch to another one first, then delete it" }, 400)
    }
    if (!existsSync(norm) || !statSync(norm).isDirectory()) {
      return c.json({ error: `not a directory: ${norm}` }, 400)
    }
    // only ever delete real Abstract workspaces — the marker is the guard
    if (!existsSync(join(norm, ".openpaper"))) {
      return c.json({ error: "not an Abstract workspace (no .openpaper inside) — refusing to delete" }, 400)
    }
    rmSync(norm, { recursive: true, force: true })
    const config = loadConfig()
    config.recentWorkspaces = config.recentWorkspaces.filter((r) => r !== norm)
    saveConfig(config)
    return c.json({ ok: true })
  })

  app.put("/api/providers", async (c) => {
    const body = (await c.req.json()) as { id?: string; apiKey?: string; baseURL?: string }
    if (!body.id) return c.json({ error: "id required" }, 400)
    const config = loadConfig()
    config.providers[body.id] = {
      ...config.providers[body.id],
      ...(body.apiKey !== undefined ? { apiKey: body.apiKey || undefined } : {}),
      ...(body.baseURL !== undefined ? { baseURL: body.baseURL || undefined } : {}),
    }
    saveConfig(config)
    return c.json({ ok: true })
  })

  app.get("/api/sources", (c) => {
    const byPath = new Map(
      (
        db.query("SELECT path, status, grade, title, doi FROM sources").all() as {
          path: string; status: string; grade: string; title: string | null; doi: string | null
        }[]
      ).map((r) => [r.path, r]),
    )
    const files = listSourceFiles(workspace).map((f) => {
      const s = byPath.get(f.path)
      return {
        ...f,
        status: s?.status ?? "not_ingested",
        grade: s?.grade ?? null,
        title: s?.title ?? null,
        doi: s?.doi ?? null,
      }
    })
    return c.json({ files })
  })

  app.post("/api/sources/upload", async (c) => {
    const body = await c.req.parseBody({ all: true })
    const raw = body["files"]
    const files = (Array.isArray(raw) ? raw : [raw]).filter((f): f is File => f instanceof File)
    if (files.length === 0) return c.json({ error: "no files" }, 400)
    mkdirSync(join(workspace.root, "sources"), { recursive: true })
    const results = []
    for (const f of files) {
      const name = f.name.replace(/[^\w.\- ()]/g, "_")
      const rel = join("sources", name)
      writeFileSync(join(workspace.root, rel), Buffer.from(await f.arrayBuffer()))
      // no auto-ingestion: files are read/indexed when the user asks or the agent decides
      results.push({ path: rel, saved: true })
    }
    return c.json({ results })
  })

  app.get("/api/tree", (c) => c.json({ tree: buildTree(workspace, db) }))

  /** screening-ledger funnel for the files panel (empty when no candidates) */
  app.get("/api/ledger", (c) => {
    try {
      return c.json({ funnel: funnel(db) })
    } catch {
      return c.json({ funnel: null })
    }
  })

  app.post("/api/files/mkdir", async (c) => {
    const { path } = (await c.req.json()) as { path?: string }
    if (!path?.trim()) return c.json({ error: "path required" }, 400)
    try {
      return c.json(makeFolder(workspace, path.trim()))
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
    }
  })

  app.post("/api/files/move", async (c) => {
    const { from, to } = (await c.req.json()) as { from?: string; to?: string }
    if (!from || !to) return c.json({ error: "from and to required" }, 400)
    try {
      return c.json(moveFile(workspace, db, from, to))
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
    }
  })

  app.post("/api/files/delete", async (c) => {
    const { path } = (await c.req.json()) as { path?: string }
    if (!path?.trim()) return c.json({ error: "path required" }, 400)
    try {
      return c.json(deletePath(workspace, db, path.trim()))
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
    }
  })

  app.get("/api/sessions", (c) => {
    const rows = db
      .query(
        `SELECT s.id, s.title, s.created_at, COUNT(m.id) AS messages, MAX(m.created_at) AS last
         FROM sessions s LEFT JOIN messages m ON m.session_id = s.id
         GROUP BY s.id HAVING messages > 0 ORDER BY last DESC LIMIT 50`,
      )
      .all()
    return c.json({ sessions: rows })
  })

  app.get("/api/sessions/:id/messages", (c) => {
    const rows = db
      .query("SELECT id, role, parts FROM messages WHERE session_id = ? ORDER BY created_at")
      .all(c.req.param("id")) as { id: string; role: string; parts: string }[]
    return c.json({
      messages: rows.map((r) => ({ id: r.id, role: r.role, parts: JSON.parse(r.parts) })),
    })
  })

  app.delete("/api/sessions/:id", (c) => {
    const id = c.req.param("id")
    const tx = db.transaction(() => {
      db.query("DELETE FROM compactions WHERE session_id = ?").run(id)
      db.query("DELETE FROM messages WHERE session_id = ?").run(id)
      db.query("DELETE FROM sessions WHERE id = ?").run(id)
    })
    tx()
    return c.json({ ok: true })
  })

  /** deterministic export of a SPECIFIC draft (button on its preview) — no agent involved */
  app.post("/api/export", async (c) => {
    const { dataFile } = (await c.req.json()) as { dataFile?: string }
    if (!dataFile?.trim()) return c.json({ error: "dataFile required" }, 400)
    const abs = join(workspace.root, dataFile)
    if (abs !== workspace.root && !abs.startsWith(workspace.root + "/")) {
      return c.json({ error: "path escapes workspace" }, 403)
    }
    if (!existsSync(abs)) return c.json({ error: `draft not found: ${dataFile}` }, 404)
    return c.json(await exportDraft(db, workspace, dataFile, {}))
  })

  /** deterministic export of the most recently touched draft — no agent involved */
  app.post("/api/export/latest", async (c) => {
    const dir = join(workspace.root, "drafts")
    const drafts = existsSync(dir)
      ? readdirSync(dir)
          .filter((f) => f.endsWith(".json") && !f.endsWith(".audit.json"))
          .map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs }))
          .sort((a, b) => a.m - b.m)
      : []
    const latest = drafts[drafts.length - 1]?.f
    if (!latest) return c.json({ error: "no drafts to export yet — ask for a verified draft first" }, 404)
    const r = await exportDraft(db, workspace, join("drafts", latest), {})
    return c.json(r)
  })


  app.get("/api/skills", (c) =>
    c.json({ skills: listSkills().map(({ body, ...meta }) => ({ ...meta, size: body.length })) }),
  )

  app.get("/api/skills/:name", (c) => {
    const skill = readSkill(c.req.param("name"))
    return skill ? c.json(skill) : c.json({ error: "skill not found" }, 404)
  })

  app.post("/api/skills", async (c) => {
    const body = (await c.req.json()) as { name?: string; description?: string; instructions?: string }
    if (!body.name?.trim() || !body.description?.trim() || !body.instructions?.trim()) {
      return c.json({ error: "expected { name, description, instructions }" }, 400)
    }
    try {
      // user-created skills are active immediately (explicit by definition)
      return c.json(saveSkill({
        name: body.name, description: body.description, body: body.instructions, status: "active",
      }))
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
    }
  })

  app.put("/api/skills/:name", async (c) => {
    const name = c.req.param("name")
    const body = (await c.req.json()) as {
      description?: string; instructions?: string; status?: SkillStatus
    }
    const existing = readSkill(name)
    if (!existing) return c.json({ error: "skill not found" }, 404)
    try {
      if (body.description !== undefined || body.instructions !== undefined) {
        return c.json(saveSkill({
          ...existing,
          description: body.description ?? existing.description,
          body: body.instructions ?? existing.body,
          status: body.status ?? existing.status,
        }))
      }
      if (body.status) return c.json(setSkillStatus(name, body.status))
      return c.json({ error: "nothing to update" }, 400)
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
    }
  })

  app.delete("/api/skills/:name", (c) => {
    deleteSkill(c.req.param("name"))
    return c.json({ ok: true })
  })

  app.get("/api/memory", (c) => c.json({ notes: listNotes(db) }))

  app.post("/api/memory", async (c) => {
    const body = (await c.req.json()) as { kind?: MemoryKind; content?: string }
    if (!body.kind || !body.content) return c.json({ error: "expected { kind, content }" }, 400)
    return c.json(addNote(db, body.kind, body.content, true))
  })

  app.put("/api/memory/:id", async (c) => {
    const body = (await c.req.json()) as { approved?: boolean }
    setApproved(db, c.req.param("id"), body.approved ?? false)
    return c.json({ ok: true })
  })

  app.delete("/api/memory/:id", (c) => {
    deleteNote(db, c.req.param("id"))
    return c.json({ ok: true })
  })

  app.get("/api/chunks/:id", (c) => {
    const row = db
      .query(
        `SELECT c.id, c.text, c.page, c.line_start, c.line_end, s.path, s.title, s.grade, s.kind
         FROM chunks c JOIN sources s ON s.id = c.source_id WHERE c.id = ?`,
      )
      .get(c.req.param("id")) as Record<string, unknown> | null
    if (!row) return c.json({ error: "chunk not found" }, 404)
    return c.json(row)
  })

  app.get("/api/file", (c) => {
    const rel = c.req.query("path")
    if (!rel) return c.json({ error: "path required" }, 400)
    const abs = join(workspace.root, rel)
    if (abs !== workspace.root && !abs.startsWith(workspace.root + "/")) {
      return c.json({ error: "path escapes workspace" }, 403)
    }
    const file = Bun.file(abs)
    const download = c.req.query("download") === "1"
    const name = rel.split("/").pop() ?? "file"
    const lower = rel.toLowerCase()
    const type =
      lower.endsWith(".pdf") ? "application/pdf"
      : lower.endsWith(".png") ? "image/png"
      : lower.endsWith(".jpg") || lower.endsWith(".jpeg") ? "image/jpeg"
      : lower.endsWith(".html") || lower.endsWith(".htm") ? "text/html; charset=utf-8"
      : "text/plain; charset=utf-8"
    return new Response(file, {
      headers: {
        "content-type": type,
        "content-disposition": download ? `attachment; filename="${name}"` : "inline",
      },
    })
  })

  // ---- "Continue with ChatGPT" (OpenAI Sign in with ChatGPT, plan usage) ----
  app.get("/api/chatgpt", (c) => c.json(chatgptStatus()))

  app.post("/api/chatgpt/login", async (c) => {
    const { newAccount } = (await c.req.json().catch(() => ({}))) as { newAccount?: boolean }
    // OpenAI requires a 127.0.0.1 loopback redirect with a fixed path; only the
    // port may vary. Use the port this server LISTENS on (Bun passes the server
    // as env) — the request's own port is Vite's under `bun run dev:web`
    const port = (c.env as { port?: number } | undefined)?.port ?? (new URL(c.req.url).port || "80")
    const url = await startChatGPTLogin({ redirectUri: `http://127.0.0.1:${port}${CALLBACK_PATH}`, newAccount })
    return c.json({ url })
  })

  app.get(CALLBACK_PATH, async (c) => {
    const page = (title: string, body: string, script = "") =>
      c.html(
        `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
          `<body style="font-family:system-ui,sans-serif;background:#f4f3f0;color:#222;text-align:center;margin-top:22vh">` +
          `<h2 style="font-weight:600">${title}</h2><p id="m" style="color:#666">${body}</p>${script}</body>`,
      )
    // the Settings page opened this tab with window.open, so it may close itself;
    // the app's tab picks the sign-in up by polling. Errors stay open to be read.
    const closeSelf =
      `<script>setTimeout(function(){window.close();setTimeout(function(){` +
      `document.getElementById("m").textContent="You can close this tab and return to abstract."},300)},600)</script>`
    try {
      const status = await completeChatGPTLogin(new URL(c.req.url).searchParams)
      return status.planUsage
        ? page("Signed in with ChatGPT", "Returning you to abstract…", closeSelf)
        : page(
            "Signed in — plan usage not enabled",
            "abstract can't run models on your ChatGPT plan without that permission. Return to abstract and choose Continue with ChatGPT again to allow it.",
          )
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err)).replace(/[<>&]/g, "")
      return page("Sign-in didn't complete", `${msg} Return to abstract and try again.`)
    }
  })

  app.post("/api/chatgpt/logout", async (c) => c.json(await chatgptSignOut()))

  app.post("/api/chatgpt/welcomed", (c) => {
    markChatGPTWelcomed()
    return c.json({ ok: true })
  })

  app.get("/api/models", async (c) => {
    const config = loadConfig()
    const providers = await listProvidersLive(config)
    const roles = Object.fromEntries(
      await Promise.all(
        ROLES.map(async (r) => [r, (await effectiveRoleSpec(r, config)) ?? null]),
      ),
    )
    return c.json({ providers: providers.map(({ envKey, ...p }) => p), roles })
  })

  /** the chat box's model picker — one model runs every task */
  app.put("/api/models", async (c) => {
    const body = (await c.req.json()) as { role?: string; spec?: string }
    if (body.role !== "orchestrator" || !body.spec?.includes("/")) {
      return c.json({ error: 'expected { role: "orchestrator", spec: "provider/model" }' }, 400)
    }
    const config = loadConfig()
    config.roles["orchestrator"] = body.spec
    // per-role picks from older versions are ignored now — drop them
    for (const r of ["verifier", "screener", "distiller"]) delete config.roles[r]
    saveConfig(config)
    return c.json({ ok: true })
  })

  /** speak to the agent WHILE it works — delivered at the next step boundary */
  app.post("/api/chat/interject", async (c) => {
    const { sessionId, text } = (await c.req.json()) as { sessionId?: string; text?: string }
    if (!sessionId || !text?.trim()) return c.json({ error: "sessionId and text required" }, 400)
    const run = activeRuns.get(sessionId)
    if (!run || run.stopped) {
      return c.json({ error: "no run in flight — send it as a normal message" }, 409)
    }
    run.pending.push(text.trim())
    return c.json({ ok: true, note: "will be read at the agent's next step" })
  })

  /**
   * Reattach to an IN-FLIGHT run (C7): a refreshed browser used to see
   * nothing until the whole multi-hour turn ended — users read that as a
   * hang, resent, and the resend killed the live run. This replays every
   * chunk so far, then pipes the live tail.
   */
  app.get("/api/chat/:sessionId/live", (c) => {
    const session = c.req.param("sessionId")
    const run = activeRuns.get(session)
    if (!run || run.ended) {
      // 204 is the AI SDK's reconnect contract for "no active stream" — the
      // client falls back to the persisted messages without an error
      return c.body(null, 204)
    }
    let listener: { enqueue: (chunk: unknown) => void; close: () => void } | null = null
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of run.buffer) controller.enqueue(chunk)
        listener = {
          enqueue: (chunk) => controller.enqueue(chunk),
          close: () => {
            try {
              controller.close()
            } catch {
              /* already closed */
            }
          },
        }
        run.listeners.add(listener)
      },
      cancel() {
        if (listener) run.listeners.delete(listener)
      },
    })
    return createUIMessageStreamResponse({
      stream: stream as Parameters<typeof createUIMessageStreamResponse>[0]["stream"],
      headers: { "x-abstract-session": session, "x-abstract-live": "reattached" },
    })
  })

  /** stop the in-flight run for a session — generation halts at the current step */
  app.post("/api/chat/stop", async (c) => {
    const { sessionId } = (await c.req.json()) as { sessionId?: string }
    if (!sessionId) return c.json({ error: "sessionId required" }, 400)
    const run = activeRuns.get(sessionId)
    if (!run) return c.json({ ok: true, note: "no run in flight" })
    run.stopped = true
    run.ac.abort()
    return c.json({ ok: true })
  })

  app.post("/api/chat", async (c) => {
    // snapshot: a workspace switch mid-run must not affect this run
    const ws = workspace
    const wdb = db
    const { messages, sessionId } = (await c.req.json()) as {
      messages: UIMessage[]
      sessionId?: string
    }
    const session = sessionId ?? crypto.randomUUID()
    wdb.query(
      "INSERT OR IGNORE INTO sessions (id, created_at) VALUES (?, ?)",
    ).run(session, Date.now())
    const lastUser = [...messages].reverse().find((m) => m.role === "user")
    const firstText = lastUser?.parts.find((p) => p.type === "text") as { text?: string } | undefined
    if (firstText?.text) {
      wdb.query("UPDATE sessions SET title = COALESCE(title, ?) WHERE id = ?").run(
        firstText.text.slice(0, 80),
        session,
      )
    }

    // The client's posted history can be stale — the DB snapshot wins for the
    // shared prefix; only genuinely NEW trailing user messages are appended
    const dbRows = wdb
      .query("SELECT role, parts FROM messages WHERE session_id = ? ORDER BY created_at")
      .all(session) as { role: string; parts: string }[]
    const history = mergeClientHistory(
      dbRows.map((r, i) => ({ id: `${session}:${i}`, role: r.role, parts: JSON.parse(r.parts) }) as UIMessage),
      messages,
    )

    const spec = await effectiveRoleSpec("orchestrator")
    if (!spec) {
      return c.text(
        'no model available for role "orchestrator" — open Settings and Continue with ChatGPT, ' +
          "or add an API key (e.g. ANTHROPIC_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY)",
        503,
      )
    }
    let model
    try {
      model = resolveModel(spec)
    } catch (err) {
      return c.text(err instanceof Error ? err.message : String(err), 503)
    }

    // context management: slim old tool outputs, and past a size threshold
    // summarize earlier turns (cached per session). The DB keeps everything;
    // only what goes to the provider is compacted.
    let context = {
      messages: history,
      systemSuffix: "",
      contextChars: JSON.stringify(history).length,
    }
    let summarizer: LanguageModel | null = null
    try {
      const sumSpec = (await effectiveRoleSpec("screener")) ?? spec
      summarizer = resolveModel(sumSpec)
      context = await compactContext(wdb, session, history, summarizer)
    } catch {
      // compaction is an enhancement — fall back to the full history
    }

    // a LIVE run is never silently killed by a duplicate send (C7): the
    // refresh-then-resend reflex used to abort overnight runs. Steering goes
    // through /api/chat/interject, watching through /api/chat/:id/live,
    // stopping through /api/chat/stop. Stopped/aborted leftovers are superseded.
    const existing = activeRuns.get(session)
    if (existing && !existing.ended && !existing.stopped && !existing.ac.signal.aborted) {
      return c.json(
        {
          error:
            "a run is already in flight for this session — reattach via GET /api/chat/" +
            session +
            "/live, steer it via /api/chat/interject, or stop it via /api/chat/stop first",
        },
        409,
      )
    }
    existing?.ac.abort()
    const run = {
      ac: new AbortController(),
      stopped: false,
      pending: [] as string[],
      delivered: [] as { text: string; afterToolCallId: string }[],
      flushJournal: undefined as (() => void) | undefined,
      buffer: [] as unknown[],
      listeners: new Set<{ enqueue: (chunk: unknown) => void; close: () => void }>(),
      ended: false,
      /** the turn's last draft artifact — the reply-vs-artifact honesty input */
      lastDraft: null as { file: string; tables: number } | null,
    }
    activeRuns.set(session, run)

    // steering delivery: every tool result is a step boundary — if the user
    // spoke while the tool ran, ride their words back in with the result.
    // The LEAD agent also gets `delegate`; sub-agents (inside subagentTools)
    // get only makeTools — so they can never recursively delegate.
    const baseTools = { ...makeTools(ws, wdb, session), ...subagentTools(ws, wdb, run.ac.signal) }
    // C9 per-tool timeout: one hung fetch/parse must never wedge an overnight
    // run — SessionToolRunner-style budget around EVERY execution. On expiry
    // the model gets a structured error result and the loop keeps going (the
    // underlying promise is left to settle; tools honor the run's abort signal
    // for genuine cancellation).
    const TOOL_TIMEOUT_MS: Record<string, number> = {
      fetch_paper: 180_000, // network + landing-page PDF chases
      ingest_source: 300_000, // large-PDF parse + embedding
      ask_document: 240_000, // whole-document transcription passes
      draft_section: 1_800_000, // plan + per-section writes + verification pool
      synthesize: 600_000,
      delegate: 3_600_000, // parallel sub-agent waves run long by design
      export_draft: 300_000, // live DOI/retraction checks
    }
    const DEFAULT_TOOL_TIMEOUT_MS = 120_000
    // hooks v1 (C10): user-authored PreToolUse block rules, loaded once per
    // turn; a block's message returns AS the tool result so the model routes
    // around it. Rules only narrow — code gates stay authoritative.
    const toolRules = loadRules()
    const tools = Object.fromEntries(
      Object.entries(baseTools).map(([name, t]) => [
        name,
        {
          ...t,
          execute: async (input: never, opts: { toolCallId: string }) => {
            const blocked = evaluateRules(toolRules, name, input)
            if (blocked) {
              return {
                error: `blocked by your rule "${blocked.rule}": ${blocked.message}`,
                note: "this is a standing rule the user configured (~/.abstract/rules) — respect it and take a different route; do not retry the same call",
              }
            }
            const ms = TOOL_TIMEOUT_MS[name] ?? DEFAULT_TOOL_TIMEOUT_MS
            let timer: ReturnType<typeof setTimeout> | undefined
            let out: unknown
            try {
              out = await Promise.race([
                (t as unknown as { execute: (i: never, o: unknown) => Promise<unknown> }).execute(input, opts),
                new Promise((_, reject) => {
                  timer = setTimeout(() => reject(new Error(`TOOL_TIMEOUT:${name}`)), ms)
                }),
              ])
            } catch (err) {
              if (err instanceof Error && err.message.startsWith("TOOL_TIMEOUT:")) {
                console.error(`[chat] tool ${name} timed out after ${ms / 1000}s — run continues`)
                out = {
                  error: `${name} timed out after ${Math.round(ms / 1000)}s — the run continues. ` +
                    "Try a different approach (another source, a narrower request), or retry once; " +
                    "do not repeat the identical call expecting a different result.",
                  timeout: true,
                }
              } else {
                throw err
              }
            } finally {
              clearTimeout(timer)
            }
            if (name === "draft_section" && out && typeof out === "object" && !("error" in out)) {
              const o = out as { file?: string; tables?: unknown[] }
              if (o.file) run.lastDraft = { file: o.file, tables: o.tables?.length ?? 0 }
            }
            const notes = run.pending.splice(0)
            if (notes.length === 0) return out
            run.delivered.push(...notes.map((text) => ({ text, afterToolCallId: opts.toolCallId })))
            const base = typeof out === "object" && out !== null ? out : { result: out }
            return {
              ...base,
              USER_MESSAGE_WHILE_YOU_WORK: notes,
              steering_note:
                "the user sent this while you were working — address it NOW: answer briefly " +
                "if it is a question, adjust your plan and direction if it is an instruction, " +
                "then continue the task accordingly",
            }
          },
        },
      ]),
    ) as unknown as ReturnType<typeof makeTools>

    let streamError: string | null = null
    // maps any failure to user-facing text (and remembers it for persistence);
    // the SDK re-invokes onError with our OWN error-chunk text, so this must
    // be idempotent — never re-wrap text it already produced
    const mapError = (err: unknown) => {
      const raw = errorMessageOf(err)
      if (streamError && raw === streamError) return streamError
      streamError = run.stopped
        ? "stopped at your request — everything up to here is saved; send a message to continue"
        : raw.startsWith("provider ") ||
            raw.startsWith("the provider ") ||
            raw.startsWith("the connection ") ||
            raw.startsWith("stopped ") ||
            raw.startsWith("Usage limit reached") ||
            raw.startsWith("This ChatGPT account") ||
            raw.startsWith("Your ChatGPT sign-in")
          ? raw
          : friendlyProviderError(raw)
      return streamError
    }

    const system =
      systemPrompt(ws) +
      skillsPrompt() +
      recallForPrompt(wdb) +
      (process.env["ABSTRACT_NO_PLAN"] ? "" : planPrompt(wdb, session)) +
      context.systemSuffix

    // Build the UI stream ourselves and tee it: one branch to the client,
    // one drained server-side — so the run completes and the FULL turn
    // (including every text part) persists even if the browser refreshes
    // or disconnects mid-run. Generation runs inside `execute` as a RESUME
    // LOOP: every model step is an independent provider request, so when one
    // step's stream dies from a transient network failure we restart from the
    // completed steps instead of killing a long research turn.
    const uiStream = createUIMessageStream({
      onError: mapError,
      onFinish: async ({ responseMessage }) => {
        // retire the run FIRST: from here on interject must 409 (the client
        // falls back to a normal message). Otherwise a steer landing during
        // finalization is pushed onto run.pending AFTER the splice below and
        // is neither delivered nor persisted — silently lost.
        if (activeRuns.get(session) === run) activeRuns.delete(session)
        // the turn ended and is being persisted — its crash journal is spent.
        // (A crash never reaches this line, which is exactly why the journal
        // survives crashes and only crashes.)
        try {
          wdb.query("DELETE FROM turn_journal WHERE session_id = ?").run(session)
        } catch {
          /* stale journal is reconciled by the user_key check on next turn */
        }
        // snapshot the WHOLE conversation with position-based ids —
        // client message ids collide across turns and were overwriting
        // earlier assistant replies (verified in production data)
        const persist = (replyMessages: { role: string; parts: UIMessage["parts"] }[]) => {
          const all = [
            ...history,
            ...replyMessages.map((m, i) => ({ ...responseMessage, ...m, id: `${session}:r${i}` })),
          ].filter((m) => m?.role && m.parts.length > 0)
          const now = Date.now()
          const tx = wdb.transaction(() => {
            wdb.query("DELETE FROM messages WHERE session_id = ?").run(session)
            wdb.query("DELETE FROM messages_fts WHERE session_id = ?").run(session)
            all.forEach((m, i) => {
              const id = `${session}:${i}`
              wdb
                .query(
                  "INSERT INTO messages (id, session_id, role, parts, created_at) VALUES (?, ?, ?, ?, ?)",
                )
                .run(id, session, m.role, JSON.stringify(m.parts), now + i)
              const text = m.parts
                .filter((p) => p.type === "text")
                .map((p) => (p as { text?: string }).text ?? "")
                .join(" ")
                .trim()
              if (text) {
                wdb
                  .query(
                    "INSERT INTO messages_fts (session_id, message_id, role, content) VALUES (?, ?, ?, ?)",
                  )
                  .run(session, id, m.role, text)
              }
            })
          })
          tx()
        }
        // BULLETPROOF: no matter what the finalization logic below does, a
        // completed run must NEVER persist as nothing. If anything throws, fall
        // back to persisting the raw turn so real work can never silently vanish.
        try {
          // the reply may really have been an interleaved exchange: assistant
          // work → user interjection → continuation. Split it into its true
          // sequence; only the FINAL assistant segment gets the silence guards
          const { segments } = interleaveInterjections(responseMessage?.parts ?? [], run.delivered)
          const lastIdx = segments.map((s) => s.role).lastIndexOf("assistant")
          const finalError =
            run.stopped && !streamError
              ? "stopped at your request — everything up to here is saved; send a message to continue"
              : streamError
          let needsSummary = false
          let replyMessages = segments.map((s, i) => {
            if (s.role !== "assistant") return s
            if (i === lastIdx) {
              const r = immediateTurnParts(s.parts, finalError)
              needsSummary = r.needsSummary
              return { ...s, parts: r.parts }
            }
            return { ...s, parts: sanitizeToolParts(s.parts) }
          })
          if (segments.length === 0 && finalError) {
            replyMessages = [
              { role: "assistant", parts: [{ type: "text", text: `⚠ ${finalError}` }] },
            ]
          }
          // interjections that arrived too late for delivery become normal
          // trailing user messages — visible, persisted, answered next turn
          for (const text of run.pending.splice(0)) {
            replyMessages.push({ role: "user", parts: [{ type: "text", text }] })
          }
          // persist IMMEDIATELY, then upgrade with a summary if due
          persist(replyMessages)
          if (needsSummary && !run.stopped && lastIdx >= 0) {
            const text = await summarizeToolOnlyTurn(
              replyMessages[lastIdx]!.parts,
              model,
              firstText?.text ?? "",
            )
            if (text) {
              const upgraded = replyMessages.map((m, i) =>
                i === lastIdx ? { ...m, parts: [...m.parts, { type: "text" as const, text }] } : m,
              )
              persist(upgraded)
            }
          }
        } catch (err) {
          console.error("[chat] finalization failed — persisting raw turn:", err)
          try {
            persist([{ role: "assistant", parts: responseMessage?.parts ?? [] }])
          } catch (err2) {
            console.error("[chat] raw fallback persist ALSO failed:", err2)
          }
        }
      },
      execute: async ({ writer }) => {
        // model messages of COMPLETED steps, folded across resume attempts
        const accumulated: ModelMessage[] = []

        // ---- crash-journal: recover, then keep persisting as we work ----
        const userKey = journalUserKey(context.messages)
        try {
          const row = wdb
            .query("SELECT user_key, accumulated FROM turn_journal WHERE session_id = ?")
            .get(session) as { user_key: string; accumulated: string } | null
          if (row && row.user_key === userKey) {
            const restored = JSON.parse(row.accumulated) as ModelMessage[]
            if (restored.length > 0) {
              accumulated.push(...restored)
              accumulated.push({
                role: "user",
                content: systemReminder(
                  "The previous run of this exact request was interrupted (crash or restart). " +
                    "Everything above this note is the restored work it completed — its tool " +
                    "calls really ran and their results are real. Do NOT redo that work; " +
                    "continue from where it stopped.",
                ),
              })
              console.error(`[chat] recovered ${restored.length} journaled step message(s) for session ${session}`)
            }
          } else if (row) {
            // journal from a DIFFERENT request (user changed course) — drop it
            wdb.query("DELETE FROM turn_journal WHERE session_id = ?").run(session)
          }
        } catch (err) {
          console.error("[chat] journal recovery failed:", err)
        }
        /** latest in-flight step snapshot (per attempt) — journaled with accumulated */
        let latestSteps: ModelMessage[] = []
        let stepsSinceJournal = 0
        const writeJournal = () => {
          try {
            wdb
              .query(
                "INSERT OR REPLACE INTO turn_journal (session_id, user_key, accumulated, updated_at) VALUES (?, ?, ?, ?)",
              )
              // JSON round-trip also strips undefined fields, which would fail
              // schema validation when the journal is replayed as messages
              .run(session, userKey, JSON.stringify([...accumulated, ...latestSteps]), Date.now())
          } catch {
            /* journaling must never break the run */
          }
        }
        run.flushJournal = writeJournal

        // consecutive-failure budget: progress (any completed step) resets it,
        // so a long run survives MANY transient walls — it only dies when the
        // SAME step fails repeatedly with zero progress between failures
        const MAX_RESUMES = 3
        let resumes = 0
        // the stop-gate: a turn that stopped at a milestone with its own plan
        // still open is continued in place (bounded as a loop guard only)
        const MAX_NUDGES = 4
        let nudges = 0
        // in-turn task reinforcement counters (persist across resume attempts):
        // re-attach the live plan mid-turn so a long run holds its goal
        let stepsSincePlanTouch = 0
        let stepsSinceReminder = 0
        // Anthropic prompt caching: the system message carries a fixed cache
        // breakpoint (caches tools + system for every step after the first);
        // prepareStep adds a moving breakpoint on the last STABLE message.
        // Other providers ignore the anthropic namespace entirely.
        const systemMessage: ModelMessage = {
          role: "system",
          content: system,
          providerOptions: ANTHROPIC_EPHEMERAL_CACHE,
        }
        // token accounting: what this turn actually cost, and how much of it
        // the provider served from cache (the observability EN5 asserts on)
        const usage = { input: 0, cachedInput: 0, output: 0, steps: 0 }
        // mid-turn compaction state: the REAL prompt size of the latest step
        // (usage-reported), a thrash guard, and an overflow-recovery budget
        let lastPromptTokens = 0
        let midturnThrash = 0
        let overflowRecoveries = 0
        // terminal-reason record (P1.3): WHY each turn ended, queryable later
        const recordTerminal = (reason: string) => {
          try {
            wdb
              .query("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)")
              .run(`turn_reason:${session}`, JSON.stringify({ reason, at: Date.now(), steps: usage.steps }))
          } catch {
            /* recording must never break the run */
          }
        }
        // wall-clock ceiling (C4 backstop): a turn must never run unbounded —
        // generous enough for overnight research, hard enough to stop zombies
        const MAX_TURN_MS = 3 * 3_600_000
        const turnStartedAt = Date.now()
        // SPEND budget (C4, hardened after a live turn burned ~$15) — the
        // task-budget pattern: the model is made budget-aware so
        // it paces (one wrap-up steer at the soft line), with a visible hard
        // stop. The numbers are USER SETTINGS (config.budgets), never
        // hardcoded here; 0 disables a line. On Anthropic routes the native
        // output_config.task_budget API is the planned upgrade path.
        const budgets = loadConfig().budgets
        const SOFT_INPUT_TOKENS = budgets.turnSoftInputTokens
        const HARD_INPUT_TOKENS = budgets.turnHardInputTokens
        let spendSteerSent = false
        // long-task continuation state: budget lines apply PER SEGMENT; a
        // segment rollover compacts this turn's steps and keeps going
        let segmentInputStart = 0
        let autoContinues = 0
        const foldAccumulated = async (keepTail?: number): Promise<boolean> => {
          if (!summarizer) return false
          const before = JSON.stringify(accumulated).length
          const folded = await compactAccumulated(accumulated, summarizeCallFor(summarizer), { keepTail })
          const after = JSON.stringify(folded).length
          if (folded === accumulated || after >= before * 0.8) return false
          accumulated.length = 0
          accumulated.push(...folded)
          lastPromptTokens = 0
          writeJournal()
          console.error(`[chat] mid-turn compaction: ${before} → ${after} chars of step history`)
          return true
        }
        for (let attempt = 0; ; attempt++) {
          if (Date.now() - turnStartedAt > MAX_TURN_MS) {
            recordTerminal("wallclock_ceiling")
            writer.write({
              type: "error",
              errorText:
                `this turn hit the ${MAX_TURN_MS / 3_600_000}-hour ceiling — everything so far ` +
                "is saved; send a message to continue the remaining work in a fresh turn",
            })
            return
          }
          const segmentInput = usage.input - segmentInputStart
          if (HARD_INPUT_TOKENS > 0 && segmentInput > HARD_INPUT_TOKENS) {
            // LONG-TASK path: with the plan still open and continuation budget
            // left, roll into a fresh compacted segment instead of stalling a
            // genuine research run half-done (bounded ralph-loop; completion
            // condition = empty plan)
            const openNow = getPlan(wdb, session).filter((t) => t.status !== "done")
            if (
              openNow.length > 0 &&
              autoContinues < budgets.maxAutoContinues &&
              !run.stopped &&
              !run.ac.signal.aborted &&
              (await foldAccumulated(6).catch(() => false))
            ) {
              autoContinues++
              segmentInputStart = usage.input
              spendSteerSent = false
              accumulated.push({
                role: "user",
                content: systemReminder(
                  `Budget segment ${autoContinues + 1}/${budgets.maxAutoContinues + 1}: the previous ` +
                    "segment hit its spend line and your earlier steps were compacted into the summary " +
                    "above. The plan's open items remain YOURS to finish — continue with the core work " +
                    "(reading included sources, promised deliverables) first, land each item and mark " +
                    "it done; skip only optional polish.",
                ),
              })
              console.error(
                `[chat] budget segment rollover ${autoContinues}/${budgets.maxAutoContinues} at ${usage.input} total input tokens`,
              )
              continue
            }
            recordTerminal("token_ceiling")
            writer.write({
              type: "error",
              errorText:
                `this turn consumed ~${Math.round(usage.input / 1_000_000)}M input tokens across ` +
                `${autoContinues + 1} budget segment(s) — the spend ceiling. Everything so far is ` +
                "saved (library, notes, ledger, drafts, plan); send a message to continue.",
            })
            return
          }
          if (SOFT_INPUT_TOKENS > 0 && segmentInput > SOFT_INPUT_TOKENS && !spendSteerSent) {
            spendSteerSent = true
            // PHASE-AWARE by design (observed live: the old wording "no
            // optional extra reading" amputated a review's core reading phase
            // and the agent silently dropped its deep-read task). Core work is
            // protected; the budget rolls into a fresh segment for it.
            accumulated.push({
              role: "user",
              content: systemReminder(
                `This budget segment has consumed ~${Math.round(segmentInput / 100_000) / 10}M input tokens. ` +
                  "Pace yourself — but NEVER cut core work: sources you included but have not read, " +
                  "promised deliverables, and open plan tasks are core, and the budget automatically " +
                  "rolls into a fresh segment when they need it. What to cut instead: optional polish, " +
                  "extra self-revision passes, speculative additional searching beyond your plan. " +
                  "Never silently drop a plan task to save budget — if you genuinely believe scope " +
                  "should shrink, say so to the user with the reason.",
              ),
            })
            console.error(`[chat] spend steer injected at ${segmentInput} segment input tokens`)
          }
          // mid-turn compaction check — BEFORE each provider call, so it also
          // covers a journal-restored oversized run on its first attempt. A
          // fold that stops reducing trips the thrash guard instead of looping.
          if (
            lastPromptTokens > (budgets.compactAtInputTokens || MIDTURN_COMPACT_TOKENS) ||
            JSON.stringify(accumulated).length > MIDTURN_COMPACT_CHARS
          ) {
            try {
              if (await foldAccumulated()) midturnThrash = 0
              else if (++midturnThrash >= 3) {
                recordTerminal("context_thrash")
                writer.write({
                  type: "error",
                  errorText:
                    "this turn's context could not be compacted any further after 3 attempts — " +
                    "everything so far is saved; start a follow-up message to continue the work",
                })
                return
              }
            } catch (err) {
              console.error("[chat] mid-turn compaction failed (continuing uncompacted):", errorMessageOf(err).slice(0, 200))
            }
          }
          // onStepFinish's response.messages is cumulative WITHIN one call —
          // keep the latest snapshot, fold it in when the attempt ends
          let completedSteps: ModelMessage[] = []
          let failure: unknown
          let lastFinish: string | undefined
          let ranRealTools = false // update_plan alone is talking, not working
          const result = streamText({
            model,
            messages: [systemMessage, ...convertToModelMessages(context.messages), ...accumulated],
            // the system prompt rides messages[0] deliberately (it carries the
            // Anthropic cache_control breakpoint); our own system text is not
            // an injection vector — suppress the SDK's per-step warning
            allowSystemInMessages: true,
            tools,
            // per-step context management, model-side only (the UI and DB keep
            // everything): old tool outputs of THIS turn become digests so an
            // hour-long run stops re-sending every page it ever read, then
            // view_page results get their pixels re-attached, and loaded skills
            // are re-pinned so a long run never forgets the guidance it loaded.
            prepareStep: ({ messages }) => {
              // ORDER MATTERS for the cache: slim (quantized boundary) →
              // attach visuals (deterministic positions) → mark the moving
              // cache breakpoint on the last STABLE message → only then append
              // the per-step ephemeral tail (pinned skills, plan reminder),
              // which is regenerated every step and must never carry the mark.
              const base = pinActiveSkills(
                markStableCachePoint(attachViewedVisuals(slimModelMessages(messages), ws)),
              )
              // in-turn task reinforcement:
              // after enough steps with no plan update, re-attach the live plan
              // so the model does not drift off a long-horizon goal mid-turn.
              stepsSincePlanTouch++
              stepsSinceReminder++
              const open = getPlan(wdb, session).filter((t) => t.status !== "done")
              if (
                !run.stopped &&
                shouldRemindPlan({ openItems: open.length, stepsSincePlanTouch, stepsSinceReminder })
              ) {
                stepsSinceReminder = 0
                // C4 budget awareness: real usage numbers ride the reminder so
                // the model paces its remaining work instead of running blind
                const budgetNote =
                  lastPromptTokens > 0
                    ? `context: ~${Math.round(lastPromptTokens / 1000)}K tokens in use this turn; ` +
                      `automatic compaction near ${Math.round(MIDTURN_COMPACT_TOKENS / 1000)}K — ` +
                      "pace the remaining work and finish cleanly rather than sprawling"
                    : undefined
                return { messages: [...base, { role: "user" as const, content: planReminder(open, budgetNote) }] }
              }
              return { messages: base }
            },
            abortSignal: run.ac.signal,
            // absorb mechanical model slips (case-drifted tool names, leaked
            // <parameter> scaffolding, string-instead-of-array) instead of
            // spending a round-trip on each — form repairs only, never content
            experimental_repairToolCall: async ({ toolCall, tools: reg, inputSchema, error }) => {
              try {
                if (NoSuchToolError.isInstance(error)) {
                  const fixed = repairToolName(toolCall.toolName, Object.keys(reg))
                  if (fixed) {
                    console.error(`[chat] repaired tool name: ${toolCall.toolName} → ${fixed}`)
                    return { ...toolCall, toolName: fixed }
                  }
                  return null
                }
                const schema = inputSchema({ toolName: toolCall.toolName }) as {
                  properties?: Record<string, { type?: string }>
                }
                const arrayFields = new Set(
                  Object.entries(schema.properties ?? {})
                    .filter(([, v]) => v.type === "array")
                    .map(([k]) => k),
                )
                const repaired = repairToolInput(toolCall.input, arrayFields)
                if (repaired) {
                  console.error(`[chat] repaired tool input for ${toolCall.toolName}`)
                  return { ...toolCall, input: repaired }
                }
              } catch {
                /* repair must never crash the loop — fall through to the error */
              }
              return null
            },
            // transient request failures (rate limits, 5xx) retry with backoff
            maxRetries: 5,
            // no work cap: the agent stops when it has its answer. The number
            // below is only an infinite-loop backstop, never a task limit.
            stopWhen: stepCountIs(1000),
            // capture snapshots only while the attempt is healthy: an in-band
            // error still flushes the dying step, and folding its PARTIAL
            // message would resume the model mid-sentence
            onStepFinish: (step) => {
              if (!failure) {
                completedSteps = step.response.messages
                // journal as we go (every few steps): a crash 50 steps into a
                // two-hour run must cost minutes, not the whole turn
                latestSteps = completedSteps
                if (++stepsSinceJournal >= 3) {
                  stepsSinceJournal = 0
                  writeJournal()
                }
              }
              // token accounting: without it, rate-limit exhaustion is
              // invisible until the provider refuses. cachedInputTokens > 0
              // proves the cache breakpoints are actually landing (test EN5).
              usage.steps++
              usage.input += step.usage?.inputTokens ?? 0
              usage.cachedInput += step.usage?.cachedInputTokens ?? 0
              usage.output += step.usage?.outputTokens ?? 0
              // the latest step's REAL prompt size drives mid-turn compaction
              lastPromptTokens = step.usage?.inputTokens ?? lastPromptTokens
              if (usage.steps % 5 === 0) {
                // cache ratio over TOTAL prompt tokens: Anthropic reports
                // cached reads separately from (non-cached) input
                const total = usage.input + usage.cachedInput
                console.error(
                  `[usage] ${usage.steps} steps: in=${usage.input} (cached=${usage.cachedInput}, ` +
                    `${total > 0 ? Math.round((100 * usage.cachedInput) / total) : 0}% cache-read) out=${usage.output}`,
                )
              }
              lastFinish = step.finishReason
              if (step.toolCalls?.some((t) => t.toolName !== "update_plan")) ranRealTools = true
              // touching the plan resets the in-turn reminder clock
              if (step.toolCalls?.some((t) => t.toolName === "update_plan")) stepsSincePlanTouch = 0
            },
            onError: ({ error }) => {
              failure = failure ?? error
              // in-band errors are suppressed from the client stream — never
              // let them vanish from the server's record too
              console.error("[chat] provider in-band error:", errorMessageOf(error).slice(0, 300))
            },
          })
          // pump manually — merge() converts failures into error chunks the
          // loop could never observe. A hard stream break rejects the read;
          // in-band provider error parts are flagged via onError above.
          // side-effect-free onError: its chunks are suppressed by the pump, and
          // it must NOT set streamError — a resumed attempt is not a failure
          const reader = result
            .toUIMessageStream({
              sendStart: attempt === 0,
              onError: errorMessageOf,
            })
            .getReader()
          // parts still open if the stream hard-breaks — they must be closed
          // with synthetic end chunks or they persist in state "streaming".
          // The `finish` chunk is held back until we KNOW the turn is over:
          // a stop-gate continuation must never emit content after `finish`.
          const openParts = new Map<string, "text" | "reasoning">()
          let heldFinish: unknown
          try {
            for (;;) {
              const { done, value } = await reader.read()
              if (done) break
              if (value.type === "error") continue // the loop decides what is fatal
              if (failure && (value.type === "finish" || value.type === "finish-step")) {
                // an in-band error still flushes finish chunks — suppress them
                // so a resumed turn never emits content after `finish`. Only a
                // REAL terminal reason means the call recovered: "error" and
                // "unknown" are both failure signatures (unknown = the error
                // arrived after completed steps), and treating them as
                // recovery would clear the failure and end the turn silently.
                if (value.type === "finish") {
                  const fr = (value as { finishReason?: string }).finishReason
                  if (fr !== "error" && fr !== "unknown") {
                    failure = undefined
                    heldFinish = value
                  }
                }
                continue
              }
              if (value.type === "finish") {
                heldFinish = value
                continue
              }
              if (value.type === "text-start") openParts.set(value.id, "text")
              else if (value.type === "text-end") openParts.delete(value.id)
              else if (value.type === "reasoning-start") openParts.set(value.id, "reasoning")
              else if (value.type === "reasoning-end") openParts.delete(value.id)
              writer.write(value)
            }
          } catch (err) {
            failure = failure ?? err
          }
          // response.messages are in-memory objects: tool outputs with
          // `undefined` fields survive here (the wire drops them via
          // JSON.stringify, so the provider never saw them) but FAIL the
          // SDK's jsonValueSchema when fed back in as `messages` on a resume.
          // Round-trip through JSON so accumulated holds exactly what the
          // provider saw.
          accumulated.push(...(JSON.parse(JSON.stringify(completedSteps)) as ModelMessage[]))
          if (completedSteps.length > 0) resumes = 0 // progress refills the budget
          // fold point: accumulated now owns these steps — journal the fold
          latestSteps = []
          writeJournal()
          // refusal-terminal (C14): a content-filter stop is a REFUSAL — it
          // must never be nudged onward or resumed; side-effecting tools after
          // a refusal are exactly what the integrity story cannot afford
          if (!failure && lastFinish === "content-filter") {
            recordTerminal("refusal")
            if (heldFinish) writer.write(heldFinish as Parameters<typeof writer.write>[0])
            console.error("[chat] provider refusal (content-filter) — turn ends without continuation")
            return
          }
          if (!failure) {
            // THE STOP-GATE v2 (adjudicated, C5): a turn that did real work
            // and left its plan open continues; an EMPTY plan is no longer a
            // free exit — a closing "I'll now…" promise is continued too; a
            // stated user-blocking question always passes; and when nudges
            // run out with open work, the harness says so VISIBLY.
            const open = getPlan(wdb, session).filter((t) => t.status !== "done")
            const decision =
              run.stopped || run.ac.signal.aborted
                ? ({ kind: "end" } as const)
                : adjudicateStop({
                    finishReason: lastFinish,
                    ranRealTools,
                    openItems: open.length,
                    nudges,
                    maxNudges: MAX_NUDGES,
                    lastText: lastAssistantText(accumulated),
                  })
            // reply-vs-artifact honesty: a closing message claiming a table
            // the draft doesn't contain is corrected in-turn, never shipped
            if (
              decision.kind === "end" &&
              run.lastDraft &&
              run.lastDraft.tables === 0 &&
              claimsAbsentTable(lastAssistantText(accumulated)) &&
              nudges < MAX_NUDGES
            ) {
              nudges++
              accumulated.push({ role: "user", content: artifactMismatchNudge(run.lastDraft.file) })
              console.error("[chat] reply claims a table the draft lacks — correcting in-turn")
              continue
            }
            if (decision.kind === "continue-open-plan") {
              nudges++
              accumulated.push({ role: "user", content: continuationNudge(open) })
              console.error(
                `[chat] turn ended with ${open.length} open plan items — continuing (${nudges}/${MAX_NUDGES})`,
              )
              continue
            }
            if (decision.kind === "continue-deferred-promise") {
              nudges++
              accumulated.push({ role: "user", content: promiseNudge(lastAssistantText(accumulated)) })
              console.error(
                `[chat] turn ended on a deferred promise with no open plan — continuing (${nudges}/${MAX_NUDGES})`,
              )
              continue
            }
            if (decision.kind === "gave-up") {
              // never end silently with open work: persist a visible notice
              const nid = "harness-gaveup"
              writer.write({ type: "text-start", id: nid })
              writer.write({ type: "text-delta", id: nid, delta: gaveUpNotice(open) })
              writer.write({ type: "text-end", id: nid })
              console.error(`[chat] stop-gate exhausted with ${open.length} open items — surfaced to user`)
            }
            recordTerminal(decision.kind === "gave-up" ? `gave_up_open_${decision.openItems}` : "completed")
            if (heldFinish) writer.write(heldFinish as Parameters<typeof writer.write>[0])
            console.error(
              `[usage] turn done after ${usage.steps} steps: in=${usage.input} ` +
                `(cached=${usage.cachedInput}) out=${usage.output}`,
            )
            return
          }
          // structured classification first: the HTTP status and retry-after
          // headers (when the error chain carries them) beat message regexes
          const fail = classifyFailure(failure)
          const raw = fail.message
          // context overflow is recoverable-BY-COMPACTION, not by blind retry:
          // fold the running turn's steps and resume. Only when compaction
          // cannot reduce anything does the turn end (visibly, work saved).
          if (
            isContextLengthError(raw) &&
            !run.stopped &&
            !run.ac.signal.aborted &&
            overflowRecoveries < 2
          ) {
            overflowRecoveries++
            try {
              if (await foldAccumulated(4)) {
                console.error("[chat] context overflow — compacted this turn's steps, resuming")
                continue
              }
            } catch (err) {
              console.error("[chat] overflow compaction failed:", errorMessageOf(err).slice(0, 200))
            }
          }
          const resumable =
            !run.stopped &&
            !run.ac.signal.aborted &&
            resumes < MAX_RESUMES &&
            isTransientStreamError(raw, fail.statusCode)
          if (!resumable) {
            recordTerminal(
              run.stopped || run.ac.signal.aborted
                ? "user_stop"
                : fail.statusCode
                  ? `provider_${fail.statusCode}`
                  : "provider_error",
            )
            writer.write({ type: "error", errorText: mapError(failure) })
            return
          }
          resumes++
          // close the dying step's dangling parts; the retry arrives as new parts
          for (const [id, kind] of openParts) {
            writer.write({ type: kind === "text" ? "text-end" : "reasoning-end", id })
          }
          // a steer consumed by a tool of the LOST step never reached the model
          // in any surviving message — requeue it for redelivery next attempt
          const survivingToolIds = new Set<string>()
          for (const m of accumulated) {
            if (m.role !== "tool") continue
            for (const part of Array.isArray(m.content) ? m.content : []) {
              const id = (part as { toolCallId?: string }).toolCallId
              if (id) survivingToolIds.add(id)
            }
          }
          const lost = run.delivered.filter((d) => !survivingToolIds.has(d.afterToolCallId))
          if (lost.length > 0) {
            run.pending.unshift(...lost.map((d) => d.text))
            run.delivered = run.delivered.filter((d) => survivingToolIds.has(d.afterToolCallId))
          }
          console.error(
            `[chat] provider stream dropped mid-turn (resume ${resumes}/${MAX_RESUMES} since last progress):`,
            raw.slice(0, 200),
          )
          // jittered backoff — never hammer an overloaded provider with instant
          // full-context retries; an abort cancels the wait. The delay comes
          // from CONSECUTIVE failures (progress resets `resumes`), capped at
          // 60s — the loop's `attempt` index also counts nudges and successful
          // resumes and used to produce uncapped multi-minute stalls. The
          // provider's own cool-down (retry-after header, or the "try again in
          // 5.7s" message hint) is authoritative when present.
          const waitMs = computeBackoffMs(resumes, fail.retryAfterMs ?? retryDelayHintMs(raw))
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, waitMs)
            run.ac.signal.addEventListener(
              "abort",
              () => {
                clearTimeout(t)
                resolve()
              },
              { once: true },
            )
          })
          if (run.stopped || run.ac.signal.aborted) {
            recordTerminal("user_stop")
            return
          }
        }
      },
    })
    const [toClient, toDrain] = uiStream.tee()
    void (async () => {
      const reader = toDrain.getReader()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          // drain keeps generation alive without a client — and now also
          // feeds the reattach buffer + any live subscribers (C7)
          run.buffer.push(value)
          if (run.buffer.length > LIVE_BUFFER_MAX) {
            run.buffer.splice(0, run.buffer.length - LIVE_BUFFER_MAX)
          }
          for (const l of run.listeners) {
            try {
              l.enqueue(value)
            } catch {
              run.listeners.delete(l)
            }
          }
        }
      } catch {
        // draining must never crash the server
      }
      run.ended = true
      for (const l of run.listeners) {
        try {
          l.close()
        } catch {
          /* listener already gone */
        }
      }
      run.listeners.clear()
      run.buffer.length = 0
    })()

    return createUIMessageStreamResponse({
      stream: toClient,
      headers: {
        "x-abstract-session": session,
        // observability: what this turn actually sent to the provider
        "x-abstract-context": String(context.contextChars),
      },
    })
  })

  // unknown API routes must answer JSON — never fall through to the static
  // handler (a stale server + fresh UI otherwise yields opaque parse errors)
  app.all("/api/*", (c) =>
    c.json(
      { error: `unknown API route ${c.req.method} ${c.req.path} — if you just updated the app, restart it` },
      404,
    ),
  )

  if (options.staticDir) {
    app.use("/*", serveStatic({ root: options.staticDir }))
    app.get("*", serveStatic({ path: `${options.staticDir}/index.html` }))
  }

  return { app, workspace }
}

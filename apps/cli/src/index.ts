#!/usr/bin/env bun
import { existsSync, mkdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { DEFAULT_WORKSPACE, GLOBAL_DIR, isUnsafeWorkspace, loadConfig, migrateLegacyGlobalDir } from "@abstract/core"
import { createApp } from "@abstract/server"
import pkg from "../package.json"

const HELP = `abstract — the AI research workbench with verified citations

usage:
  abstract [dir]          open a workspace (default: the last one you opened,
                          else ~/Abstract/default)
  abstract --port <n>     serve on a specific port
  abstract --no-open      don't open the browser
  abstract --version      print the version
`

const args = process.argv.slice(2)
if (args.includes("--help") || args.includes("-h")) {
  console.log(HELP)
  process.exit(0)
}
if (args.includes("--version") || args.includes("-v")) {
  console.log(`abstract ${pkg.version}`)
  process.exit(0)
}
process.env["ABSTRACT_VERSION"] = pkg.version

// settings moved from ~/.openpaper to ~/.abstract — carry existing users over once
const moved = migrateLegacyGlobalDir()
if (moved.result === "moved") console.log(`  moved your settings from ~/.openpaper to ${GLOBAL_DIR}`)
if (moved.result === "failed") {
  console.error(`  could not move ~/.openpaper to ${GLOBAL_DIR} (${moved.error}) — move it by hand to keep your settings`)
}

let dir: string | null = null
let port = loadConfig().port
let openBrowser = true

for (let i = 0; i < args.length; i++) {
  const a = args[i]!
  if (a === "--port" || a === "-p") {
    port = Number(args[++i])
  } else if (a === "--no-open") {
    openBrowser = false
  } else if (!a.startsWith("-")) {
    dir = a
  }
}

// web UI location — standalone build: unpacked to ABSTRACT_WEB_DIR by standalone.ts;
// npm bundle: dist/index.js + dist/web ; repo: apps/cli/src + apps/web/dist
// no folder given: reopen the last workspace, else a dedicated default one.
// Never the terminal's current folder: run from ~ that turned the whole home
// folder into a workspace and the file scanner walked the entire disk.
if (!dir) {
  dir = loadConfig().recentWorkspaces.find((r) => existsSync(r) && !isUnsafeWorkspace(r)) ?? DEFAULT_WORKSPACE
} else if (isUnsafeWorkspace(dir)) {
  console.log(`\n  ${resolve(dir)} is your home folder (or contains it), so abstract won't scan all of it.`)
  console.log(`  Opening ${DEFAULT_WORKSPACE} instead. To work in another folder: abstract ~/my-project`)
  dir = DEFAULT_WORKSPACE
}
if (dir === DEFAULT_WORKSPACE) mkdirSync(dir, { recursive: true })

const staticDir = [
  process.env["ABSTRACT_WEB_DIR"],
  join(import.meta.dir, "web"),
  join(import.meta.dir, "../../web/dist"),
].find((d): d is string => Boolean(d) && existsSync(d!))
const hasStatic = staticDir !== undefined

const { app, workspace } = createApp({
  dir: resolve(dir),
  staticDir: hasStatic ? staticDir : undefined,
})

function serveOnFreePort(startPort: number) {
  for (let p = startPort; p < startPort + 20; p++) {
    try {
      // idleTimeout 0 = never kill an idle connection: a long delegate (parallel
      // sub-agents) or deep read can stream no bytes for minutes; the server-side
      // drain keeps generation + persistence alive regardless of the client.
      return Bun.serve({ hostname: "127.0.0.1", port: p, fetch: app.fetch, idleTimeout: 0 })
    } catch (err) {
      if (err instanceof Error && err.message.includes("in use")) {
        console.log(`  port ${p} is in use — trying ${p + 1}`)
        continue
      }
      throw err
    }
  }
  console.error(`no free port found in ${startPort}-${startPort + 19}`)
  process.exit(1)
}
const server = serveOnFreePort(port)

const url = `http://localhost:${server.port}`
console.log(`\n  Abstract · workspace "${workspace.name}"`)
console.log(`  ${url}\n`)
if (!hasStatic) {
  console.log(`  (web UI not built yet — run \`bun run build\` once,`)
  console.log(`   or use the dev UI: \`bun run dev:web\` → http://localhost:5173)\n`)
}

if (openBrowser && hasStatic) {
  const opener =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open"
  Bun.spawn([opener, url], { stdout: "ignore", stderr: "ignore" })
}

#!/usr/bin/env bun
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { GLOBAL_DIR, loadConfig, migrateLegacyGlobalDir } from "@abstract/core"
import { createApp } from "@abstract/server"

const HELP = `abstract — the AI research workbench with verified citations

usage:
  abstract [dir]          open a workspace (default: current directory)
  abstract --port <n>     serve on a specific port
  abstract --no-open      don't open the browser
`

const args = process.argv.slice(2)

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
  if (a === "--help" || a === "-h") {
    console.log(HELP)
    process.exit(0)
  } else if (a === "--port" || a === "-p") {
    port = Number(args[++i])
  } else if (a === "--no-open") {
    openBrowser = false
  } else if (!a.startsWith("-")) {
    dir = a
  }
}

// bundled layout: dist/index.js + dist/web ; repo layout: apps/cli/src + apps/web/dist
// no explicit dir → reopen the last-used workspace (fall back to cwd)
if (!dir) {
  dir = loadConfig().recentWorkspaces.find((r) => existsSync(r)) ?? process.cwd()
}

const staticDir = [join(import.meta.dir, "web"), join(import.meta.dir, "../../web/dist")].find(
  existsSync,
)
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

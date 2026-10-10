// Entry point of the standalone (single-file) build made by scripts/compile.ts.
// The web UI is embedded in the executable: unpack it once per version into the
// system cache folder, then start the normal CLI. (A cache folder, not
// ~/.abstract — creating that early would defeat the ~/.openpaper move.)
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import pkg from "../package.json"

declare global {
  // set by the generated build entry: web path → embedded file path
  var __ABSTRACT_WEB_FILES__: Record<string, string> | undefined
}

function cacheRoot(): string {
  if (process.platform === "darwin") return join(homedir(), "Library", "Caches", "abstract")
  return join(process.env["XDG_CACHE_HOME"] || join(homedir(), ".cache"), "abstract")
}

const files = globalThis.__ABSTRACT_WEB_FILES__ ?? {}
if (Object.keys(files).length > 0) {
  const root = cacheRoot()
  const webDir = join(root, pkg.version, "web")
  if (!existsSync(join(webDir, "index.html"))) {
    const tmp = join(root, `.unpack-${process.pid}`)
    for (const [rel, embedded] of Object.entries(files)) {
      const out = join(tmp, rel)
      mkdirSync(dirname(out), { recursive: true })
      writeFileSync(out, new Uint8Array(await Bun.file(embedded).arrayBuffer()))
    }
    mkdirSync(dirname(webDir), { recursive: true })
    rmSync(webDir, { recursive: true, force: true })
    renameSync(tmp, webDir)
    // drop UI copies left by older versions
    for (const entry of readdirSync(root)) {
      if (entry !== pkg.version) rmSync(join(root, entry), { recursive: true, force: true })
    }
  }
  process.env["ABSTRACT_WEB_DIR"] = webDir
}

await import("./index.ts")

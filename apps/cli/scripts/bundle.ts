// Build the publishable CLI: one minified bun bundle + the prebuilt web UI,
// with the repo README and LICENSE copied in so npm ships them.
import { chmodSync, copyFileSync, cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const cli = join(import.meta.dir, "..")
const root = join(cli, "../..")
const webDist = join(root, "apps/web/dist")
if (!existsSync(join(webDist, "index.html"))) {
  console.error("web UI not built — run `bun run build` first")
  process.exit(1)
}

rmSync(join(cli, "dist"), { recursive: true, force: true })
const result = await Bun.build({
  entrypoints: [join(cli, "src/index.ts")],
  outdir: join(cli, "dist"),
  target: "bun",
  minify: true,
  // native module: resolved from node_modules at runtime, never bundled
  external: ["@napi-rs/canvas"],
})
if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

const out = join(cli, "dist/index.js")
const body = readFileSync(out, "utf8").replace(/^(#![^\n]*\n)+/, "")
writeFileSync(out, `#!/usr/bin/env bun\n${body}`)
chmodSync(out, 0o755)

cpSync(webDist, join(cli, "dist/web"), { recursive: true })
for (const f of ["README.md", "LICENSE"]) copyFileSync(join(root, f), join(cli, f))
console.log("bundled → apps/cli/dist (with web UI, README, LICENSE)")

import { basename, join, resolve } from "node:path"
import { mkdirSync, writeFileSync, existsSync } from "node:fs"

export interface Workspace {
  /** absolute path to the folder the user opened */
  root: string
  /** display name */
  name: string
  /** workspace-local data dir (gitignored) */
  dataDir: string
  /** sqlite database path */
  dbPath: string
}

export function openWorkspace(dir: string): Workspace {
  const root = resolve(dir)
  const dataDir = join(root, ".openpaper")
  mkdirSync(dataDir, { recursive: true })
  const gitignore = join(dataDir, ".gitignore")
  if (!existsSync(gitignore)) writeFileSync(gitignore, "*\n")
  return {
    root,
    name: basename(root),
    dataDir,
    dbPath: join(dataDir, "openpaper.db"),
  }
}

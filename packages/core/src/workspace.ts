import { homedir } from "node:os"
import { basename, join, resolve } from "node:path"
import { mkdirSync, writeFileSync, existsSync } from "node:fs"

/** what `abstract` opens when no folder is given and none was used before */
export const DEFAULT_WORKSPACE = join(homedir(), "Abstract", "default")

/**
 * Folders that must never become a workspace: the disk root, your home folder,
 * or anything containing it. Scanning those walks your whole computer.
 */
export function isUnsafeWorkspace(dir: string, home: string = homedir()): boolean {
  const r = resolve(dir).replace(/\/+$/, "") || "/"
  const h = resolve(home).replace(/\/+$/, "")
  return r === "/" || r === h || h.startsWith(r + "/")
}

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

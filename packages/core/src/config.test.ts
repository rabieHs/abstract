import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { migrateLegacyGlobalDir } from "./config.ts"

let home: string
let legacy: string
let current: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "abstract-home-"))
  legacy = join(home, ".openpaper")
  current = join(home, ".abstract")
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

describe("migrateLegacyGlobalDir", () => {
  test("moves ~/.openpaper to ~/.abstract with everything inside", () => {
    mkdirSync(join(legacy, "skills"), { recursive: true })
    writeFileSync(join(legacy, "config.json"), '{"port":4477}')
    writeFileSync(join(legacy, "skills", "mine.md"), "# mine")
    expect(migrateLegacyGlobalDir(legacy, current)).toEqual({ result: "moved" })
    expect(existsSync(legacy)).toBe(false)
    expect(readFileSync(join(current, "config.json"), "utf8")).toBe('{"port":4477}')
    expect(readFileSync(join(current, "skills", "mine.md"), "utf8")).toBe("# mine")
  })

  test("does nothing for a new user", () => {
    expect(migrateLegacyGlobalDir(legacy, current)).toEqual({ result: "none" })
    expect(existsSync(current)).toBe(false)
  })

  test("never overwrites or merges when both folders exist", () => {
    mkdirSync(legacy)
    mkdirSync(current)
    writeFileSync(join(legacy, "config.json"), "old")
    writeFileSync(join(current, "config.json"), "new")
    expect(migrateLegacyGlobalDir(legacy, current)).toEqual({ result: "both-exist" })
    expect(readFileSync(join(legacy, "config.json"), "utf8")).toBe("old")
    expect(readFileSync(join(current, "config.json"), "utf8")).toBe("new")
  })

  test("runs once: a second launch finds nothing to move", () => {
    mkdirSync(legacy)
    expect(migrateLegacyGlobalDir(legacy, current).result).toBe("moved")
    expect(migrateLegacyGlobalDir(legacy, current).result).toBe("none")
  })
})

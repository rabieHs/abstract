import { describe, expect, test } from "bun:test"
import { isUnsafeWorkspace } from "./workspace.ts"

describe("isUnsafeWorkspace", () => {
  const home = "/Users/ada"
  test("the disk root, the home folder, and folders containing it are refused", () => {
    expect(isUnsafeWorkspace("/", home)).toBe(true)
    expect(isUnsafeWorkspace("/Users/ada", home)).toBe(true)
    expect(isUnsafeWorkspace("/Users/ada/", home)).toBe(true)
    expect(isUnsafeWorkspace("/Users", home)).toBe(true)
  })
  test("project folders, including ones inside home, are fine", () => {
    expect(isUnsafeWorkspace("/Users/ada/Abstract/default", home)).toBe(false)
    expect(isUnsafeWorkspace("/Users/ada/thesis", home)).toBe(false)
    expect(isUnsafeWorkspace("/Users/adam", home)).toBe(false) // a sibling that only shares a prefix
    expect(isUnsafeWorkspace("/tmp/review", home)).toBe(false)
  })
})

import { beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Workspace } from "@abstract/core"
import {
  listSkills, migrateWorkspaceSkills, readSkill, sanitizeSkillName, saveSkill,
  setSkillStatus, skillsPrompt, venueSkill,
} from "./skills.ts"

// skills are app-wide; tests get an isolated library via the env override
beforeEach(() => {
  process.env["ABSTRACT_SKILLS_DIR"] = mkdtempSync(join(tmpdir(), "op-skills-"))
})

describe("skills", () => {
  test("save → list → read roundtrip with frontmatter", () => {
    saveSkill({
      name: "IEEE Report",
      description: "IEEE two-column conventions",
      body: "# IEEE\n\nUse two columns.",
    })
    const s = readSkill("ieee-report")
    expect(s?.name).toBe("ieee-report")
    expect(s?.description).toBe("IEEE two-column conventions")
    expect(s?.body).toContain("two columns")
    expect(s?.status).toBe("active")
  })

  test("pending → approve via setSkillStatus", () => {
    saveSkill({ name: "abstract-style", description: "how to write abstracts", body: "x".repeat(30), status: "pending" })
    expect(readSkill("abstract-style")?.status).toBe("pending")
    setSkillStatus("abstract-style", "active")
    expect(readSkill("abstract-style")?.status).toBe("active")
  })

  test("skillsPrompt lists only active skills, name+description only", () => {
    saveSkill({ name: "on-skill", description: "always on", body: "SECRET-BODY-CONTENT" })
    saveSkill({ name: "off-skill", description: "switched off", body: "y".repeat(30), status: "disabled" })
    const p = skillsPrompt()
    expect(p).toContain("on-skill: always on")
    expect(p).not.toContain("off-skill")
    expect(p).not.toContain("SECRET-BODY-CONTENT")
  })

  test("venueSkill matches by regex and respects disabled", () => {
    saveSkill({ name: "review-ictai", description: "ICTAI rubric", body: "tool must be evaluated", match: "ictai" })
    expect(venueSkill("ICTAI 2026")?.name).toBe("review-ictai")
    setSkillStatus("review-ictai", "disabled")
    expect(venueSkill("ICTAI 2026")).toBeNull()
  })

  test("directory layout (name/SKILL.md) is read", () => {
    const dir = join(process.env["ABSTRACT_SKILLS_DIR"]!, "prisma-search")
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, "SKILL.md"),
      "---\nname: prisma-search\ndescription: PRISMA search protocol\n---\n\nDocument every query.",
    )
    const s = readSkill("prisma-search")
    expect(s?.description).toBe("PRISMA search protocol")
    expect(s?.body).toContain("every query")
  })

  test("frontmatter-less plain md file still becomes a skill", () => {
    writeFileSync(
      join(process.env["ABSTRACT_SKILLS_DIR"]!, "my-notes-style.md"),
      "Write notes as bullet points with page refs.",
    )
    const s = readSkill("my-notes-style")
    expect(s?.body).toContain("bullet points")
    expect(s?.status).toBe("active")
  })

  test("bad names are rejected", () => {
    expect(() => sanitizeSkillName("!!!")).toThrow()
    expect(sanitizeSkillName("IEEE Report_v2")).toBe("ieee-report-v2")
  })

  test("update rewrites in place — one file, latest content", () => {
    saveSkill({ name: "voice", description: "my voice", body: "first" })
    saveSkill({ name: "voice", description: "my voice v2", body: "second" })
    const all = listSkills().filter((s) => s.name === "voice")
    expect(all).toHaveLength(1)
    expect(all[0]?.description).toBe("my voice v2")
    expect(all[0]?.body).toBe("second")
  })

  test("legacy per-workspace skills are adopted into the app library once", () => {
    const root = mkdtempSync(join(tmpdir(), "op-ws-"))
    const wsSkills = join(root, ".openpaper", "skills")
    mkdirSync(wsSkills, { recursive: true })
    writeFileSync(
      join(wsSkills, "legacy-skill.md"),
      "---\nname: legacy-skill\ndescription: made before app-wide skills\nstatus: active\n---\n\nOld but gold.",
    )
    const ws = { root, name: "t", dbPath: join(root, ".openpaper", "op.db") } as Workspace
    migrateWorkspaceSkills(ws)
    expect(readSkill("legacy-skill")?.body).toContain("Old but gold")
    // app-library copy wins from now on; migrating again never overwrites
    saveSkill({ name: "legacy-skill", description: "edited in app", body: "new content" })
    migrateWorkspaceSkills(ws)
    expect(readSkill("legacy-skill")?.body).toBe("new content")
  })
})

import { matchSkills } from "./skills.ts"

describe("matchSkills (plan echo signal)", () => {
  const library = [
    { name: "literature-review-chapter", description: "Writing a thesis literature review chapter: scoping, synthesis by themes, coverage" },
    { name: "figure-table-audit", description: "Audit a paper's figures and tables under review with view_page pixels" },
    { name: "camera-ready-checklist", description: "Final submission pass: template compliance, metadata, reference completeness" },
  ]

  test("plan wording surfaces the matching skill", () => {
    const m = matchSkills(
      "Build the library then draft the literature review chapter of the thesis with synthesis by themes",
      library,
    )
    expect(m.map((x) => x.name)).toContain("literature-review-chapter")
  })

  test("unrelated plans match nothing", () => {
    expect(matchSkills("fix the login bug and deploy the service", library)).toHaveLength(0)
  })

  test("generic words alone do not trigger matches", () => {
    expect(matchSkills("write the paper", library)).toHaveLength(0)
  })

  test("a lone shared name token ('review') does not surface a wrong-venue rubric", () => {
    const withReview = [
      ...library,
      { name: "review-neurips-icml-iclr", description: "Reviewing rubric for NeurIPS/ICML/ICLR peer review criteria" },
    ]
    // self-review of one's own draft — must NOT pull a venue peer-review rubric
    const m = matchSkills("review the draft like a harsh supervisor and fix the weak parts", withReview)
    expect(m.map((x) => x.name)).not.toContain("review-neurips-icml-iclr")
  })

  test("a real two-token name match still surfaces (camera ready)", () => {
    const m = matchSkills("do the camera ready pass for submission", library)
    expect(m.map((x) => x.name)).toContain("camera-ready-checklist")
  })
})

import { pinActiveSkills } from "./skills.ts"
import { slimModelMessages } from "./compact.ts"
import type { ModelMessage } from "ai"

describe("pinActiveSkills keeps loaded skills in force through a long run", () => {
  test("a skill loaded early survives 30 steps of slimming (the forgetting bug)", () => {
    saveSkill({
      name: "lit-review-pattern",
      description: "how to do a literature review",
      body: "STEP 1: search by concept.\nSTEP 2: read breadth before drafting.\nSTEP 3: one comparison table per dimension.".repeat(40),
    })
    // conversation: load the skill at step 2, then 30 more tool steps
    const msgs: ModelMessage[] = [
      { role: "user", content: "do a literature review" },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "s1", toolName: "use_skill", input: { name: "lit-review-pattern" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "s1", toolName: "use_skill", output: { type: "json", value: { name: "lit-review-pattern", description: "x", instructions: "STEP 1...".repeat(400) } } }] },
    ]
    for (let i = 0; i < 30; i++) {
      msgs.push({ role: "assistant", content: [{ type: "tool-call", toolCallId: `r${i}`, toolName: "read_pages", input: { path: "p.pdf" } }] })
      msgs.push({ role: "tool", content: [{ type: "tool-result", toolCallId: `r${i}`, toolName: "read_pages", output: { type: "json", value: { text: "page text ".repeat(400) } } }] })
    }
    // after slimming, the original skill tool-result is digested away...
    const slimmed = slimModelMessages(msgs)
    const skillResult = slimmed[2]!.content as unknown as { output: { value: Record<string, unknown> } }[]
    expect(JSON.stringify(skillResult[0]!.output.value)).not.toContain("STEP 3")
    // ...but pinActiveSkills re-injects the FULL body at the end
    const pinned = pinActiveSkills(slimmed)
    const last = pinned[pinned.length - 1]!
    expect(last.role).toBe("user")
    expect(last.content as string).toContain("STEP 3: one comparison table per dimension")
    expect(last.content as string).toContain("Skill in force: lit-review-pattern")
  })

  test("no skills loaded → messages untouched", () => {
    const msgs: ModelMessage[] = [{ role: "user", content: "hi" }]
    expect(pinActiveSkills(msgs)).toBe(msgs)
  })
})

describe("matchSkills acronym venues (S10)", () => {
  const skills = [
    { name: "review-acl", description: "reviewer rubric for ACL and computational linguistics venues" },
    { name: "review-cbmi", description: "reviewer rubric for CBMI multimedia indexing submissions" },
  ]
  test("a 3-char venue acronym in the task can now surface its skill", () => {
    const m = matchSkills("review my ACL paper on parsing before the deadline", skills)
    expect(m.map((x) => x.name)).toContain("review-acl")
  })
  test("lowercase incidental words do not fake an acronym hit", () => {
    const m = matchSkills("read the acl tendon injury literature for my biomechanics summary", skills)
    // 'acl' appears only lowercase — not an uppercase acronym in the text
    expect(m.map((x) => x.name)).not.toContain("review-acl")
  })
})

import { listSkillFiles, readSkillFile, saveSkill as save2 } from "./skills.ts"
import { mkdirSync as mkd, writeFileSync as wf } from "node:fs"
import { join as j2 } from "node:path"

describe("skills references/ level (C13 — progressive disclosure level 3)", () => {
  test("directory-form skill lists and serves bundled reference files, jailed", () => {
    const dir = process.env["ABSTRACT_SKILLS_DIR"]!
    mkd(j2(dir, "review-deep", "references"), { recursive: true })
    wf(j2(dir, "review-deep", "SKILL.md"), "---\nname: review-deep\ndescription: deep venue rubric\nstatus: active\n---\nSlim body points at references.")
    wf(j2(dir, "review-deep", "references", "checklist.md"), "# The 40-item checklist\n1. claims match evidence")
    expect(listSkillFiles("review-deep")).toEqual(["references/checklist.md"])
    const r = readSkillFile("review-deep", "references/checklist.md")
    expect("content" in r && r.content).toContain("40-item checklist")
    const esc = readSkillFile("review-deep", "../../../etc/passwd")
    expect("error" in esc && esc.error).toContain("escapes")
  })
  test("flat-file skills have no reference files", () => {
    save2({ name: "flat-one", description: "flat", body: "body" })
    expect(listSkillFiles("flat-one")).toEqual([])
    const r = readSkillFile("flat-one", "anything.md")
    expect("error" in r).toBe(true)
  })
})

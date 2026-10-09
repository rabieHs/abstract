import { describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync, mkdtempSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { ModelMessage } from "ai"
import type { Workspace } from "@abstract/core"
import { attachViewedVisuals } from "./view.ts"

function fakeWorkspace(): Workspace {
  const root = mkdtempSync(join(tmpdir(), "abstract-view-"))
  mkdirSync(join(root, "figures"), { recursive: true })
  return { root } as Workspace
}

function png(ws: Workspace, name: string): string {
  const rel = `figures/${name}`
  // 1x1 transparent PNG
  writeFileSync(
    join(ws.root, rel),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "base64",
    ),
  )
  return rel
}

function viewResult(file: string, callId: string): ModelMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: callId,
        toolName: "view_page",
        output: { type: "json", value: { file, page: 1, source: "sources/x.pdf", note: "" } },
      },
    ],
  } as ModelMessage
}

const user = (text: string): ModelMessage => ({ role: "user", content: text })
const assistant = (text: string): ModelMessage => ({ role: "assistant", content: text })

describe("attachViewedVisuals", () => {
  test("no views → same array untouched", () => {
    const ws = fakeWorkspace()
    const messages = [user("hi"), assistant("hello")]
    expect(attachViewedVisuals(messages, ws)).toBe(messages)
  })

  test("injects pixels directly after the tool message", () => {
    const ws = fakeWorkspace()
    const rel = png(ws, "a-p1.png")
    const messages = [user("look"), assistant("viewing"), viewResult(rel, "c1"), assistant("I see it")]
    const out = attachViewedVisuals(messages, ws)
    expect(out).toHaveLength(5)
    const injected = out[3]!
    expect(injected.role).toBe("user")
    const parts = injected.content as unknown as Array<{ type: string }>
    expect(parts[0]!.type).toBe("image")
    expect(parts[parts.length - 1]!.type).toBe("text")
    // original messages preserved in order
    expect(out[2]).toBe(messages[2])
    expect(out[4]).toBe(messages[3])
  })

  test("only the most recent 4 distinct views ride as pixels", () => {
    const ws = fakeWorkspace()
    const messages: ModelMessage[] = [user("go")]
    for (let i = 0; i < 6; i++) messages.push(viewResult(png(ws, `f${i}.png`), `c${i}`))
    const out = attachViewedVisuals(messages, ws)
    const injected = out.filter((m, i) => m !== messages[Math.min(i, messages.length - 1)])
    expect(out.length).toBe(messages.length + 4) // 4 attachments, not 6
    // the two oldest views got no attachment
    const texts = out
      .flatMap((m) => (Array.isArray(m.content) ? (m.content as unknown as { type: string; text?: string }[]) : []))
      .filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
    expect(texts.some((t) => t.includes("f0.png"))).toBe(false)
    expect(texts.some((t) => t.includes("f5.png"))).toBe(true)
  })

  test("re-viewing the same file attaches once, at the latest occurrence", () => {
    const ws = fakeWorkspace()
    const rel = png(ws, "same.png")
    const messages = [viewResult(rel, "c1"), assistant("hmm"), viewResult(rel, "c2")]
    const out = attachViewedVisuals(messages, ws)
    expect(out).toHaveLength(4)
    expect(out[3]!.role).toBe("user") // attached after the LAST view
    expect(out[1]).toBe(messages[1])
  })

  test("missing file on disk → no attachment, array untouched", () => {
    const ws = fakeWorkspace()
    const messages = [viewResult("figures/deleted.png", "c1")]
    expect(attachViewedVisuals(messages, ws)).toBe(messages)
  })

  test("error outputs are ignored", () => {
    const ws = fakeWorkspace()
    const messages: ModelMessage[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "view_page",
            output: { type: "json", value: { error: "could not render" } },
          },
        ],
      } as ModelMessage,
    ]
    expect(attachViewedVisuals(messages, ws)).toBe(messages)
  })

  test("paths escaping the workspace or outside figures/ are never attached", () => {
    const ws = fakeWorkspace()
    // a real file outside the workspace that a crafted history might point at
    const outside = join(ws.root, "..", "secret.png")
    writeFileSync(outside, "not for the model")
    const inRootNotFigures = "secret2.png"
    writeFileSync(join(ws.root, inRootNotFigures), "also not attachable")
    const messages = [
      viewResult("../secret.png", "c1"),
      viewResult("figures/../../secret.png", "c2"),
      viewResult(inRootNotFigures, "c3"),
    ]
    expect(attachViewedVisuals(messages, ws)).toBe(messages)
  })

  test("oversized artifacts are skipped, not attached", () => {
    const ws = fakeWorkspace()
    const rel = "figures/huge.png"
    writeFileSync(join(ws.root, rel), Buffer.alloc(4_000_001))
    const messages = [viewResult(rel, "c1")]
    expect(attachViewedVisuals(messages, ws)).toBe(messages)
  })

  test("jpg attachments declare image/jpeg", () => {
    const ws = fakeWorkspace()
    const rel = "figures/photo-abc123.jpg"
    writeFileSync(join(ws.root, rel), Buffer.from([0xff, 0xd8, 0xff, 0xe0]))
    const messages = [viewResult(rel, "c1")]
    const out = attachViewedVisuals(messages, ws)
    expect(out).toHaveLength(2)
    const parts = out[1]!.content as unknown as Array<{ type: string; mediaType?: string }>
    expect(parts[0]!.mediaType).toBe("image/jpeg")
  })
})

describe("renderView artifact naming", () => {
  test("same basename in different directories yields distinct artifacts", async () => {
    const { renderView } = await import("./view.ts")
    const ws = fakeWorkspace()
    mkdirSync(join(ws.root, "v1"), { recursive: true })
    mkdirSync(join(ws.root, "v2"), { recursive: true })
    const pngBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "base64",
    )
    writeFileSync(join(ws.root, "v1/fig.png"), pngBytes)
    writeFileSync(join(ws.root, "v2/fig.png"), pngBytes)
    const a = await renderView(ws, "v1/fig.png", join(ws.root, "v1/fig.png"), 1)
    const b = await renderView(ws, "v2/fig.png", join(ws.root, "v2/fig.png"), 1)
    if ("error" in a || "error" in b) throw new Error("render failed")
    expect(a.file).not.toBe(b.file)
    expect(a.file.startsWith("figures/")).toBe(true)
  })

  test("jpg keeps its real extension", async () => {
    const { renderView } = await import("./view.ts")
    const ws = fakeWorkspace()
    writeFileSync(join(ws.root, "photo.jpeg"), Buffer.from([0xff, 0xd8, 0xff, 0xe0]))
    const r = await renderView(ws, "photo.jpeg", join(ws.root, "photo.jpeg"), 1)
    if ("error" in r) throw new Error(r.error)
    expect(r.file.endsWith(".jpg")).toBe(true)
  })
})

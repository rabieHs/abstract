import type { ModelMessage } from "ai"
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { basename, extname, join, resolve, sep } from "node:path"
import type { Workspace } from "@abstract/core"

/**
 * First-hand sight for the lead agent.
 *
 * view_page renders a PDF page (or an image file) to an artifact saved under
 * figures/ in the workspace, and attachViewedVisuals() re-attaches those
 * pixels to the model conversation on every step — tied to the tool result,
 * never rendered in the chat transcript. The attachment rides a plain user
 * message because tool results cannot carry images on every provider
 * (Gemini's are JSON-only); providers merge it into the tool-result turn.
 *
 * Aging: only the most recent MAX_ATTACHED distinct views travel as pixels.
 * Older view results keep their file path (the artifact stays on disk), and
 * the tool teaches the model to view again when it needs another look.
 */

const VIEW_DIR = "figures"
const MAX_ATTACHED = 4
const RENDER_SCALE = 2 // ~1224×1584 for letter/A4 — legible axis labels, modest tokens
// hard ceiling per artifact: an image over provider limits would fail the
// request on EVERY step (the attachment is re-injected each one) — better to
// refuse at render time than to brick the session at stream time
const MAX_IMAGE_BYTES = 4_000_000

/** stable 6-hex-char tag of the SOURCE path — same-basename sources
 *  (v1/paper.pdf vs v2/paper.pdf) must never collide on one artifact */
function pathTag(relPath: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < relPath.length; i++) {
    h ^= relPath.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, "0").slice(0, 6)
}

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
}

export interface ViewResult {
  file: string
  page: number
  source: string
  note: string
}

export async function renderView(
  workspace: Workspace,
  relPath: string,
  fullPath: string,
  page: number,
): Promise<ViewResult | { error: string }> {
  const ext = extname(fullPath).toLowerCase()
  const stem = basename(relPath, extname(relPath)).replace(/[^\w.-]+/g, "_")
  const tag = pathTag(relPath)

  let bytes: Uint8Array
  let name: string
  if (IMAGE_TYPES[ext]) {
    // the file IS the visual — keep its real format; a copy under figures/
    // gives the artifact and its provenance one predictable home
    bytes = new Uint8Array(readFileSync(fullPath))
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      const scaled = await downscaleImage(bytes)
      if (!scaled) {
        return {
          error: `${relPath} is ${(bytes.byteLength / 1e6).toFixed(1)}MB — too large to attach; ask_document can still answer questions about it`,
        }
      }
      bytes = scaled
      name = `${stem}-${tag}.png`
    } else {
      name = `${stem}-${tag}${ext === ".jpeg" ? ".jpg" : ext}`
    }
    page = 1
  } else if (ext === ".pdf") {
    const pdf = new Uint8Array(readFileSync(fullPath))
    // provider limits are per-request and the attachment repeats every step:
    // if the full-detail render is too heavy, fall back to a lighter scale
    let rendered: Uint8Array | { error: string } | null = null
    for (const scale of [RENDER_SCALE, 1.25]) {
      rendered = await renderPdfPage(pdf, page, scale, relPath)
      if (rendered instanceof Uint8Array && rendered.byteLength <= MAX_IMAGE_BYTES) break
    }
    if (!(rendered instanceof Uint8Array)) return rendered ?? { error: "render failed" }
    if (rendered.byteLength > MAX_IMAGE_BYTES) {
      return {
        error: `page ${page} of ${relPath} renders larger than the attachment limit — ask_document can still answer questions about it`,
      }
    }
    bytes = rendered
    name = `${stem}-${tag}-p${page}.png`
  } else {
    return { error: `view_page supports pdf/png/jpg, got ${ext || "no extension"}` }
  }

  const dir = join(workspace.root, VIEW_DIR)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const file = `${VIEW_DIR}/${name}`
  writeFileSync(join(workspace.root, file), bytes)
  return {
    file,
    page,
    source: relPath,
    note:
      "the rendered page rides with this result as an image while it is among your most " +
      "recent views — you are looking at the actual pixels. Older views keep only this " +
      "file path; view again when you need another look.",
  }
}

async function renderPdfPage(
  pdf: Uint8Array,
  page: number,
  scale: number,
  relPath: string,
): Promise<Uint8Array | { error: string }> {
  const { renderPageAsImage } = await import("unpdf")
  try {
    const img = await renderPageAsImage(pdf, page, {
      canvasImport: () => import("@napi-rs/canvas"),
      scale,
    })
    return new Uint8Array(img)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { error: `could not render page ${page} of ${relPath}: ${msg}` }
  }
}

/** shrink an oversized raster to attachable weight; null when it cannot */
async function downscaleImage(bytes: Uint8Array): Promise<Uint8Array | null> {
  try {
    const { createCanvas, loadImage } = await import("@napi-rs/canvas")
    const img = await loadImage(Buffer.from(bytes))
    const ratio = Math.min(1, 1600 / Math.max(img.width, img.height))
    const canvas = createCanvas(Math.round(img.width * ratio), Math.round(img.height * ratio))
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height)
    const out = new Uint8Array(canvas.toBuffer("image/png"))
    return out.byteLength <= MAX_IMAGE_BYTES ? out : null
  } catch {
    return null
  }
}

/** file paths of view_page results in a model message, in order */
function viewedFiles(m: ModelMessage): string[] {
  if (m.role !== "tool" || !Array.isArray(m.content)) return []
  const files: string[] = []
  for (const part of m.content) {
    if (part.type !== "tool-result" || part.toolName !== "view_page") continue
    const out = part.output as { type?: string; value?: unknown } | undefined
    const value = out?.type === "json" ? (out.value as Record<string, unknown>) : undefined
    if (value && typeof value["file"] === "string" && !value["error"]) {
      files.push(value["file"] as string)
    }
  }
  return files
}

/** history is not trusted: attachments may only come from figures/ inside the
 *  workspace, at attachable weight — everything else stays a bare path */
function attachablePath(workspace: Workspace, file: string): string | null {
  if (!file.startsWith(`${VIEW_DIR}/`)) return null
  const abs = resolve(workspace.root, file)
  if (!abs.startsWith(resolve(workspace.root) + sep)) return null
  if (!existsSync(abs)) return null
  if (statSync(abs).size > MAX_IMAGE_BYTES) return null
  return abs
}

/**
 * Inject the pixels of recent view_page results into the model conversation,
 * directly after the tool message that produced each of them. Pure function of
 * (messages, disk): recomputed every step, so the same views yield the same
 * prompt prefix and the cache stays warm. Returns the input array untouched
 * when there is nothing to attach.
 */
export function attachViewedVisuals(
  messages: ModelMessage[],
  workspace: Workspace,
): ModelMessage[] {
  // most recent occurrence wins; older duplicates of the same file stay bare
  const lastIndexOf = new Map<string, number>()
  messages.forEach((m, i) => {
    for (const f of viewedFiles(m)) lastIndexOf.set(f, i)
  })
  if (lastIndexOf.size === 0) return messages

  const recent = [...lastIndexOf.entries()]
    .sort((a, b) => a[1] - b[1])
    .slice(-MAX_ATTACHED)
  const attachAt = new Map<number, { file: string; abs: string }[]>()
  for (const [file, idx] of recent) {
    const abs = attachablePath(workspace, file)
    if (!abs) continue
    const at = attachAt.get(idx) ?? []
    at.push({ file, abs })
    attachAt.set(idx, at)
  }
  if (attachAt.size === 0) return messages

  const out: ModelMessage[] = []
  messages.forEach((m, i) => {
    out.push(m)
    const files = attachAt.get(i)
    if (!files) return
    out.push({
      role: "user",
      content: [
        ...files.map(({ file, abs }) => ({
          type: "image" as const,
          image: new Uint8Array(readFileSync(abs)),
          mediaType: IMAGE_TYPES[extname(file).toLowerCase()] ?? "image/png",
        })),
        {
          type: "text" as const,
          text:
            `[system attachment for the view_page result above: ${files.map((f) => f.file).join(", ")} — ` +
            "the actual rendered pixels, not a user message]",
        },
      ],
    })
  })
  return out
}

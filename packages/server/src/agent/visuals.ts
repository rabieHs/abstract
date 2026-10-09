import { generateObject, type LanguageModel } from "ai"
import { z } from "zod"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { Database, Workspace } from "@abstract/core"

/**
 * Visual inventory: one vision pass per ingested PDF catalogs every figure,
 * table, and chart into searchable chunks — so search_library can FIND
 * visual content, and ask_document can then look at it in detail.
 */

const Inventory = z.object({
  items: z
    .array(
      z.object({
        kind: z.enum(["figure", "table", "chart", "equation", "other"]),
        label: z.string().describe('as printed, e.g. "Figure 3" or "Table 1"'),
        page: z.number().int().min(1),
        description: z
          .string()
          .describe(
            "2-3 sentences: what it shows, axes/columns, and the KEY numbers or trends visible",
          ),
      }),
    )
    .max(60),
})
export type VisualItem = z.infer<typeof Inventory>["items"][number]

export function storeVisuals(db: Database, sourceId: string, items: VisualItem[]): number {
  const ins = db.query(
    "INSERT OR REPLACE INTO chunks (id, source_id, section, page, text) VALUES (?, ?, 'visual', ?, ?)",
  )
  items.forEach((it, i) =>
    ins.run(
      `${sourceId}:vis:${i}`,
      sourceId,
      it.page,
      `[VISUAL] ${it.label} (${it.kind}), p.${it.page}: ${it.description}`,
    ),
  )
  return items.length
}

export async function inventoryPdf(
  db: Database,
  workspace: Workspace,
  relPath: string,
  model: LanguageModel,
): Promise<{ cataloged: number } | { skipped: string }> {
  const row = db.query("SELECT id FROM sources WHERE path = ?").get(relPath) as { id: string } | null
  if (!row) return { skipped: "source not found" }
  const bytes = readFileSync(join(workspace.root, relPath))
  if (bytes.byteLength > 18_000_000) return { skipped: "pdf larger than 18MB — inventory skipped" }
  const { object } = await generateObject({
    model,
    schema: Inventory,
    messages: [
      {
        role: "user",
        content: [
          { type: "file", data: bytes, mediaType: "application/pdf" },
          {
            type: "text",
            text:
              "Catalog EVERY figure, table, and chart in this document (skip pure text). " +
              "For each: its printed label, the page it appears on, and a dense description " +
              "including the key values or trends a reader would take from it. " +
              "Return an empty list if there are none.",
          },
        ],
      },
    ],
  })
  return { cataloged: storeVisuals(db, row.id, object.items) }
}

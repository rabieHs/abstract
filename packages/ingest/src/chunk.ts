export interface Chunk {
  page: number | null
  charStart: number
  charEnd: number
  lineStart?: number
  lineEnd?: number
  text: string
}

const TARGET = 1400
const MAX = 2000

/**
 * Pack paragraphs into ~TARGET-char chunks, never splitting a paragraph
 * unless it alone exceeds MAX. Offsets index into the given text.
 */
export function chunkText(text: string, page: number | null = null): Chunk[] {
  const chunks: Chunk[] = []
  let start = 0
  let cur = ""
  let curStart = 0

  const flush = (end: number) => {
    const t = cur.trim()
    if (t.length > 40) chunks.push({ page, charStart: curStart, charEnd: end, text: t })
    cur = ""
  }

  const paras = text.split(/\n\s*\n/)
  for (const para of paras) {
    const idx = text.indexOf(para, start)
    const pStart = idx === -1 ? start : idx
    start = pStart + para.length

    if (para.length > MAX) {
      flush(pStart)
      // split oversized paragraph on sentence boundaries
      let sStart = pStart
      let buf = ""
      let bufStart = pStart
      for (const sent of para.split(/(?<=[.!?])\s+/)) {
        if (buf.length + sent.length > MAX && buf) {
          chunks.push({ page, charStart: bufStart, charEnd: sStart, text: buf.trim() })
          buf = ""
          bufStart = sStart
        }
        buf += (buf ? " " : "") + sent
        sStart += sent.length + 1
      }
      if (buf.trim().length > 40)
        chunks.push({ page, charStart: bufStart, charEnd: start, text: buf.trim() })
      curStart = start
      continue
    }

    if (cur.length + para.length > TARGET && cur) flush(pStart)
    if (!cur) curStart = pStart
    cur += (cur ? "\n\n" : "") + para
  }
  flush(text.length)
  return chunks
}

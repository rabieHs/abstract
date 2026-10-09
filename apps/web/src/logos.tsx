import { useEffect, useRef } from "react"

/** the animated wordmark shown on the empty chat screen */
export function HeroLogo() {
  return <AbstractWordmark />
}

/** deterministic PRNG — the mark must be identical on every load */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296)
}
const ease = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x * x * (3 - 2 * x))

/** shared canvas loop plumbing: dpr scaling, 30fps, reduced-motion static frame */
function useMarkCanvas(
  logicalW: number,
  logicalH: number,
  makeDraw: (ctx: CanvasRenderingContext2D, ink: () => string) => (t: number) => void,
) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = logicalW * dpr
    canvas.height = logicalH * dpr
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    ctx.scale(dpr, dpr)
    let inkCache = getComputedStyle(canvas).color
    const ink = () => inkCache
    const draw = makeDraw(ctx, ink)
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches
    if (reduced) {
      draw(-1) // sentinel: draw the resolved static frame
      return
    }
    const t0 = performance.now()
    let raf = 0
    let last = 0
    let frames = 0
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      if (now - last < 31) return // ~30fps is plenty for ink on paper
      last = now
      if (++frames % 90 === 0) inkCache = getComputedStyle(canvas).color
      draw((now - t0) / 1000)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [])
  return ref
}

/* ------------------------------------------------------------------ *
 * ABSTRACT WORDMARK — polygon shards swim in space, construct the
 * word facet by facet, hold, split, and swim again. Never an empty frame.
 * ------------------------------------------------------------------ */

const EW = 680, EH = 340

function AbstractWordmark({ width = 560 }: { width?: number }) {
  const ref = useMarkCanvas(EW, EH, (ctx, ink) => {
    const r = rng(2026)
    const off = document.createElement("canvas")
    off.width = EW
    off.height = EH
    const octx = off.getContext("2d")!
    const face = (px: number) => `${px}px 'Arial Black', 'Helvetica Neue', Arial, sans-serif`
    let fpx = 132
    octx.font = face(fpx)
    const w0 = octx.measureText("abstract").width
    if (w0 > 580) {
      fpx = Math.floor((fpx * 580) / w0)
      octx.font = face(fpx)
    }
    octx.textAlign = "center"
    octx.textBaseline = "middle"
    octx.fillText("abstract", EW / 2, EH / 2 + 6)
    const img = octx.getImageData(0, 0, EW, EH).data
    const hit = (x: number, y: number) => {
      const xi = Math.round(x), yi = Math.round(y)
      if (xi < 0 || yi < 0 || xi >= EW || yi >= EH) return false
      return img[(yi * EW + xi) * 4 + 3]! > 90
    }
    const CELL = 7
    const cols = Math.ceil(EW / CELL) + 1, rows = Math.ceil(EH / CELL) + 1
    const verts: { x: number; y: number }[] = []
    for (let y = 0; y < rows; y++)
      for (let x = 0; x < cols; x++)
        verts.push({ x: x * CELL + (r() - 0.5) * 2.6, y: y * CELL + (r() - 0.5) * 2.6 })
    const vat = (x: number, y: number) => verts[y * cols + x]!
    type Tri = {
      v: { x: number; y: number }[]
      cx: number; cy: number
      hx: number; hy: number
      w1: number; w2: number; ws1: number; ws2: number
      spin: number; sp0: number; delay: number; shade: number
    }
    const tris: Tri[] = []
    for (let y = 0; y < rows - 1; y++)
      for (let x = 0; x < cols - 1; x++) {
        const v00 = vat(x, y), v10 = vat(x + 1, y), v01 = vat(x, y + 1), v11 = vat(x + 1, y + 1)
        const pair =
          (x + y) % 2 === 0
            ? [[v00, v10, v11], [v00, v11, v01]]
            : [[v00, v10, v01], [v10, v11, v01]]
        for (const tv of pair) {
          const cx = (tv[0]!.x + tv[1]!.x + tv[2]!.x) / 3
          const cy = (tv[0]!.y + tv[1]!.y + tv[2]!.y) / 3
          const hits = tv.filter((v) => hit(v!.x, v!.y)).length + (hit(cx, cy) ? 2 : 0)
          if (hits >= 4) {
            tris.push({
              v: tv.map((v) => ({ x: v!.x - cx, y: v!.y - cy })),
              cx, cy,
              hx: 40 + r() * (EW - 80), hy: 34 + r() * (EH - 68),
              w1: r() * Math.PI * 2, w2: r() * Math.PI * 2,
              ws1: 0.22 + r() * 0.3, ws2: 0.18 + r() * 0.26,
              spin: (r() - 0.5) * 0.7, sp0: r() * Math.PI * 2,
              delay: (cx / EW) * 0.5 + r() * 0.12,
              shade: 0.62 + r() * 0.33,
            })
          }
        }
      }
    const T = 13
    return (t: number) => {
      const still = t < 0
      if (still) t = 0
      const p = still ? 0.45 : (t % T) / T
      ctx.clearRect(0, 0, EW, EH)
      // 0-.2 swim · .2-.36 construct · .36-.66 hold · .66-.8 split · .8-1 swim
      ctx.lineWidth = 0.6
      for (const tr of tris) {
        let k: number // 0 = swimming, 1 = in the word
        if (p < 0.2) k = 0
        else if (p < 0.36) k = ease(((p - 0.2) / 0.16 - tr.delay * 0.6) / (1 - tr.delay * 0.6))
        else if (p < 0.66) k = 1
        else if (p < 0.8) k = 1 - ease(((p - 0.66) / 0.14 - tr.delay * 0.4) / (1 - tr.delay * 0.4))
        else k = 0

        const sx = tr.hx + Math.sin(t * tr.ws1 + tr.w1) * 16
        const sy = tr.hy + Math.cos(t * tr.ws2 + tr.w2) * 13
        const rot = (1 - k) * (tr.sp0 + t * tr.spin)
        const ox = sx + (tr.cx - sx) * k, oy = sy + (tr.cy - sy) * k
        const cos = Math.cos(rot), sin = Math.sin(rot)
        ctx.beginPath()
        tr.v.forEach((v, i) => {
          const x = ox + v.x * cos - v.y * sin, y = oy + v.x * sin + v.y * cos
          if (i === 0) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        })
        ctx.closePath()
        ctx.globalAlpha = 0.1 + k * tr.shade * 0.85
        ctx.fillStyle = ink()
        ctx.fill()
        ctx.globalAlpha = 0.3 + k * 0.4
        ctx.strokeStyle = ink()
        ctx.stroke()
      }
      ctx.globalAlpha = 1
    }
  })
  return (
    <canvas
      ref={ref}
      role="img"
      aria-label="abstract — the wordmark, constructed from polygons"
      className="select-none text-ink"
      style={{ width, height: width / 2 }}
    />
  )
}

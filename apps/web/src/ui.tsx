import { memo, useEffect, useRef, useState, type ReactNode } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { STEP_ICONS, STEP_NAMES } from "./api"

/** minimal black stroke icons — no boxes, currentColor */
const ICON_PATHS: Record<string, ReactNode> = {
  search: (
    <>
      <circle cx="6.5" cy="6.5" r="4.5" />
      <path d="M10 10l4 4" />
    </>
  ),
  globe: (
    <>
      <circle cx="8" cy="8" r="6.5" />
      <path d="M1.5 8h13M8 1.5c2.6 2 2.6 11 0 13M8 1.5c-2.6 2-2.6 11 0 13" />
    </>
  ),
  download: <path d="M8 2v8M4.5 7L8 10.5 11.5 7M2.5 13.5h11" />,
  box: (
    <>
      <rect x="2.5" y="5" width="11" height="8.5" />
      <path d="M2.5 5L8 1.5 13.5 5M8 8v3" />
    </>
  ),
  filetext: (
    <>
      <path d="M3.5 1.5h6L12.5 5v9.5h-9z" />
      <path d="M9.5 1.5V5h3M5.5 8.5h5M5.5 11h5" />
    </>
  ),
  pen: <path d="M3 13l1-3.5L11.5 2 14 4.5 6.5 12zM10.5 3l2.5 2.5" />,
  export: <path d="M6 2.5h7.5V10M13.5 2.5L6.5 9.5M3 6.5v7h7" />,
  check: (
    <>
      <rect x="2" y="2" width="12" height="12" />
      <path d="M5 8.5l2 2 4-4.5" />
    </>
  ),
  diamond: <path d="M8 1.5L14.5 8 8 14.5 1.5 8z" />,
  eye: (
    <>
      <path d="M1.5 8c2-3 4.2-4.5 6.5-4.5S12.5 5 14.5 8c-2 3-4.2 4.5-6.5 4.5S3.5 11 1.5 8z" />
      <circle cx="8" cy="8" r="2" />
    </>
  ),
  list: <path d="M5.5 3.5h9M5.5 8h9M5.5 12.5h9M2 3.5h1M2 8h1M2 12.5h1" />,
  note: (
    <>
      <path d="M3 2.5h10v11H3z" />
      <path d="M5.5 5.5h5M5.5 8h5M5.5 10.5h3" />
    </>
  ),
  pages: (
    <>
      <path d="M8 3.5C6.2 2.3 3.5 2.3 1.8 3.2v9.6c1.7-.9 4.4-.9 6.2.3 1.8-1.2 4.5-1.2 6.2-.3V3.2C12.5 2.3 9.8 2.3 8 3.5z" />
      <path d="M8 3.5v9.6M3.8 5.8c1-.3 2-.3 2.8 0M3.8 8c1-.3 2-.3 2.8 0M9.4 5.8c1-.3 2-.3 2.8 0M9.4 8c1-.3 2-.3 2.8 0" />
    </>
  ),
  file: (
    <>
      <path d="M3.5 1.5h6L12.5 5v9.5h-9z" />
      <path d="M9.5 1.5V5h3" />
    </>
  ),
  folder: <path d="M1.5 3.5h5l1.5 2h6.5v7.5h-13z" />,
  book: (
    <>
      <path d="M8 3.5C6.5 2.5 4 2.5 2.5 3v10c1.5-.5 4-.5 5.5.5 1.5-1 4-1 5.5-.5V3c-1.5-.5-4-.5-5.5.5z" />
      <path d="M8 3.5v10" />
    </>
  ),
  image: (
    <>
      <rect x="2" y="3" width="12" height="10" />
      <circle cx="5.5" cy="6.5" r="1.2" />
      <path d="M2 11l3.5-3 3 2.5L11 8l3 3" />
    </>
  ),
  clip: <path d="M11.5 4.5l-5 5a1.8 1.8 0 002.5 2.5l5-5a3.2 3.2 0 00-4.5-4.5l-5 5a4.6 4.6 0 006.5 6.5l4-4" />,
  trash: (
    <>
      <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9" />
      <path d="M6.8 7v4M9.2 7v4" />
    </>
  ),
}

export function Icon({ name, className }: { name: string; className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="square"
      className={className}
      aria-hidden
    >
      {ICON_PATHS[name] ?? <circle cx="8" cy="8" r="2" />}
    </svg>
  )
}

/** assistant prose — markdown rendered in the flat DS voice.
 *  memo matters: parsing is the expensive part, and during streaming every
 *  COMPLETED text part keeps a byte-identical string across ticks — only the
 *  one growing part re-parses. */
export const Md = memo(function Md({ text }: { text: string }) {
  return (
    <div className="op-md text-[15px] leading-[1.7]">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: (p) => <h3 className="mb-1 mt-3 font-serif text-lg font-semibold" {...p} />,
          h2: (p) => <h3 className="mb-1 mt-3 font-serif text-lg font-semibold" {...p} />,
          h3: (p) => <h4 className="mb-1 mt-3 text-[15px] font-semibold" {...p} />,
          p: (p) => <p className="my-1.5" {...p} />,
          ul: (p) => <ul className="my-1.5 list-disc pl-5" {...p} />,
          ol: (p) => <ol className="my-1.5 list-decimal pl-5" {...p} />,
          li: (p) => <li className="my-0.5" {...p} />,
          blockquote: (p) => (
            <blockquote className="my-2 border-l-2 border-linec pl-3 text-muted" {...p} />
          ),
          code: (p) => (
            <code className="bg-paper px-1 py-0.5 font-mono text-[12.5px]" {...p} />
          ),
          pre: (p) => (
            <pre
              className="my-2 overflow-x-auto border border-linec bg-paper p-3 font-mono text-[12px] leading-relaxed [&_code]:bg-transparent [&_code]:p-0"
              {...p}
            />
          ),
          a: (p) => <a className="text-accent underline underline-offset-2" {...p} />,
          table: (p) => (
            <div className="my-2 overflow-x-auto">
              <table className="border-collapse border border-linec text-[13px]" {...p} />
            </div>
          ),
          th: (p) => <th className="border border-linec bg-paper px-2 py-1 text-left" {...p} />,
          td: (p) => <td className="border border-linec px-2 py-1" {...p} />,
          hr: () => <div className="hatch my-3" />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})

/** the working indicator — a small geared wheel advancing in clockwork ticks */
export function Escapement({ size = 20 }: { size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = size * dpr
    canvas.height = size * dpr
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    ctx.scale((dpr * size) / 20, (dpr * size) / 20) // drawn in 20px logical coords
    const ink = getComputedStyle(canvas).color
    const cx = 10, cy = 10, R = 7.6
    const draw = (t: number) => {
      ctx.clearRect(0, 0, 20, 20)
      const BEAT = 0.8
      const k = Math.floor(t / BEAT), q = (t % BEAT) / BEAT
      // snap forward with a springy settle, then rest until the next tick
      const f = q < 0.4 ? 1 - Math.exp(-6 * (q / 0.4)) * Math.cos(9 * (q / 0.4)) : 1
      const rot = ((k + f) * Math.PI * 2) / 6 - Math.PI / 2
      ctx.strokeStyle = ink
      ctx.fillStyle = ink
      ctx.globalAlpha = 0.55
      ctx.lineWidth = 0.8
      ctx.beginPath()
      for (let i = 0; i < 6; i++) {
        const a = rot + (i / 6) * Math.PI * 2
        const x = cx + R * Math.cos(a), y = cy + R * Math.sin(a)
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.closePath()
      ctx.stroke()
      for (let i = 0; i < 6; i++) {
        const a = rot + (i / 6) * Math.PI * 2
        const x1 = cx + R * Math.cos(a), y1 = cy + R * Math.sin(a)
        const x2 = cx + (R + 1.9) * Math.cos(a), y2 = cy + (R + 1.9) * Math.sin(a)
        ctx.globalAlpha = i === 0 ? 0.95 : 0.6
        ctx.lineWidth = i === 0 ? 1.6 : 0.8
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke()
        ctx.globalAlpha = 0.3
        ctx.lineWidth = 0.6
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(x1, y1); ctx.stroke()
      }
      ctx.globalAlpha = 0.9
      ctx.beginPath(); ctx.arc(cx, cy, 1.1, 0, 7); ctx.fill()
      ctx.globalAlpha = 1
    }
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      draw(0.79) // settled frame, no motion
      return
    }
    const t0 = performance.now()
    let raf = 0, last = 0
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      if (now - last < 31) return
      last = now
      draw((now - t0) / 1000)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [size])
  return <canvas ref={ref} className="text-ink" style={{ width: size, height: size }} aria-hidden />
}

/** registration crop marks — four corner brackets around a block */
export function CropFrame({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  const c = "pointer-events-none absolute h-3.5 w-3.5 border-faint"
  return (
    <div className={`relative p-8 ${className ?? ""}`}>
      <span className={`${c} left-0 top-0 border-l border-t`} />
      <span className={`${c} right-0 top-0 border-r border-t`} />
      <span className={`${c} bottom-0 left-0 border-b border-l`} />
      <span className={`${c} bottom-0 right-0 border-b border-r`} />
      {children}
    </div>
  )
}

export function GradeChip({ grade }: { grade: string | null }) {
  if (!grade) return null
  const style =
    grade === "peer_reviewed"
      ? "bg-oksoft text-ok"
      : grade === "preprint"
        ? "bg-warnsoft text-warn"
        : "bg-paper text-muted"
  return (
    <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] uppercase ${style}`}>
      {grade === "peer_reviewed" ? "peer-reviewed" : grade}
    </span>
  )
}

export interface ToolPartLike {
  type: string
  toolName?: string
  state?: string
  input?: unknown
  output?: unknown
  errorText?: string
}

/** human-readable expansion of a tool result — never raw JSON when we know the shape */
function StepDetail({ tool, part }: { tool: string; part: ToolPartLike }) {
  const out = part.output as Record<string, any> | undefined
  if (part.state === "output-error")
    return <p className="text-[12px] text-bad">{part.errorText ?? "failed"}</p>
  if (!out) return null
  if (out.error) return <p className="text-[12px] text-bad">{out.error}</p>

  const Line = ({ children }: { children: ReactNode }) => (
    <div className="border-b border-linec py-1.5 text-[12.5px] last:border-0">{children}</div>
  )

  switch (tool) {
    case "list_sources":
      return (
        <div>
          <Line>{out.count} file{out.count === 1 ? "" : "s"} in the workspace</Line>
          {(out.files ?? []).slice(0, 10).map((f: any) => (
            <Line key={f.path}>
              <span className="font-mono text-[11.5px]">{f.path}</span>
            </Line>
          ))}
        </div>
      )
    case "search_library":
      return (
        <div>
          {(out.hits ?? []).map((h: any) => (
            <Line key={h.chunkId}>
              <span className="font-mono text-[11px] text-muted">
                {h.sourcePath}
                {h.page ? ` · p.${h.page}` : h.lines ? ` · L${h.lines}` : ""}
              </span>
              <div className="mt-0.5 text-muted">{String(h.text).slice(0, 110)}…</div>
            </Line>
          ))}
          {(out.hits ?? []).length === 0 && <Line>no matches</Line>}
        </div>
      )
    case "search_scholar":
      return (
        <div>
          {(out.results ?? []).map((r: any, i: number) => (
            <Line key={i}>
              <span className="font-medium">{r.title}</span>
              <div className="mt-0.5 font-mono text-[11px] text-muted">
                {[r.year, r.venue, r.citedBy != null ? `${r.citedBy} cites` : null, r.doi]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
            </Line>
          ))}
        </div>
      )
    case "ingest_source":
    case "fetch_paper":
      return (
        <div>
          <Line>
            <span className="font-medium">{out.title ?? out.path}</span>
          </Line>
          <Line>
            {[
              out.pages ? `${out.pages} pages` : null,
              `${out.chunks} passages indexed`,
              out.grade ? `grade: ${out.grade.replace("_", "-")}` : null,
              out.visuals?.cataloged != null ? `${out.visuals.cataloged} figures/tables cataloged` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </Line>
        </div>
      )
    case "read_source":
      return <Line>read {out.path}{out.truncated ? " (truncated)" : ""}</Line>
    case "ask_document":
      return (
        <div className="py-1 [&_.op-md]:text-[12.5px]">
          <Md text={String(out.answer ?? "").slice(0, 1200)} />
        </div>
      )
    case "view_page":
      return (
        <div className="py-1">
          <a href={`/api/file?path=${encodeURIComponent(String(out.file))}`} target="_blank" rel="noreferrer">
            <img
              src={`/api/file?path=${encodeURIComponent(String(out.file))}`}
              alt={`page ${out.page} of ${out.source}`}
              className="max-h-[420px] max-w-full rounded border border-linec"
            />
          </a>
          <Line>
            <span className="text-muted">what the agent saw · saved to </span>
            <span className="font-mono text-[11.5px]">{String(out.file)}</span>
          </Line>
        </div>
      )
    case "export_draft":
      return (
        <div>
          {out.files &&
            Object.entries(out.files as Record<string, string>).map(([k, v]) => (
              <Line key={k}>
                <span className="text-muted">{k}:</span>{" "}
                <span className="font-mono text-[11.5px]">{v}</span>
              </Line>
            ))}
          {(out.warnings ?? []).map((w: string, i: number) => (
            <Line key={i}>
              <span className="text-warn">⚠ {w}</span>
            </Line>
          ))}
        </div>
      )
    case "check_references":
      return (
        <div>
          <Line>
            {out.checked} DOI{out.checked === 1 ? "" : "s"} checked
            {out.note && <span className="text-muted"> · {out.note}</span>}
          </Line>
          {(out.problems ?? []).map((p: string, i: number) => (
            <Line key={i}>
              <span className="text-bad">⚠ {p}</span>
            </Line>
          ))}
        </div>
      )
    case "read_pages":
      return (
        <div>
          <Line>
            read pages {out.pages} of {out.totalPages}
            {out.coverage && <span className="text-warn"> · {out.coverage}</span>}
          </Line>
          <div className="py-1 text-[12px] text-muted">
            {String(out.text ?? "").replace(/\n+/g, " ").slice(0, 260)}…
          </div>
        </div>
      )
    case "save_note": {
      const written = (part.input as { content?: string } | undefined)?.content
      return (
        <div>
          <Line>
            saved to <span className="font-mono text-[11.5px]">{out.file}</span>
          </Line>
          {written && (
            <div className="py-1 [&_.op-md]:text-[12.5px]">
              <Md text={written} />
            </div>
          )}
        </div>
      )
    }
    case "read_note":
      if (out.sources_with_notes)
        return (
          <div>
            {(out.sources_with_notes as string[]).map((s) => (
              <Line key={s}>
                <span className="font-mono text-[11.5px]">{s}</span>
              </Line>
            ))}
            {(out.sources_with_notes as string[]).length === 0 && <Line>no notes yet</Line>}
          </div>
        )
      return out.note ? (
        <div className="py-1 [&_.op-md]:text-[12.5px]">
          <Md text={String(out.note)} />
        </div>
      ) : (
        <Line>no note yet for {out.source_path}</Line>
      )
    case "remember":
      return <Line>{out.status ?? "saved"}</Line>
    case "draft_section":
      return (
        <Line>
          {out.summary
            ? out.verified === false
              ? `plain document → ${out.file}`
              : `${out.summary.supported} supported · ${out.summary.partial} partial · ${out.summary.unsupported} unsupported → ${out.file}`
            : out.file}
        </Line>
      )
    case "synthesize": {
      const short = (p: string) => String(p ?? "").split("/").pop()
      return (
        <div>
          {out.error && <Line><span className="text-bad">{out.error}</span></Line>}
          {(out.tensions ?? []).length > 0 && (
            <div className="steplabel py-1 font-bold text-warn">tensions</div>
          )}
          {(out.tensions ?? []).map((t: any, i: number) => (
            <Line key={i}>
              <span className="font-medium">{t.question}</span>
              {(t.positions ?? []).map((p: any, j: number) => (
                <div key={j} className="mt-0.5 text-muted">
                  <span className="font-mono text-[10.5px]">{short(p.source)}</span>: {p.stance}
                </div>
              ))}
            </Line>
          ))}
          {(out.agreements ?? []).length > 0 && (
            <div className="steplabel py-1 font-bold text-ok">agreements</div>
          )}
          {(out.agreements ?? []).map((a: any, i: number) => (
            <Line key={i}>{a.point}</Line>
          ))}
          {(out.gaps ?? []).length > 0 && <div className="steplabel py-1 font-bold">open gaps</div>}
          {(out.gaps ?? []).map((g: any, i: number) => (
            // gaps are structured since the counter-search gate: statement +
            // the researchable question + search-bounded/hunch status.
            // (Plain strings from older transcripts still render.)
            <Line key={i}>
              {typeof g === "string" ? (
                g
              ) : (
                <>
                  <span className="font-medium">{g.statement}</span>
                  {g.status === "unverified-hunch" && (
                    <span className="ml-1.5 font-mono text-[10px] uppercase text-warn">hunch — not yet counter-searched</span>
                  )}
                  {g.open_question && <div className="mt-0.5 text-muted">→ {g.open_question}</div>}
                  {(g.counter_searches ?? []).length > 0 && (
                    <div className="mt-0.5 font-mono text-[10.5px] text-muted">
                      bounded by {g.counter_searches.length} counter-search{g.counter_searches.length > 1 ? "es" : ""} · {g.boundary}
                    </div>
                  )}
                </>
              )}
            </Line>
          ))}
          {out.sourcesCovered && (
            <Line>
              <span className="text-muted">across {out.sourcesCovered.length} sources</span>
            </Line>
          )}
        </div>
      )
    }
    case "map_source":
      return (
        <div>
          <Line>
            mapped <b>{out.nodes}</b> concepts · <b>{out.edges}</b> relations from{" "}
            <span className="font-mono text-[11.5px]">{String(out.source ?? "").split("/").pop()}</span>
          </Line>
          {(out.sample ?? []).map((s: any, i: number) => (
            <Line key={i}>
              <span className="font-mono text-[11px] text-muted">
                {s.subject} → {s.relation} → {s.object}
              </span>
            </Line>
          ))}
          {out.graph && (
            <Line>
              <span className="text-muted">
                map now: {out.graph.nodes} concepts · {out.graph.edges} links · {out.graph.sources} papers
              </span>
            </Line>
          )}
        </div>
      )
    case "related":
      if (out.hint && !out.connections && !out.shared && !out.central)
        return <Line>{out.hint}</Line>
      return (
        <div>
          {(out.connections ?? []).map((c: any, i: number) => (
            <Line key={i}>
              <span className="font-mono text-[11.5px]">
                {c.relation} → {c.other}
              </span>{" "}
              <span className="text-[11px] text-muted">({String(c.source ?? "").split("/").pop()})</span>
            </Line>
          ))}
          {(out.shared ?? []).map((s: any, i: number) => (
            <Line key={i}>
              <span className="font-medium">{s.label}</span>{" "}
              <span className="text-[11px] text-muted">· in {s.sources?.length ?? 0} papers</span>
            </Line>
          ))}
          {(out.central ?? []).map((c: any, i: number) => (
            <Line key={i}>
              {c.label} <span className="text-[11px] text-muted">· {c.degree} links</span>
            </Line>
          ))}
        </div>
      )
    case "delegate":
      return (
        <div>
          {(out.subagents ?? []).map((s: any, i: number) => (
            <Line key={i}>
              <span className="font-medium">{s.label}</span>{" "}
              <span className="font-mono text-[10px] uppercase text-muted">{s.status}</span>
              {s.summary && <div className="mt-0.5 text-muted">{s.summary}</div>}
            </Line>
          ))}
        </div>
      )
    case "update_plan":
      return <Line>{out.note ?? `${out.done ?? 0}/${out.items ?? 0} done`}</Line>
    case "edit_source": {
      const change = out.change as { removed?: string; added?: string } | undefined
      return (
        <div>
          <Line>
            edited <span className="font-mono text-[11.5px]">{out.path}</span>
            {out.reindexed ? <span className="text-muted"> · re-indexed</span> : null}
          </Line>
          {change?.removed && (
            <Line>
              <span className="font-mono text-[11px] text-bad">− </span>
              <span className="text-muted">{change.removed}</span>
            </Line>
          )}
          {change?.added && (
            <Line>
              <span className="font-mono text-[11px] text-ok">+ </span>
              {change.added}
            </Line>
          )}
          {out.note && (
            <Line>
              <span className="text-warn">⚠ {out.note}</span>
            </Line>
          )}
        </div>
      )
    }
    case "use_skill":
      return (
        <div>
          <Line>
            <span className="font-medium">{out.name}</span>
            {out.description && <span className="text-muted"> — {out.description}</span>}
          </Line>
          <Line>
            <span className="text-muted">
              instructions loaded · {String(out.instructions ?? "").length} chars
            </span>
          </Line>
        </div>
      )
    case "create_skill":
      return (
        <Line>
          skill <span className="font-medium">{out.name}</span>
          <span className="text-muted"> · {out.status}</span>
        </Line>
      )
    case "search_sessions":
      return (
        <div>
          {(out.hits ?? []).map((h: any, i: number) => (
            <Line key={i}>
              <span className="font-medium">{h.title ?? String(h.session ?? "").slice(0, 8)}</span>
              <span className="ml-1.5 font-mono text-[10.5px] text-muted">
                {h.when} · {h.role}
              </span>
              <div className="mt-0.5 text-muted">{String(h.snippet ?? "").slice(0, 180)}…</div>
            </Line>
          ))}
          {(out.hits ?? []).length === 0 && <Line>{out.note ?? "no matches in other conversations"}</Line>}
        </div>
      )
    default: {
      // no dedicated view: a readable field list — never raw JSON at the user
      const human = (v: unknown): string =>
        v == null
          ? "—"
          : typeof v === "object"
            ? Array.isArray(v)
              ? `${v.length} item${v.length === 1 ? "" : "s"}`
              : Object.keys(v as object).slice(0, 6).join(", ") || "—"
            : String(v)
      return (
        <div>
          {Object.entries(out)
            .slice(0, 10)
            .map(([k, v]) => (
              <Line key={k}>
                <span className="text-muted">{k.replaceAll("_", " ")}: </span>
                <span className="[overflow-wrap:anywhere]">{human(v).slice(0, 220)}</span>
              </Line>
            ))}
        </div>
      )
    }
  }
}

/** the one input fact that distinguishes this call from its neighbors —
 *  a dozen "fetching paper" rows are useless without WHICH paper */
function stepSubject(tool: string, input: unknown): string | null {
  const i = (input ?? {}) as Record<string, unknown>
  const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null)
  const base = (p: string | null) => (p ? (p.split("/").pop() ?? p) : null)
  switch (tool) {
    case "fetch_paper":
      return base(s(i["filename"])) ?? s(i["doi"])
    case "read_pages": {
      const p = base(s(i["path"]))
      if (!p) return null
      const a = i["from_page"], b = i["to_page"]
      return typeof a === "number" && typeof b === "number" ? `${p} · p.${a}–${b}` : p
    }
    case "view_page": {
      const p = base(s(i["path"]))
      if (!p) return null
      const pg = i["page"]
      return typeof pg === "number" ? `${p} · p.${pg}` : p
    }
    case "ingest_source":
    case "read_source":
    case "ask_document":
    case "edit_source":
    case "map_source":
      return base(s(i["path"]))
    case "save_note":
    case "read_note":
      return base(s(i["source_path"]))
    case "search_scholar":
    case "search_library":
    case "search_sessions":
      return s(i["query"])
    case "use_skill":
    case "create_skill":
      return s(i["name"])
    default:
      return null
  }
}

/** One agent step in the run timeline — ink icon tile, mono label, readable detail. */
export function StepRow({ part, last }: { part: ToolPartLike; last: boolean }) {
  const tool = part.toolName ?? part.type.replace(/^tool-/, "")
  const state = part.state ?? ""
  const running = state === "input-streaming" || state === "input-available"
  const failed = state === "output-error"
  const subject = stepSubject(tool, part.input)
  const [open, setOpen] = useState(false)
  const hasDetail = part.output !== undefined || failed

  return (
    <div className="relative pl-6">
      {!last && <span className="absolute left-[4px] top-5 bottom-0 w-px bg-linec" />}
      <span
        className={
          "absolute left-[-2px] top-[3px] " +
          (failed ? "text-bad" : running ? "op-pulse text-ink" : "text-ink")
        }
      >
        <Icon name={STEP_ICONS[tool] ?? ""} />
      </span>
      <button
        onClick={() => hasDetail && setOpen((o) => !o)}
        className="steplabel flex items-center gap-1.5 py-0.5 hover:text-ink"
      >
        <span className={running ? "op-shimmer" : undefined}>
          {STEP_NAMES[tool] ?? tool.replaceAll("_", " ")}
        </span>
        {subject && (
          <span className="max-w-[320px] truncate normal-case tracking-normal text-faint">
            {subject}
          </span>
        )}
        {hasDetail && <span className="text-[9px]">{open ? "⌃" : "⌄"}</span>}
        {failed && <span className="normal-case tracking-normal text-bad">failed</span>}
      </button>
      {open && hasDetail && (
        <div className="mb-2 mt-1 max-h-64 overflow-y-auto border border-linec bg-surface px-3 py-1">
          <StepDetail tool={tool} part={part} />
        </div>
      )}
    </div>
  )
}

interface DraftCellOut {
  text: string
  cites: string[]
  verdict: string
  quotes: string[]
}
interface DraftTableOut {
  heading: string | null
  caption: string | null
  columns: string[]
  rows: DraftCellOut[][]
}
export interface DraftOutput {
  file: string
  version?: number
  sentences: {
    text: string
    cites: string[]
    verdict: string
    quotes: string[]
    heading?: string | null
    revised?: boolean
  }[]
  tables?: DraftTableOut[]
  summary: { supported: number; partial: number; unsupported: number; uncited: number }
  /** false = plain composition — render a clean document, no verification chrome */
  verified?: boolean
}

export interface SourceRequest {
  cites: string[]
  quotes: string[]
}

const VERDICT_STYLE: Record<string, string> = {
  supported: "bg-oksoft decoration-ok/60",
  partial: "bg-warnsoft decoration-warn/60",
  unsupported: "bg-badsoft decoration-bad/60",
  uncited: "decoration-linec",
}

export function DraftView({
  out,
  onShowSource,
}: {
  out: DraftOutput
  onShowSource: (r: SourceRequest) => void
}) {
  const [exportInfo, setExportInfo] = useState<Record<string, any> | null>(null)
  const [exporting, setExporting] = useState(false)
  const dataFile = (out as { dataFile?: string }).dataFile
  const plainDoc = out.verified === false

  async function doExport() {
    if (!dataFile || exporting) return
    setExporting(true)
    try {
      const r = await fetch("/api/export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dataFile }),
      })
      try {
        setExportInfo(await r.json())
      } catch {
        // non-JSON answer = the running server predates this button
        setExportInfo({
          error: `the server answered ${r.status} without JSON — it is likely running an older build; restart the app and try again`,
        })
      }
    } catch {
      setExportInfo({ error: "network error — the app server is not reachable" })
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="my-3 ml-6 flex max-h-[65vh] min-w-0 max-w-full flex-col border border-linec bg-surface [overflow-wrap:anywhere]">
      <div className="flex flex-none flex-wrap items-center gap-2 border-b border-linec px-5 py-2.5 font-mono text-[11px] text-muted">
        <span className="font-bold uppercase tracking-wider">{plainDoc ? "draft" : "verified draft"}</span>
        {out.version && <span className="border border-linec px-1 text-[10px] text-ink">v{out.version}</span>}
        {!plainDoc && (
          <>
            <span className="text-ok">{out.summary.supported} supported</span>
            {out.summary.partial > 0 && <span className="text-warn">{out.summary.partial} partial</span>}
            {out.summary.unsupported > 0 && (
              <span className="text-bad">{out.summary.unsupported} unsupported</span>
            )}
            {out.summary.uncited > 0 && <span>{out.summary.uncited} uncited</span>}
          </>
        )}
        <span className="ml-auto">{out.file}</span>
        {dataFile && !plainDoc && (
          <button
            onClick={() => void doExport()}
            disabled={exporting}
            className="border border-linec bg-paper px-2.5 py-0.5 text-[11px] text-ink hover:border-accent disabled:opacity-40"
          >
            {exporting ? "exporting…" : "Export"}
          </button>
        )}
      </div>
      <div className="min-h-0 overflow-y-auto px-6 py-5 leading-[1.75]">
        {(() => {
          const norm = (h: string | null | undefined) =>
            (h ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
          const tablesByHeading = new Map<string, DraftTableOut[]>()
          for (const t of out.tables ?? []) {
            const k = norm(t.heading)
            const l = tablesByHeading.get(k) ?? []
            l.push(t)
            tablesByHeading.set(k, l)
          }
          const sections: { heading: string | null; sentences: typeof out.sentences }[] = []
          out.sentences.forEach((s) => {
            if (s.heading || sections.length === 0)
              sections.push({ heading: s.heading ?? null, sentences: [] })
            sections[sections.length - 1]!.sentences.push(s)
          })
          const renderSentence = (s: (typeof out.sentences)[number], i: number) => {
            if ((s as { block?: string }).block === "h3") {
              return (
                <span key={i} className="mb-1 mt-3 block font-serif text-[14.5px] font-semibold">
                  {s.text}
                </span>
              )
            }
            const looksLikeMarkup =
              /<\/?(table|thead|tbody|tr|td|th|div|span|p|br|hr|ul|ol|li|sub|sup|b|i|em|strong|code|pre|h[1-6])\b[^>]*>/i.test(s.text)
            return (
              <span
                key={i}
                onClick={() => !looksLikeMarkup && s.cites.length && onShowSource({ cites: s.cites, quotes: s.quotes })}
                title={
                  looksLikeMarkup
                    ? "raw markup in this draft — redraft it"
                    : plainDoc || s.quotes?.[0]
                      ? undefined // plain docs carry no verdicts; hover card carries evidence otherwise
                      : s.verdict + (s.revised ? " · revised" : "") + (s.cites.length ? " · click to view source" : "")
                }
                className={
                  looksLikeMarkup
                    ? "bg-badsoft font-mono text-[12px] text-bad"
                    : plainDoc
                      ? ""
                      : `group/sent relative underline decoration-2 underline-offset-4 ${s.cites.length ? "cursor-pointer" : ""} ${VERDICT_STYLE[s.verdict] ?? ""}`
                }
              >
                {inlineEmphasis(s.text.replace(/[\u00A0\u2000-\u200B\u202F\u2007]/g, " "))}{" "}
                {!looksLikeMarkup && s.quotes?.[0] && (
                  <span className="invisible absolute left-0 top-full z-20 mt-1 block w-[26rem] max-w-[70vw] border border-linec bg-surface px-3.5 py-2.5 text-left no-underline shadow-sm group-hover/sent:visible">
                    <span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-muted">
                      {s.verdict}
                      {s.revised ? " \u00B7 revised" : ""}
                    </span>
                    <span className="block font-serif text-[12.5px] italic leading-[1.55] text-ink">
                      \u201C{s.quotes[0].length > 300 ? `${s.quotes[0].slice(0, 300)}\u2026` : s.quotes[0]}\u201D
                    </span>
                    <span className="mt-1 block font-mono text-[10px] not-italic text-muted">
                      verbatim from the source \u00B7 click to open the passage
                    </span>
                  </span>
                )}
              </span>
            )
          }
          const renderTable = (t: DraftTableOut, ti: number) => (
            <div key={`t${ti}`} className="my-3 overflow-x-auto">
              {t.caption && <div className="mb-1 text-[12px] italic text-muted">{t.caption}</div>}
              <table className="w-full border-collapse text-[13px]">
                <thead>
                  <tr>
                    {t.columns.map((c, ci) => (
                      <th key={ci} className="border border-linec bg-paper px-2 py-1 text-left font-semibold">
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {t.rows.map((row, ri) => (
                    <tr key={ri}>
                      {t.columns.map((_, ci) => {
                        const cell = row[ci]
                        const clickable = cell && cell.cites.length > 0
                        return (
                          <td
                            key={ci}
                            onClick={() => clickable && onShowSource({ cites: cell!.cites, quotes: cell!.quotes })}
                            title={plainDoc || !cell ? "" : cell.verdict + (clickable ? " · click to view source" : "")}
                            className={`border border-linec px-2 py-1 align-top ${clickable ? "cursor-pointer" : ""} ${cell && cell.cites.length ? VERDICT_STYLE[cell.verdict] ?? "" : ""}`}
                          >
                            {cell ? inlineEmphasis(cell.text) : ""}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
          // group each section's sentences by BLOCK structure so the view
          // shows what the document actually is: paragraphs (newPara breaks),
          // lists, and sub-headings — not one fused <p> per section
          type Sent = (typeof out.sentences)[number] & {
            block?: string
            ordered?: boolean
            newPara?: boolean
          }
          const groupBlocks = (ss: Sent[]) => {
            const groups: { type: "p" | "ul" | "ol" | "h3"; items: Sent[] }[] = []
            for (const s of ss) {
              const b = s.block ?? "p"
              const last = groups[groups.length - 1]
              if (b === "h3") groups.push({ type: "h3", items: [s] })
              else if (b === "li") {
                const t = s.ordered ? ("ol" as const) : ("ul" as const)
                if (last?.type === t) last.items.push(s)
                else groups.push({ type: t, items: [s] })
              } else if (last?.type === "p" && !s.newPara) last.items.push(s)
              else groups.push({ type: "p", items: [s] })
            }
            return groups
          }
          return sections.map((sec, si) => (
            <div key={si}>
              {sec.heading && (
                <span className={`block font-serif text-[17px] font-semibold ${si > 0 ? "mt-5" : ""} mb-1.5`}>
                  {sec.heading}
                </span>
              )}
              {groupBlocks(sec.sentences as Sent[]).map((g, gi) =>
                g.type === "h3" ? (
                  <span key={gi} className="mb-1 mt-3 block font-serif text-[14.5px] font-semibold">
                    {g.items[0]!.text}
                  </span>
                ) : g.type === "ul" || g.type === "ol" ? (
                  <ul key={gi} className={`my-1.5 pl-5 ${g.type === "ol" ? "list-decimal" : "list-disc"}`}>
                    {g.items.map((s, ii) => (
                      <li key={ii} className="my-0.5">
                        {renderSentence(s, ii)}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p key={gi} className="my-1.5 whitespace-normal">
                    {g.items.map(renderSentence)}
                  </p>
                ),
              )}
              {(tablesByHeading.get(norm(sec.heading)) ?? []).map(renderTable)}
            </div>
          ))
        })()}
      </div>
      {exportInfo && (
        <div className="flex-none border-t border-linec px-5 py-2.5 text-[12px]">
          <div className="flex items-center">
            <span className="steplabel font-bold">export</span>
            <button onClick={() => setExportInfo(null)} className="ml-auto px-2 text-muted hover:text-ink">✕</button>
          </div>
          {exportInfo.error ? (
            <p className="mt-1 text-bad">{exportInfo.error}</p>
          ) : (
            <div className="mt-1 grid gap-0.5">
              {Object.entries((exportInfo.files ?? {}) as Record<string, string>).map(([k, v]) => (
                <div key={k}>
                  <span className="text-muted">{k}:</span>{" "}
                  <span className="font-mono text-[11.5px]">{v}</span>
                </div>
              ))}
              {(exportInfo.warnings ?? []).map((w: string, i: number) => (
                <div key={i} className="text-warn">⚠ {w}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** minimal inline markdown for verified-draft sentences — **bold** and
 *  *italic* only (HTML is gated out upstream); raw asterisks were showing */
function inlineEmphasis(text: string): ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*\s][^*]*\*)/g)
  if (parts.length === 1) return text
  return parts.map((p, i) =>
    p.startsWith("**") && p.endsWith("**") && p.length > 4 ? (
      <strong key={i}>{p.slice(2, -2)}</strong>
    ) : p.startsWith("*") && p.endsWith("*") && p.length > 2 ? (
      <em key={i}>{p.slice(1, -1)}</em>
    ) : (
      p
    ),
  )
}

/** the agent's working plan, rendered inline where it updated it */
export function PlanView({ todos }: { todos: { content: string; status: string }[] }) {
  if (!todos?.length) {
    return (
      <div className="my-1.5 ml-6 flex items-center gap-2 border border-linec bg-surface px-4 py-2">
        <Icon name="check" className="text-ok" />
        <span className="steplabel">plan complete</span>
      </div>
    )
  }
  const done = todos.filter((t) => t.status === "done").length
  return (
    <div className="my-1.5 ml-6 max-w-full border border-linec bg-surface">
      <div className="flex items-center gap-2 border-b border-linec px-4 py-2">
        <span className="steplabel font-bold">plan</span>
        <span className="ml-auto font-mono text-[10px] text-muted">
          {done}/{todos.length}
        </span>
      </div>
      <div className="px-4 py-2.5">
        {todos.map((t, i) => (
          <div key={i} className="flex items-start gap-2.5 py-[3px] text-[13px] leading-snug">
            <span
              className={
                "mt-[3px] inline-block h-[11px] w-[11px] flex-none border " +
                (t.status === "done"
                  ? "border-ink bg-ink"
                  : t.status === "in_progress"
                    ? "border-accent bg-accentsoft"
                    : "border-linec bg-paper")
              }
            />
            <span className={t.status === "done" ? "text-muted line-through decoration-1" : ""}>
              {t.content}
            </span>
            {t.status === "in_progress" && (
              <span className="steplabel ml-auto flex-none !text-[9px] text-accent">now</span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

/** the parallel sub-agents a delegate call spawned, with each one's report */
export function SubagentsView({ subagents }: { subagents: SubagentReport[] }) {
  if (!subagents?.length) return null
  return (
    <div className="my-1.5 ml-6 max-w-full border border-linec bg-surface">
      <div className="flex items-center gap-2 border-b border-linec px-4 py-2">
        <Icon name="diamond" />
        <span className="steplabel font-bold">
          {subagents.length} sub-agent{subagents.length > 1 ? "s" : ""} · parallel
        </span>
      </div>
      <div className="divide-y divide-linec">
        {subagents.map((s, i) => (
          <div key={i} className="px-4 py-2.5">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[12px] font-semibold">{s.label || s.task?.slice(0, 40)}</span>
              <span
                className={
                  "font-mono text-[9.5px] uppercase " + (s.status === "done" ? "text-ok" : "text-bad")
                }
              >
                {s.status}
              </span>
              {s.toolCalls?.length ? (
                <span className="ml-auto font-mono text-[10px] text-faint">
                  {s.toolCalls.length} steps
                </span>
              ) : null}
            </div>
            {s.summary && <p className="mt-1 text-[13px] text-muted">{s.summary}</p>}
            {s.findings?.length ? (
              <ul className="mt-1.5 list-disc pl-4 text-[12.5px]">
                {s.findings.slice(0, 5).map((f, j) => (
                  <li key={j} className="my-0.5">
                    {f}
                  </li>
                ))}
              </ul>
            ) : null}
            {s.artifacts?.length ? (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {s.artifacts.map((a, j) => (
                  <span key={j} className="border border-linec bg-paper px-1.5 py-0.5 font-mono text-[10px]">
                    {a}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  )
}

export interface SubagentReport {
  label: string
  task: string
  status: string
  summary: string
  findings: string[]
  sources: string[]
  artifacts: string[]
  forLead: string
  toolCalls: string[]
}

interface ChunkInfo {
  id: string
  text: string
  page: number | null
  line_start: number | null
  line_end: number | null
  path: string
  title: string | null
  grade: string
  kind: string
}

function highlight(text: string, quotes: string[]): { t: string; hit: boolean }[] {
  let segs: { t: string; hit: boolean }[] = [{ t: text, hit: false }]
  for (const q of quotes) {
    if (q.length < 10) continue
    const pattern = q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")
    let re: RegExp
    try {
      re = new RegExp(pattern, "i")
    } catch {
      continue
    }
    segs = segs.flatMap((s) => {
      if (s.hit) return [s]
      const m = re.exec(s.t)
      if (!m) return [s]
      return [
        { t: s.t.slice(0, m.index), hit: false },
        { t: m[0], hit: true },
        { t: s.t.slice(m.index + m[0].length), hit: false },
      ].filter((x) => x.t.length > 0)
    })
  }
  return segs
}

/** file preview in the SAME right-hand slot as the citation SourcePane —
 *  PDFs/HTML in an iframe, markdown rendered, images inline, text as-is */
export function FilePane({ path, onClose }: { path: string; onClose: () => void }) {
  const lower = path.toLowerCase()
  const isPdf = lower.endsWith(".pdf")
  const isHtml = lower.endsWith(".html") || lower.endsWith(".htm")
  const isImg = /\.(png|jpe?g)$/.test(lower)
  const isMd = lower.endsWith(".md") || lower.endsWith(".markdown")
  const [text, setText] = useState<string | null>(null)
  const [err, setErr] = useState(false)
  useEffect(() => {
    setText(null)
    setErr(false)
    if (isPdf || isHtml || isImg) return
    fetch(`/api/file?path=${encodeURIComponent(path)}`)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then(setText)
      .catch(() => setErr(true))
  }, [path, isPdf, isHtml, isImg])
  const src = `/api/file?path=${encodeURIComponent(path)}`
  return (
    <aside className="flex w-[26rem] flex-none flex-col border-l border-linec bg-surface">
      <div className="flex items-center gap-2 border-b border-linec px-4 py-3">
        <span className="steplabel flex-none font-bold">preview</span>
        <span className="min-w-0 truncate font-mono text-[10.5px] text-muted" title={path}>
          {path}
        </span>
        <a href={`${src}&download=1`} title="download" className="ml-auto flex-none px-1 text-muted hover:text-ink">
          ↓
        </a>
        <button onClick={onClose} className="flex-none rounded px-2 text-muted hover:bg-paper">
          ✕
        </button>
      </div>
      {isPdf || isHtml ? (
        <iframe title={path} src={src} className="min-h-0 flex-1 bg-paper" />
      ) : isImg ? (
        <div className="min-h-0 flex-1 overflow-auto p-3">
          <img src={src} alt={path} className="max-w-full border border-linec" />
        </div>
      ) : err ? (
        <p className="p-4 text-sm text-muted">could not load this file</p>
      ) : text == null ? (
        <p className="p-4 text-sm text-muted">loading…</p>
      ) : isMd ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-[13.5px] leading-relaxed">
          <Md text={text} />
        </div>
      ) : (
        <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap px-4 py-3 font-mono text-[11.5px] leading-relaxed">
          {text}
        </pre>
      )}
    </aside>
  )
}

export function SourcePane({ req, onClose }: { req: SourceRequest; onClose: () => void }) {
  const [active, setActive] = useState(0)
  const [chunk, setChunk] = useState<ChunkInfo | null>(null)
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    setChunk(null)
    setMissing(false)
    const id = req.cites[active]
    if (!id) return
    fetch(`/api/chunks/${encodeURIComponent(id)}`)
      .then((r) => r.json())
      .then((d) => (d.error ? setMissing(true) : setChunk(d)))
      .catch(() => setMissing(true))
  }, [req, active])

  return (
    <aside className="flex w-[26rem] flex-none flex-col border-l border-linec bg-surface">
      <div className="flex items-center gap-2 border-b border-linec px-4 py-3">
        <span className="steplabel font-bold">source</span>
        {req.cites.length > 1 && (
          <span className="flex gap-1">
            {req.cites.map((_, i) => (
              <button
                key={i}
                onClick={() => setActive(i)}
                className={"srctab" + (i === active ? " on" : "")}
              >
                {i + 1}
              </button>
            ))}
          </span>
        )}
        <button onClick={onClose} className="ml-auto rounded px-2 text-muted hover:bg-paper">
          ✕
        </button>
      </div>
      {missing ? (
        <p className="p-4 text-sm text-muted">
          This passage is no longer in the library — its source file was edited or removed
          since the draft was written. Re-draft (or revise) to re-ground this sentence in
          the current text.
        </p>
      ) : !chunk ? (
        <p className="p-4 text-sm text-muted">loading…</p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="border-b border-linec px-4 py-2 text-[12.5px]">
            <div className="truncate font-medium" title={chunk.path}>
              {chunk.title ?? chunk.path}
            </div>
            <div className="mt-0.5 flex items-center gap-2 text-muted">
              <GradeChip grade={chunk.grade} />
              {chunk.page && <span className="font-mono text-[10px]">p.{chunk.page}</span>}
              {!chunk.page && chunk.line_start && (
                <span className="font-mono text-[10px]">L{chunk.line_start}-{chunk.line_end ?? chunk.line_start}</span>
              )}
              <span className="truncate font-mono text-[10px]">{chunk.path}</span>
            </div>
          </div>
          <div className="max-h-56 overflow-y-auto border-b border-linec px-4 py-3 text-[13px] leading-relaxed">
            {highlight(chunk.text, req.quotes).map((s, i) =>
              s.hit ? (
                <mark key={i} className="rounded bg-oksoft px-0.5 text-ink">
                  {s.t}
                </mark>
              ) : (
                <span key={i}>{s.t}</span>
              ),
            )}
          </div>
          {chunk.kind === "pdf" && (
            <iframe
              title="source pdf"
              src={`/api/file?path=${encodeURIComponent(chunk.path)}#page=${chunk.page ?? 1}`}
              className="min-h-0 flex-1"
            />
          )}
        </div>
      )}
    </aside>
  )
}

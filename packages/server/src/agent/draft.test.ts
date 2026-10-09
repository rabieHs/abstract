import { describe, expect, test } from "bun:test"
import { mapRevision, normalizeHeading, hasDraftMarkup } from "./draft.ts"
import type { DraftSentence } from "./draft.ts"

const S = (text: string, heading: string | null = null, cites: string[] = []): DraftSentence => ({
  text, heading, cites, verdict: "supported", quotes: [], invalidCites: [],
})

// a previous draft: unheaded lead + two headed sections
const prev: DraftSentence[] = [
  S("Intro one.", null),
  S("Intro two.", null),
  S("Methods a.", "Methods", ["c1"]),
  S("Methods b.", null, ["c2"]),
  S("Results a.", "Results", ["c3"]),
]

describe("normalizeHeading", () => {
  test("case- and punctuation-insensitive", () => {
    expect(normalizeHeading("Related Work")).toBe(normalizeHeading("related work"))
    expect(normalizeHeading("3.1 From FLOPs — to watts!")).toBe("3 1 from flops to watts")
    expect(normalizeHeading(null)).toBe("")
  })
})

describe("mapRevision", () => {
  test("first draft (no previous) inherits nothing, drops nothing", () => {
    const r = mapRevision(undefined, ["A", "B"])
    expect(r.inherited).toEqual([undefined, undefined])
    expect(r.dropped).toEqual([])
  })

  test("heading case/format drift still inherits the section (finding #1)", () => {
    const r = mapRevision(prev, ["Methods", "results"]) // 'results' lowercased
    expect(r.inherited[0]).toHaveLength(2) // Methods section
    expect(r.inherited[1]).toBeDefined()
    expect(r.inherited[1]![0]!.text).toBe("Results a.")
    // Methods+Results kept; only the unheaded lead is not a "section"
    expect(r.dropped).toEqual([])
  })

  test("single-section plan inherits the WHOLE previous draft, not just the lead (finding #2)", () => {
    const r = mapRevision(prev, [null]) // consolidate to one flowing section
    expect(r.inherited).toHaveLength(1)
    expect(r.inherited[0]).toHaveLength(5) // all 5 sentences, incl. Methods+Results
    expect(r.dropped).toEqual([]) // null-heading consolidation drops nothing
  })

  test("duplicate/again-null plan sections never inherit the same run twice (finding #3)", () => {
    const r = mapRevision(prev, ["Methods", "Methods"])
    expect(r.inherited[0]).toHaveLength(2) // first consumes Methods
    expect(r.inherited[1]).toBeUndefined() // second gets nothing, no duplication
  })

  test("a genuinely removed section is reported as dropped", () => {
    const r = mapRevision(prev, ["Methods"]) // Results intentionally gone (multi-section? no, single)
    // single-section plan with a heading: whole draft inherited, Results flagged dropped
    expect(r.dropped).toContain("Results")
  })

  test("multi-section re-plan that keeps all headings drops nothing", () => {
    const r = mapRevision(prev, ["Methods", "Results", "Discussion"])
    expect(r.dropped).toEqual([])
    expect(r.inherited[2]).toBeUndefined() // new Discussion section, no previous
  })

  test("multi-section re-plan that omits a heading reports it dropped", () => {
    const r = mapRevision(prev, ["Methods", "Conclusion"]) // Results omitted
    expect(r.dropped).toEqual(["Results"])
  })
})

describe("hasDraftMarkup unchanged", () => {
  test("flags tables/HTML, not math prose", () => {
    expect(hasDraftMarkup("| a | b |")).toBe(true)
    expect(hasDraftMarkup("<table><tr>")).toBe(true)
    expect(hasDraftMarkup("for k<n we have p<0.05 and ||w|| small")).toBe(false)
  })
})

import { cleanSentenceText, orderSourcesByFirstCite, renderDraftBody } from "./draft.ts"

describe("cleanSentenceText (raw chunk-id leak scrub — the testt bug)", () => {
  test("strips leaked [hash:page:offset] markers from prose", () => {
    expect(
      cleanSentenceText("decision-support systems [b06ce6560f68fc3c:1:1992, b06ce6560f68fc3c:1:3819] are used."),
    ).toBe("decision-support systems are used.")
  })
  test("never touches legitimate bracketed content", () => {
    expect(cleanSentenceText("results in [1] and [Smith, 2024] hold")).toBe("results in [1] and [Smith, 2024] hold")
  })
})

describe("renderDraftBody — ONE renderer for draft and export (WR2)", () => {
  const chunkPath = new Map([["c1", "sources/a.pdf"], ["c2", "sources/b.pdf"]])
  const sentences = [
    { text: "Energy is measured at the wall.", cites: ["c1"], heading: "Measurement" },
    { text: "A connective sentence.", cites: [], heading: null },
    { text: "Two works disagree.", cites: ["c1", "c2"], heading: null },
  ]
  const order = orderSourcesByFirstCite(sentences, chunkPath)
  const refNum = new Map(order.map((p, i) => [p, i + 1]))
  const nums = (cites: string[]) =>
    [...new Set(cites.map((c) => refNum.get(chunkPath.get(c) ?? "")).filter((n): n is number => n != null))]

  test("cited sentences carry visible [n] markers; uncited carry none", () => {
    const body = renderDraftBody(sentences, [], nums)
    expect(body).toContain("Energy is measured at the wall. [1]")
    expect(body).toContain("A connective sentence.")
    expect(body).not.toContain("A connective sentence. [")
    expect(body).toContain("Two works disagree. [1, 2]")
    expect(body).toContain("## Measurement")
  })
  test("table cells carry markers exactly like prose", () => {
    const tables = [{
      heading: "Measurement", caption: "Tools", columns: ["Tool", "Scope"],
      rows: [[{ text: "MLPerf", cites: [] }, { text: "wall energy", cites: ["c1"] }]],
    }]
    const body = renderDraftBody(sentences, tables, nums)
    expect(body).toContain("| Tool | Scope |")
    expect(body).toContain("wall energy [1]")
  })
  test("sources are numbered by first citation order", () => {
    expect(order).toEqual(["sources/a.pdf", "sources/b.pdf"])
  })
  test("no raw chunk ids ever appear in the rendered body", () => {
    const body = renderDraftBody(sentences, [], nums)
    expect(/\[[0-9a-f]{12,16}:\d+:\d+/.test(body)).toBe(false)
    expect(body).not.toContain("c1")
  })
})

import { narrationLintRuns } from "./draft.ts"

describe("narration linter (S4 — the annotated-bibliography detector)", () => {
  const s = (text: string) => ({ text })
  test("flags back-to-back integral-citation openings", () => {
    const runs = narrationLintRuns([
      s("Smith et al. propose a pruning method for edge devices."),
      s("Jones and Lee show that quantization dominates on NPUs."),
      s("These approaches share a focus on static sparsity."),
      s("Chen (2024) presents a dynamic alternative."),
      s("Wang et al. report similar gains on vision models."),
    ])
    expect(runs).toBe(2)
  })
  test("synthesis-shaped prose passes clean", () => {
    const runs = narrationLintRuns([
      s("Two families of approaches dominate the efficiency literature."),
      s("Whereas pruning methods target static sparsity, quantization exploits precision headroom."),
      s("The evidence for combining both remains thin across the reviewed corpus."),
    ])
    expect(runs).toBe(0)
  })
})

import { stripHeadingEcho } from "./draft.ts"

describe("stripHeadingEcho (writer echoes the heading into sentence 1)", () => {
  test("strips the observed live duplication", () => {
    expect(
      stripHeadingEcho("Scope and framing This section offers a focused comparison of four works.", "Scope and framing"),
    ).toBe("This section offers a focused comparison of four works.")
  })
  test("strips heading followed by punctuation", () => {
    expect(stripHeadingEcho("Measurement: the field measures energy at the wall.", "Measurement")).toBe(
      "The field measures energy at the wall.",
    )
  })
  test("leaves text alone when the heading is not echoed", () => {
    expect(stripHeadingEcho("The field measures energy at the wall.", "Measurement")).toBe(
      "The field measures energy at the wall.",
    )
  })
  test("never hollows out text that IS essentially the heading", () => {
    expect(stripHeadingEcho("Scope and framing.", "Scope and framing")).toBe("Scope and framing.")
  })
})

import { parseLenientPlan } from "./draft.ts"

describe("lenient writer protocol (schema-failure PREVENTION)", () => {
  test("parses plan lines with unheaded sections", () => {
    const p = parseLenientPlan(
      "Scope ||| What this review covers and why.\n" +
      "- ||| A flowing unheaded opening.\nnot a plan line\n",
    )
    expect(p).toHaveLength(2)
    expect(p[0]).toEqual({ heading: "Scope", brief: "What this review covers and why." })
    expect(p[1]!.heading).toBeNull()
  })
  test("garbage in → empty out (caller keeps its error path)", () => {
    expect(parseLenientPlan("just prose with no separators")).toEqual([])
  })
})

import { draftSection } from "./draft.ts"
import { mkdtempSync as mkt, writeFileSync as wf2 } from "node:fs"
import { tmpdir as td } from "node:os"
import { join as j3 } from "node:path"
import { openDb as od } from "@abstract/core"
import type { Workspace as WS } from "@abstract/core"

describe("brief-smuggling PREVENTION gate (the B4 failure)", () => {
  test("read-but-uningested file + brief → mechanical refusal naming the remedy", async () => {
    const root = mkt(j3(td(), "op-b4-"))
    const db = od(j3(root, "t.db"))
    wf2(j3(root, "notes.md"), "The cooker reached 180C in 22 minutes.")
    db.query("INSERT INTO read_log (source_path, from_page, to_page, created_at) VALUES (?,?,?,?)")
      .run("notes.md", 1, 1, Date.now())
    const r = await draftSection(db, { root, name: "t" } as unknown as WS, {
      instructions: "one paragraph on the cooker",
      queries: ["parabolic cooker temperature"],
      brief: "The cooker reached 180C in 22 minutes.",
      document: "qa-cooker",
      writer: {} as never, // gate fires BEFORE any model call
      verifier: {} as never,
    })
    expect("error" in r && r.error).toContain("WITHOUT ingesting")
    expect("error" in r && r.error).toContain("ingest_source")
  })
  test("genuine conversation-brief flows pass the gate (no read-uningested files)", async () => {
    const root = mkt(j3(td(), "op-b4b-"))
    const db = od(j3(root, "t.db"))
    const r = await draftSection(db, { root, name: "t" } as unknown as WS, {
      instructions: "one paragraph",
      queries: ["anything"],
      brief: "We agreed the approach is sound.",
      document: "opinion",
      writer: {} as never, // will fail later at the model call — but NOT at the gate
      verifier: {} as never,
    })
    // reaching the writer (and failing there) proves the gate did not fire
    expect("error" in r && r.error).not.toContain("WITHOUT ingesting")
  }, 20_000)
})

import { parseAnnotatedMarkdown } from "./draft.ts"

describe("markdown-native authoring (the any-structure fix)", () => {
  test("prose lines with annotations parse into cited units, annotations stripped", () => {
    const r = parseAnnotatedMarkdown(
      "Compression reduces model size dramatically. [[c:abc123]]\n" +
      "This raises equity questions. [[c:-]]\n" +
      "Pruning harms underrepresented classes most. [[c:def456,abc123]]",
    )
    expect(r.units).toHaveLength(3)
    expect(r.units[0]).toEqual({ text: "Compression reduces model size dramatically.", cites: ["abc123"], block: "p" })
    expect(r.units[1]!.cites).toEqual([])
    expect(r.units[2]!.cites).toEqual(["def456", "abc123"])
    expect(r.units.every((u) => !u.text.includes("[[c:"))).toBe(true)
  })
  test("GFM tables parse with per-cell cites and a caption", () => {
    const r = parseAnnotatedMarkdown(
      "*Studies compared*\n" +
      "| Study | Method | Finding |\n" +
      "| --- | --- | --- |\n" +
      "| Hooker 2020 | pruning | disparate impact on rare classes [[c:aa11]] |\n" +
      "| Ahia 2021 | quantization | low-resource languages hit hardest [[c:bb22]] |",
    )
    expect(r.tables).toHaveLength(1)
    const t = r.tables[0]!
    expect(t.caption).toBe("Studies compared")
    expect(t.columns).toEqual(["Study", "Method", "Finding"])
    expect(t.rows[0]![2]).toEqual({ text: "disparate impact on rare classes", cites: ["aa11"] })
    expect(t.rows[1]![0]!.cites).toEqual([])
  })
  test("lists parse as li units, ordered flag detected", () => {
    const r = parseAnnotatedMarkdown("- first factor [[c:x1]]\n2. second factor [[c:x2]]")
    expect(r.units[0]!.block).toBe("li")
    expect(r.units[0]!.ordered).toBe(false)
    expect(r.units[1]!.ordered).toBe(true)
  })
  test("HTML lines are rejected into the violations list; headings and fences skipped", () => {
    const r = parseAnnotatedMarkdown("## My Heading\n<div>bad</div>\n```\ncode\n```\nReal sentence. [[c:z9]]")
    expect(r.units).toHaveLength(1)
    expect(r.html).toHaveLength(1)
  })
})

describe("renderDraftBody renders lists (structure freedom v1)", () => {
  test("li units become markdown list lines; prose resumes as a new paragraph", () => {
    const nums = (c: string[]) => (c.length ? [1] : [])
    const body = renderDraftBody(
      [
        { text: "Three factors matter.", cites: [], heading: "Factors", block: "p" },
        { text: "model size", cites: ["a"], heading: null, block: "li", ordered: false },
        { text: "data balance", cites: ["a"], heading: null, block: "li", ordered: false },
        { text: "These interact in practice.", cites: [], heading: null, block: "p" },
      ],
      [],
      nums,
    )
    expect(body).toContain("## Factors\n\nThree factors matter.")
    expect(body).toContain("\n- model size [1]\n- data balance [1]")
    expect(body).toContain("data balance [1]\n\nThese interact in practice.")
  })
})

describe("paragraphs + sub-headings survive (the wall-of-text fix)", () => {
  test("blank lines become paragraph boundaries; bold-only and ### lines become h3 units", () => {
    const r = parseAnnotatedMarkdown(
      "First paragraph sentence. [[c:a1]]\n\n" +
      "Second paragraph opens here. [[c:a2]]\n" +
      "**Pruning and Structured Sparsity**\n" +
      "Pruning removes weights. [[c:a3]]\n" +
      "### Quantization\n" +
      "Quantization reduces precision. [[c:a4]]",
    )
    expect(r.units.map((u) => u.block)).toEqual(["p", "p", "h3", "p", "h3", "p"])
    expect(r.units[1]!.newPara).toBe(true)
    expect(r.units[2]!.text).toBe("Pruning and Structured Sparsity")
    expect(r.units[4]!.text).toBe("Quantization")
  })
  test("renderer emits ### sub-headings and paragraph breaks", () => {
    const nums = () => []
    const body = renderDraftBody(
      [
        { text: "Intro sentence.", cites: [], heading: "Background", block: "p" },
        { text: "Same paragraph.", cites: [], heading: null, block: "p" },
        { text: "New paragraph starts.", cites: [], heading: null, block: "p", newPara: true },
        { text: "Pruning", cites: [], heading: null, block: "h3" },
        { text: "Pruning removes weights.", cites: [], heading: null, block: "p" },
      ],
      [],
      nums,
    )
    expect(body).toContain("Intro sentence. Same paragraph.\n\nNew paragraph starts.")
    expect(body).toContain("\n\n### Pruning\n\nPruning removes weights.")
  })
})

import { shortIdentity } from "./draft.ts"
import { renderDraftHtml } from "./html.ts"

describe("scholarly identity + the reading projection (why-no-authors fix)", () => {
  test("shortIdentity extracts the in-text form", () => {
    expect(shortIdentity('Hooker et al., 2020 — "What Do Compressed Models Forget?"')).toBe("Hooker et al., 2020")
    expect(shortIdentity("hooker2020.pdf")).toBe("hooker2020.pdf")
  })
  test("renderDraftBody author-year style renders names instead of numbers", () => {
    const body = renderDraftBody(
      [{ text: "Compression harms rare classes.", cites: ["c1"], heading: null, block: "p" }],
      [],
      () => [1],
      () => "(Hooker et al., 2020)",
    )
    expect(body).toContain("Compression harms rare classes. (Hooker et al., 2020)")
    expect(body).not.toContain("[1]")
  })
  test("HTML artifact: cite anchors, PDF deep-links at page, verdict classes, structure", () => {
    const html = renderDraftHtml({
      title: "compression fairness review",
      sentences: [
        { text: "Intro claim.", cites: ["c1"], heading: "Background", block: "p", verdict: "supported", quotes: [], invalidCites: [] },
        { text: "A list point.", cites: ["c1"], heading: null, block: "li", verdict: "partial", quotes: [], invalidCites: [] },
      ],
      tables: [],
      refs: [{ num: 1, path: "sources/hooker2020.pdf", label: 'Hooker et al., 2020 — "Forgetting"', grade: "peer_reviewed", page: 4 }],
      citeNums: () => [1],
      summaryLine: "1 supported",
    })
    expect(html).toContain('href="#ref-1"')
    expect(html).toContain('id="ref-1"')
    expect(html).toContain("/api/file?path=sources%2Fhooker2020.pdf#page=4")
    expect(html).toContain('class="s v-supported"')
    expect(html).toContain("<li>")
    expect(html).toContain("<h2>Background</h2>")
    expect(html).toContain("@media print")
  })
})

describe("plain documents (verified:false) — clean rendering, zero chrome", () => {
  test("plain HTML has no verification toggle, no overlay checkbox, no references", () => {
    const html = renderDraftHtml({
      title: "motivation letter",
      sentences: [
        { text: "I am writing to apply for the position.", cites: [], heading: null, block: "p", verdict: "uncited", quotes: [], invalidCites: [] },
        { text: "Sincerely, the author.", cites: [], heading: null, block: "p", verdict: "uncited", quotes: [], invalidCites: [], newPara: true },
      ],
      tables: [],
      refs: [],
      citeNums: () => [],
      summaryLine: "",
      plain: true,
    })
    expect(html).not.toContain("verification overlay")
    expect(html).not.toContain('id="v"')
    expect(html).not.toContain("References")
    expect(html).toContain("<p>I am writing to apply for the position.</p>")
    expect(html).toContain("@media print") // print-grade CSS stays
  })
  test("a verified doc with zero refs also drops the empty References list", () => {
    const html = renderDraftHtml({
      title: "t",
      sentences: [{ text: "Author position.", cites: [], heading: null, block: "p", verdict: "uncited", quotes: [], invalidCites: [] }],
      tables: [],
      refs: [],
      citeNums: () => [],
      summaryLine: "0 supported",
    })
    expect(html).not.toContain("<div class=\"refs\">")
    expect(html).toContain("verification overlay") // still a verified doc — toggle stays
  })
})

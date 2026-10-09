/**
 * Verifier spike — the kill/pivot experiment (ARCHITECTURE.md §9).
 *
 * Runs the entailment verifier over a labeled dataset of claim–passage pairs
 * built from the founder's own papers. The metric that decides everything:
 *
 *   FALSE-VERIFIED RATE — how often an UNSUPPORTED claim gets a green badge.
 *   One false "verified" caught by a reviewer destroys the product's brand,
 *   so the bar is zero.
 *
 * Usage:
 *   bun run --cwd packages/verifier eval             # uses your chat model (override with VERIFIER_MODEL)
 *   VERIFIER_MODEL=google/gemini-3.1-flash-lite bun run --cwd packages/verifier eval
 */
import { effectiveRoleSpec, resolveModel } from "@abstract/providers"
import { verifyClaim, type VerifyResult } from "../src/index.ts"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import supportedA from "./supported-a.json"
import supportedB from "./supported-b.json"
import traps from "./unsupported.json"

const extended: any[] = []
for (const f of ["extended-a.json", "extended-b.json"]) {
  const fp = join(import.meta.dir, f)
  if (existsSync(fp)) extended.push(...JSON.parse(readFileSync(fp, "utf8")))
}

interface Case {
  id: string
  kind: "direct" | "numeric" | "hedged" | "synthesis" | "mismatch"
  label: "supported" | "unsupported"
  claim: string
  passages: string[]
  notes?: string
}

const positives = [...supportedA, ...supportedB] as Case[]
const byId = new Map(positives.map((c) => [c.id, c]))
const cases: Case[] = [
  ...positives,
  ...(traps as (Omit<Case, "passages"> & { passageRef: string })[]).map((t) => {
    const ref = byId.get(t.passageRef)
    if (!ref) throw new Error(`unknown passageRef ${t.passageRef} in ${t.id}`)
    return { ...t, passages: ref.passages }
  }),
  ...(extended as Case[]),
]
if (cases.length === 0) {
  console.error("dataset.json is empty — build the dataset first")
  process.exit(1)
}

const spec = process.env["VERIFIER_MODEL"] ?? (await effectiveRoleSpec("verifier"))
if (!spec) {
  console.error(
    "no verifier model available — set an API key (e.g. GOOGLE_GENERATIVE_AI_API_KEY) " +
      "or pass VERIFIER_MODEL=provider/model",
  )
  process.exit(1)
}
const model = resolveModel(spec)
console.log(`verifier model: ${spec}\ncases: ${cases.length}\n`)

const CONCURRENCY = 4
const results: { c: Case; r: VerifyResult }[] = []
let failed = 0

for (let i = 0; i < cases.length; i += CONCURRENCY) {
  const batch = cases.slice(i, i + CONCURRENCY)
  const settled = await Promise.allSettled(batch.map((c) => verifyClaim(model, c.claim, c.passages)))
  settled.forEach((s, j) => {
    const c = batch[j]!
    if (s.status === "rejected") {
      failed++
      console.log(`  ✗ ${c.id} — API error: ${String(s.reason).slice(0, 120)}`)
      return
    }
    const r = s.value
    const ok =
      (c.label === "supported" && r.verdict === "supported") ||
      (c.label === "unsupported" && r.verdict !== "supported")
    const mark = ok ? "✓" : "✗"
    const extra = r.downgraded ? " (downgraded: quote failed verbatim gate)" : ""
    console.log(`  ${mark} ${c.id} [${c.kind}] label=${c.label} → ${r.verdict}${extra}`)
    if (!ok) console.log(`      claim: ${c.claim.slice(0, 100)}\n      judge: ${r.rationale}`)
    results.push({ c, r })
  })
}

// ---- summary ---------------------------------------------------------------
const byLabel = (label: Case["label"]) => results.filter((x) => x.c.label === label)
const supported = byLabel("supported")
const unsupported = byLabel("unsupported")

const recall = supported.filter((x) => x.r.verdict === "supported").length
const falseVerified = unsupported.filter((x) => x.r.verdict === "supported")

console.log("\n──── summary ────")
console.log(
  `recall on supported claims:   ${recall}/${supported.length}` +
    (supported.length ? ` (${((100 * recall) / supported.length).toFixed(0)}%)` : ""),
)
console.log(
  `FALSE-VERIFIED (kill metric): ${falseVerified.length}/${unsupported.length}` +
    (unsupported.length
      ? ` (${((100 * falseVerified.length) / unsupported.length).toFixed(1)}%)`
      : ""),
)
for (const kind of ["direct", "numeric", "hedged", "synthesis", "mismatch"] as const) {
  const ks = results.filter((x) => x.c.kind === kind)
  if (!ks.length) continue
  const kOk = ks.filter(
    (x) =>
      (x.c.label === "supported" && x.r.verdict === "supported") ||
      (x.c.label === "unsupported" && x.r.verdict !== "supported"),
  ).length
  console.log(`  ${kind.padEnd(10)} ${kOk}/${ks.length}`)
}
if (failed) console.log(`API failures (not scored): ${failed}`)

if (process.env["OUT_JSON"]) {
  writeFileSync(
    process.env["OUT_JSON"]!,
    JSON.stringify({
      model: spec,
      cases: results.length,
      recallSupported: supported.length ? recall / supported.length : null,
      falseVerifiedRate: unsupported.length ? falseVerified.length / unsupported.length : null,
      date: new Date().toISOString().slice(0, 10),
    }),
  )
}
if (falseVerified.length > 0) {
  console.log("\n⚠ KILL METRIC FAILED — unsupported claims got green badges:")
  for (const x of falseVerified) console.log(`  ${x.c.id}: ${x.c.claim.slice(0, 120)}`)
  console.log("→ tighten the judge prompt / try a stronger verifier model / add claim decomposition.")
  process.exit(1)
}
console.log("\n✓ kill metric passed: zero unsupported claims were green-badged.")
if (process.env["OUT_JSON"]) {
  writeFileSync(
    process.env["OUT_JSON"]!,
    JSON.stringify({
      model: spec,
      cases: results.length,
      recallSupported: supported.length ? recall / supported.length : null,
      falseVerifiedRate: unsupported.length ? falseVerified.length / unsupported.length : null,
      date: new Date().toISOString().slice(0, 10),
    }),
  )
}

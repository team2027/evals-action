// Contract test — fetches the live OpenAPI spec from the 2027 evals API,
// then verifies (a) every field the action reads is present in the Run schema
// and (b) the action's renderers don't emit NaN/undefined when fed fixtures
// sampled from that spec.
//
// Fails RED when the API drops or renames a field the action depends on, which
// is the whole point: catch drift at build time, not in a customer's PR.

const test = require("node:test")
const assert = require("node:assert/strict")
const OpenAPISampler = require("openapi-sampler")
const {
  renderComment,
  renderCommitStatus,
  formatDelta,
  renderTestedLine,
  deriveDashboardUrl,
  renderMetricsLine,
  formatSecondsDelta,
  formatCostDelta,
  formatCountDelta,
} = require("../scripts/run.js")

const SPEC_URL = process.env.OPENAPI_SPEC_URL || "https://2027.dev/evals/api/openapi"

let spec

test.before(async () => {
  const res = await fetch(SPEC_URL)
  if (!res.ok) throw new Error(`failed to fetch spec from ${SPEC_URL}: HTTP ${res.status}`)
  spec = await res.json()
})

// Follow a dotted path through an OpenAPI schema, resolving $ref as we go.
// Returns the schema node at the path, or undefined.
function resolvePath(schema, path) {
  let cur = schema
  for (const part of path.split(".")) {
    if (!cur) return undefined
    if (cur.$ref) {
      const refParts = cur.$ref.replace(/^#\//, "").split("/")
      cur = refParts.reduce((o, k) => (o ? o[k] : undefined), spec)
      if (!cur) return undefined
    }
    if (!cur.properties || !cur.properties[part]) return undefined
    cur = cur.properties[part]
  }
  return cur
}

const RUN_FIELDS_THE_ACTION_READS = [
  // Top-level — used in run.js poll loop
  "runId",
  "status",
  "statusUrl",
  "failureReason",
  // Prompt — for the comment heading
  "prompt.title",
  // Report — for the score/grade/links section.
  // Baseline is computed client-side by listing prior published runs (see
  // fetchBaseline + the /api/v1/runs filter test below), so it isn't a field
  // on the Run schema.
  "report.url",
  "report.slug",
  "report.score",
  "report.grade",
]

test("Run schema declares every field the action reads", () => {
  const Run = spec.components?.schemas?.Run
  assert.ok(Run, "spec is missing components.schemas.Run")
  const missing = RUN_FIELDS_THE_ACTION_READS.filter((p) => !resolvePath(Run, p))
  assert.deepEqual(
    missing,
    [],
    `spec missing fields the action depends on:\n  ${missing.join("\n  ")}\n` +
      `if the API renamed these, update scripts/run.js to match.\n` +
      `if the API hasn't shipped them yet, this build is gating that merge correctly.`,
  )
})

test("GET /api/v1/runs accepts promptId + reportStatus filters (used for baseline lookup)", () => {
  const op = spec.paths?.["/api/v1/runs"]?.get
  assert.ok(op, "spec missing GET /api/v1/runs")
  const params = op.parameters || []
  const names = new Set(params.filter((p) => p.in === "query").map((p) => p.name))
  for (const required of ["promptId", "reportStatus"]) {
    assert.ok(
      names.has(required),
      `GET /api/v1/runs missing query param '${required}' — action's baseline lookup depends on it`,
    )
  }
})

test("RunResponse declares fields the action reads from POST /run", () => {
  const RunResponse = spec.components?.schemas?.RunResponse
  assert.ok(RunResponse, "spec is missing components.schemas.RunResponse")
  for (const path of ["runId", "statusUrl"]) {
    assert.ok(resolvePath(RunResponse, path), `RunResponse missing ${path}`)
  }
})

function sampleRun() {
  return OpenAPISampler.sample(spec.components.schemas.Run, { skipReadOnly: false }, spec)
}

function renderArgsFromSample(sample, overrides = {}) {
  return {
    status: sample.status,
    promptTitle: sample.prompt?.title,
    statusUrl: sample.statusUrl,
    report: sample.report,
    baseline: sample.baseline,
    failureReason: sample.failureReason,
    sha: "abc1234def5678901234567890abcdef12345678",
    urlMapRaw: '{"acme.com":"https://preview-pr-1.fly.dev"}',
    ...overrides,
  }
}

const STATUSES = ["pending", "running", "completed", "failed", "superseded", "weird-unknown-status"]

test("renderComment never leaks NaN/undefined/null/[object] for any sampled status", () => {
  const sample = sampleRun()
  for (const status of STATUSES) {
    const body = renderComment(renderArgsFromSample(sample, { status }))
    assert.equal(typeof body, "string", `renderComment must return string for status=${status}`)
    assert.ok(body.length > 0, `renderComment must return non-empty for status=${status}`)
    for (const leak of ["NaN", "undefined", "[object Object]"]) {
      assert.equal(
        body.includes(leak),
        false,
        `renderComment leaked '${leak}' for status=${status}:\n${body}`,
      )
    }
  }
})

test("renderCommitStatus returns a valid commit-status state for every sampled status", () => {
  const sample = sampleRun()
  const validStates = new Set(["pending", "success", "error", "failure"])
  for (const status of STATUSES) {
    const cs = renderCommitStatus({
      status,
      statusUrl: sample.statusUrl,
      report: sample.report,
      failureReason: sample.failureReason,
    })
    assert.ok(validStates.has(cs.state), `invalid state '${cs.state}' for status=${status}`)
    assert.equal(typeof cs.description, "string")
    assert.ok(cs.description.length > 0, `empty description for status=${status}`)
  }
})

test("renderComment includes score+grade when the spec declares them and the sample populates them", () => {
  const sample = sampleRun()
  if (sample.report?.score == null || !sample.report?.grade) {
    // Spec doesn't ship score/grade yet, or sampler emitted null report — skip,
    // the schema-presence test above is the load-bearing gate.
    return
  }
  const body = renderComment(renderArgsFromSample(sample, { status: "completed" }))
  assert.match(body, new RegExp(String(sample.report.score)), "score must appear in completed comment")
  const gradeEscaped = sample.report.grade.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  assert.match(body, new RegExp(gradeEscaped), "grade must appear in completed comment")
})

test("renderComment includes failureReason for status=failed", () => {
  const sample = sampleRun()
  const reason = "Browser agent crashed on step 4 (sample reason)"
  const body = renderComment(renderArgsFromSample(sample, { status: "failed", failureReason: reason }))
  assert.match(body, /Eval failed/)
  assert.ok(body.includes(reason), "failureReason text must appear in body")
})

test("renderComment always references the statusUrl somewhere when present", () => {
  const sample = sampleRun()
  for (const status of ["pending", "running", "failed", "superseded"]) {
    const body = renderComment(renderArgsFromSample(sample, { status }))
    assert.ok(
      body.includes(sample.statusUrl),
      `statusUrl missing from rendered body for status=${status}`,
    )
  }
})

test("formatDelta is well-behaved for sane numeric inputs", () => {
  assert.equal(formatDelta(0), "Same as baseline")
  assert.equal(formatDelta(2.5), "+2.5 pts vs baseline")
  assert.equal(formatDelta(-1), "-1 pts vs baseline")
  assert.equal(formatDelta(0.04), "Same as baseline") // rounds to 0
  for (const v of [0, 1, -1, 10.5, -10.5]) {
    const out = formatDelta(v)
    assert.ok(!out.includes("NaN") && !out.includes("undefined"), `formatDelta leaked junk for ${v}: ${out}`)
  }
})

test("renderTestedLine survives malformed input", () => {
  assert.equal(renderTestedLine(""), null)
  assert.equal(renderTestedLine("not json"), null)
  assert.equal(renderTestedLine("[1,2,3]"), null) // arrays rejected
  assert.equal(renderTestedLine("{}"), null) // empty rejected
  assert.equal(renderTestedLine('{"acme.com": ""}'), null) // empty values filtered
  assert.equal(
    renderTestedLine('{"acme.com":"https://x.fly.dev"}'),
    "Tested: acme.com → x.fly.dev",
  )
})

test("formatSecondsDelta / formatCostDelta / formatCountDelta are defensive", () => {
  assert.equal(formatSecondsDelta(0), null)
  assert.equal(formatSecondsDelta(NaN), null)
  assert.equal(formatSecondsDelta(12), "+12s")
  assert.equal(formatSecondsDelta(-65), "-1m 5s")
  assert.equal(formatSecondsDelta(120), "+2m")
  assert.equal(formatCostDelta(0), null)
  assert.equal(formatCostDelta(0.001), null) // sub-half-cent ignored
  assert.equal(formatCostDelta(0.03), "+$0.03")
  assert.equal(formatCostDelta(-0.12), "-$0.12")
  assert.equal(formatCountDelta(0), null)
  assert.equal(formatCountDelta(1), "+1")
  assert.equal(formatCountDelta(-2), "-2")
})

test("renderMetricsLine renders only present fields, adds deltas only when both sides have them", () => {
  const current = {
    time: "2m 14s", timeSeconds: 134,
    cost: "$0.12", costUsd: 0.12,
    errors: 1, interruptions: 0,
  }
  const baseline = { timeSeconds: 120, costUsd: 0.15, errors: 0, interruptions: 0 }
  const line = renderMetricsLine(current, baseline)
  assert.match(line, /Time: 2m 14s \(\+14s\)/)
  assert.match(line, /Cost: \$0\.12 \(-\$0\.03\)/)
  assert.match(line, /Errors: 1 \(\+1\)/)
  assert.match(line, /Interruptions: 0/) // no delta annotation since 0-0
  assert.equal(line.includes("Interruptions: 0 ("), false, "zero-delta interruptions shouldn't render (+0)")

  // Without baseline: just values, no deltas.
  const onlyCurrent = renderMetricsLine(current, null)
  assert.match(onlyCurrent, /Time: 2m 14s/)
  assert.equal(onlyCurrent.includes("("), false, "no baseline → no parens")

  // Missing current → null result.
  assert.equal(renderMetricsLine(null, baseline), null)
  assert.equal(renderMetricsLine({}, baseline), null)
})

test("deriveDashboardUrl strips trailing slash before report-slug strip", () => {
  const out = deriveDashboardUrl(
    { url: "https://2027.dev/evals/acme/reports/abc123/" },
    null,
  )
  assert.equal(out, "https://2027.dev/evals/acme")
})

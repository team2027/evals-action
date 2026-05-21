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
  renderUrlMapBlockquoteLines,
  renderTemplateVarsBlockquoteLines,
  deriveDashboardUrl,
  renderMetricsTable,
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
  // Human-facing dashboard URL for this run — preferred over statusUrl for
  // links surfaced to humans (PR comment "Status →", commit-status targetUrl).
  "runUrl",
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
  // runUrl is required on POST so the initial pending commit status + PR
  // comment can link to the human run page without a follow-up GET.
  // See team2027/evals#205, team2027/evals-action#10.
  for (const path of ["runId", "statusUrl", "runUrl"]) {
    assert.ok(resolvePath(RunResponse, path), `RunResponse missing ${path}`)
  }
})

test("RunRequest declares the wire fields the action sends (urlMap + templateArgs)", () => {
  // Pins the wire-name the action uses for the template-vars input. If the
  // server ever renames `templateArgs` (or drops it), this test fails RED at
  // build time instead of producing silent `400 Missing template vars` in CI.
  // See team2027/evals-action#6 for the original drift incident.
  const RunRequest = spec.components?.schemas?.RunRequest
  assert.ok(RunRequest, "spec is missing components.schemas.RunRequest")
  for (const path of ["urlMap", "templateArgs"]) {
    assert.ok(resolvePath(RunRequest, path), `RunRequest missing ${path}`)
  }
})

function sampleRun() {
  return OpenAPISampler.sample(spec.components.schemas.Run, { skipReadOnly: false }, spec)
}

function renderArgsFromSample(sample, overrides = {}) {
  return {
    status: sample.status,
    promptTitle: sample.prompt?.title,
    promptText: sample.prompt?.text,
    promptEndGoal: sample.prompt?.endGoal,
    statusUrl: sample.statusUrl,
    runUrl: sample.runUrl,
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

test("renderComment communicates 'Did not finish' when status=completed but score is null", () => {
  const body = renderComment({
    status: "completed",
    promptTitle: "Install MCP",
    statusUrl: "https://x.dev/evals/api/v1/runs/abc",
    report: {
      score: null,
      grade: null,
      url: "https://x.dev/evals/acme/reports/abc",
      keyFinding: "Google MFA/TOTP blocked API key retrieval and prevented task completion.",
      metrics: { time: "0m 16s", cost: "$0.26", errors: 0, interruptions: 1 },
    },
    baseline: null,
    failureReason: null,
    sha: "abcdef1234567890",
    urlMapRaw: null,
  })
  assert.match(body, /Did not finish/)
  assert.match(body, /Google MFA\/TOTP blocked API key retrieval/)
  assert.equal(/Eval complete/i.test(body), false, "must not read as success when score is null")
  assert.equal(/\*\*[A-F][+-]? \d+\/100\*\*/.test(body), false, "must not show a grade/score header when score is null")
})

test("renderCommitStatus marks completed+null-score as failure with DNF explanation", () => {
  const cs = renderCommitStatus({
    status: "completed",
    statusUrl: "https://x.dev/evals/api/v1/runs/abc",
    report: { score: null, grade: null, keyFinding: "MFA blocked login.", url: "https://x.dev/evals/acme/reports/abc" },
    failureReason: null,
  })
  assert.equal(cs.state, "failure")
  assert.match(cs.description, /Did not finish/)
  assert.match(cs.description, /MFA blocked login/)
  assert.equal(cs.targetUrl, "https://x.dev/evals/acme/reports/abc")
})

test("renderComment neutralizes triple-backtick runs in server-supplied strings so fences stay balanced", () => {
  // Realistic risk: LLM-generated keyFinding / failureReason may quote a code
  // snippet with ``` which would close the diff fence early.
  const malicious = "Crashed on ```\nthrow new Error()\n``` block"
  const fenceCount = (s) => (s.match(/^```/gm) || []).length
  // Strip the renderer's own fence lines, then assert no raw triple-backticks
  // survived from the input — those would have closed the fence early.
  const stripFences = (s) => s.replace(/^```diff$/gm, "").replace(/^```$/gm, "")

  const failedBody = renderComment({
    status: "failed",
    promptTitle: "T",
    statusUrl: "https://x/api/v1/runs/a",
    report: null,
    baseline: null,
    failureReason: malicious,
    sha: "abcdef1",
    urlMapRaw: null,
  })
  assert.equal(
    fenceCount(failedBody) % 2,
    0,
    `failed-body fence count must be even (was ${fenceCount(failedBody)}):\n${failedBody}`,
  )
  assert.equal(stripFences(failedBody).includes("```"), false, "raw ``` must be neutralized in failed body")

  const dnfBody = renderComment({
    status: "completed",
    promptTitle: "T",
    statusUrl: "https://x/api/v1/runs/a",
    report: { score: null, grade: null, keyFinding: malicious, url: "https://x/r" },
    baseline: null,
    failureReason: null,
    sha: "abcdef1",
    urlMapRaw: null,
  })
  assert.equal(
    fenceCount(dnfBody) % 2,
    0,
    `dnf-body fence count must be even (was ${fenceCount(dnfBody)}):\n${dnfBody}`,
  )
  assert.equal(stripFences(dnfBody).includes("```"), false, "raw ``` must be neutralized in DNF body")
})

test("renderComment renders prompt.text in a default-closed <details> block on completed", () => {
  const promptText = "Sign up for an account, create a project, and grab the API key."
  const body = renderComment({
    status: "completed",
    promptTitle: "Sign up and create a project",
    promptText,
    statusUrl: "https://x.dev/evals/api/v1/runs/abc",
    runUrl: "https://x.dev/evals/acme/runs/abc",
    report: {
      score: 87,
      grade: "B+",
      url: "https://x.dev/evals/acme/reports/abc",
      metrics: { time: "2m 14s", cost: "$0.12", errors: 0, interruptions: 0 },
    },
    baseline: null,
    failureReason: null,
    sha: "abcdef1234567890",
    urlMapRaw: '{"acme.com":"https://preview-pr-1.fly.dev"}',
  })
  assert.match(body, /<details><summary>prompt<\/summary>/)
  assert.ok(body.includes(promptText), "prompt.text body must appear verbatim inside the <details> block")
  // <details> must come AFTER the metrics table and BEFORE the url-map blockquote.
  const detailsIdx = body.indexOf("<details><summary>prompt</summary>")
  const tableIdx = body.indexOf("| Time |")
  const blockquoteIdx = body.indexOf("> acme.com → ")
  assert.ok(tableIdx >= 0 && detailsIdx > tableIdx, "<details> must appear after the metrics table")
  assert.ok(blockquoteIdx >= 0 && detailsIdx < blockquoteIdx, "<details> must appear before the url-map blockquote")
})

test("renderComment omits the <details> block when prompt.text is missing or empty", () => {
  const baseArgs = {
    status: "completed",
    promptTitle: "T",
    statusUrl: "https://x.dev/evals/api/v1/runs/abc",
    runUrl: "https://x.dev/evals/acme/runs/abc",
    report: { score: 87, grade: "B+", url: "https://x.dev/evals/acme/reports/abc" },
    baseline: null,
    failureReason: null,
    sha: "abcdef1",
    urlMapRaw: null,
  }
  for (const promptText of [undefined, null, "", "   \n  "]) {
    const body = renderComment({ ...baseArgs, promptText })
    assert.equal(
      body.includes("<details><summary>prompt</summary>"),
      false,
      `<details> block must be absent when promptText=${JSON.stringify(promptText)}`,
    )
  }
})

test("renderComment does NOT render prompt.text in the running comment", () => {
  const body = renderComment({
    status: "running",
    promptTitle: "T",
    promptText: "Some prompt body that should not appear during polling.",
    statusUrl: "https://x.dev/evals/api/v1/runs/abc",
    runUrl: "https://x.dev/evals/acme/runs/abc",
    report: null,
    baseline: null,
    failureReason: null,
    sha: "abcdef1",
    urlMapRaw: '{"acme.com":"https://preview-pr-1.fly.dev"}',
  })
  assert.equal(
    body.includes("<details><summary>prompt</summary>"),
    false,
    "running comment must not include the <details> prompt block",
  )
  assert.equal(
    body.includes("Some prompt body that should not appear during polling."),
    false,
    "running comment must not leak prompt.text into the body",
  )
})

test("renderComment includes failureReason for status=failed", () => {
  const sample = sampleRun()
  const reason = "Browser agent crashed on step 4 (sample reason)"
  const body = renderComment(renderArgsFromSample(sample, { status: "failed", failureReason: reason }))
  assert.match(body, /Eval failed/)
  assert.ok(body.includes(reason), "failureReason text must appear in body")
})

test("renderComment surfaces url-map and template-vars context in the Running… body as a single blockquote (template vars first, then url-map)", () => {
  const body = renderComment({
    status: "running",
    promptTitle: "Getting Started: Staging CLI",
    statusUrl: "https://2027.dev/evals/api/v1/runs/r",
    runUrl: "https://2027.dev/evals/acme/runs/r",
    report: null,
    baseline: null,
    failureReason: null,
    sha: "ca3dedf",
    urlMapRaw: '{"www.sanity.io":"https://www.sanity.io"}',
    templateVarsRaw: '{"cliInstall":"npm i -g https://pkg.pr.new/team2027/sanity-cli/@sanity/cli@1ca9807"}',
  })
  assert.match(body, /Running…/)
  // Template vars come first in the blockquote, then the url-map line.
  const varIdx = body.indexOf("> {{cliInstall}} → `npm i -g https://pkg.pr.new/")
  const mapIdx = body.indexOf("> www.sanity.io → `www.sanity.io`")
  assert.ok(varIdx >= 0, `template-var blockquote line missing:\n${body}`)
  assert.ok(mapIdx >= 0, `url-map blockquote line missing:\n${body}`)
  assert.ok(varIdx < mapIdx, "template-var line must precede url-map line in the blockquote")
})

test("renderComment omits the blockquote entirely when template-vars is absent and url-map is the only source", () => {
  const body = renderComment({
    status: "running",
    promptTitle: "T",
    statusUrl: "https://x/api/v1/runs/r",
    report: null,
    baseline: null,
    failureReason: null,
    sha: "abcdef1",
    urlMapRaw: '{"acme.com":"https://x.fly.dev"}',
    templateVarsRaw: null,
  })
  // No template-var line.
  assert.equal(/^> \{\{/m.test(body), false, "must not render a template-var blockquote line when input is absent")
  // url-map line still present.
  assert.match(body, /^> acme\.com → `x\.fly\.dev`$/m)
})

test("renderComment omits the blockquote entirely when both url-map and template-vars are absent", () => {
  const body = renderComment({
    status: "running",
    promptTitle: "T",
    statusUrl: "https://x/api/v1/runs/r",
    report: null,
    baseline: null,
    failureReason: null,
    sha: "abcdef1",
    urlMapRaw: null,
    templateVarsRaw: null,
  })
  assert.equal(/^> /m.test(body), false, "must not render any blockquote lines when both inputs are absent")
})

test("renderComment uses runUrl as the Status link (no statusUrl fallback)", () => {
  // POST /run now guarantees runUrl, so the renderer links to the human run
  // page from the very first comment — never the raw JSON statusUrl.
  const sample = sampleRun()
  const runUrl = "https://2027.dev/evals/acme/runs/abc-123"
  for (const status of ["pending", "running", "failed", "superseded"]) {
    const body = renderComment(renderArgsFromSample(sample, { status, runUrl }))
    assert.ok(body.includes(runUrl), `runUrl not used for status=${status}`)
    assert.equal(body.includes(sample.statusUrl), false, `statusUrl must not appear as Status link (status=${status})`)
  }
})

test("renderCommitStatus uses runUrl as targetUrl when present", () => {
  const sample = sampleRun()
  const runUrl = "https://2027.dev/evals/acme/runs/abc-123"
  const cs = renderCommitStatus({
    status: "running",
    statusUrl: sample.statusUrl,
    runUrl,
    report: null,
    failureReason: null,
  })
  assert.equal(cs.targetUrl, runUrl)
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

test("renderUrlMapBlockquoteLines survives malformed input", () => {
  assert.deepEqual(renderUrlMapBlockquoteLines(""), [])
  assert.deepEqual(renderUrlMapBlockquoteLines("not json"), [])
  assert.deepEqual(renderUrlMapBlockquoteLines("[1,2,3]"), []) // arrays rejected
  assert.deepEqual(renderUrlMapBlockquoteLines("{}"), []) // empty rejected
  assert.deepEqual(renderUrlMapBlockquoteLines('{"acme.com": ""}'), []) // empty values filtered
  assert.deepEqual(
    renderUrlMapBlockquoteLines('{"acme.com":"https://x.fly.dev"}'),
    ["> acme.com → `x.fly.dev`"],
  )
  // Non-URL value falls back to the raw value.
  assert.deepEqual(
    renderUrlMapBlockquoteLines('{"skills.browserbase.com":"09d960d--team2027--browserbase-skills.2027.ax"}'),
    ["> skills.browserbase.com → `09d960d--team2027--browserbase-skills.2027.ax`"],
  )
})

test("renderTemplateVarsBlockquoteLines renders {{var}} → `value` lines with truncation, survives malformed input", () => {
  assert.deepEqual(renderTemplateVarsBlockquoteLines(""), [])
  assert.deepEqual(renderTemplateVarsBlockquoteLines("not json"), [])
  assert.deepEqual(renderTemplateVarsBlockquoteLines("[1,2,3]"), [])
  assert.deepEqual(renderTemplateVarsBlockquoteLines("{}"), [])
  assert.deepEqual(renderTemplateVarsBlockquoteLines('{"cliInstall": ""}'), [])
  assert.deepEqual(
    renderTemplateVarsBlockquoteLines('{"cliInstall":"npm i -g foo"}'),
    ["> {{cliInstall}} → `npm i -g foo`"],
  )
  // Long values get truncated so the line stays readable on a PR page.
  const long = "x".repeat(200)
  const out = renderTemplateVarsBlockquoteLines(JSON.stringify({ cliInstall: long }))
  assert.equal(out.length, 1)
  assert.match(out[0], /^> \{\{cliInstall\}\} → `x+\.\.\.`$/)
  assert.ok(out[0].length < 200, `expected truncation, got length=${out[0].length}`)
  // Multiple vars produce multiple lines, in declaration order.
  assert.deepEqual(
    renderTemplateVarsBlockquoteLines('{"a":"1","b":"2"}'),
    ["> {{a}} → `1`", "> {{b}} → `2`"],
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

test("renderMetricsTable renders only present columns, adds ▼/▲ deltas only when both sides have them", () => {
  const current = {
    time: "2m 14s", timeSeconds: 134,
    cost: "$0.12", costUsd: 0.12,
    errors: 1, interruptions: 0,
  }
  const baseline = { timeSeconds: 120, costUsd: 0.15, errors: 0, interruptions: 0 }
  const table = renderMetricsTable(current, baseline)
  // Header row lists every column we expect.
  assert.match(table, /\|\s*Time\s*\|\s*Cost\s*\|\s*Errors\s*\|\s*Interruptions\s*\|/)
  // Slower / cheaper / more-errors / same-interruptions → up-bad, down-good arrows.
  assert.match(table, /2m 14s\s+▲ \+14s/)
  assert.match(table, /\$0\.12\s+▼ -\$0\.03/)
  assert.match(table, /\|\s*1\s+▲ \+1\s*\|/)
  // Zero delta on interruptions → no arrow.
  assert.equal(/Interruptions[\s\S]*0\s+[▼▲]/.test(table), false, "zero-delta should not render an arrow")

  // Without baseline: values only, no deltas.
  const onlyCurrent = renderMetricsTable(current, null)
  assert.match(onlyCurrent, /2m 14s/)
  assert.equal(/[▼▲]/.test(onlyCurrent), false, "no baseline → no arrows")

  // Missing current → null result.
  assert.equal(renderMetricsTable(null, baseline), null)
  assert.equal(renderMetricsTable({}, baseline), null)
})

test("deriveDashboardUrl strips trailing slash before report-slug strip", () => {
  const out = deriveDashboardUrl(
    { url: "https://2027.dev/evals/acme/reports/abc123/" },
    null,
  )
  assert.equal(out, "https://2027.dev/evals/acme")
})

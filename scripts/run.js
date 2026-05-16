// Plain JS (not TS) because composite + actions/github-script doesn't compile
// TypeScript natively and we want zero install-step dependencies. Only uses
// what github-script injects: core, github (octokit), context, plus node:fetch
// available in node 20+.

const STICKY_MARKER = (id) => `<!-- 2027-eval-comment:${id} -->`
const STATUS_DESC_MAX = 140

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function jitter(ms) {
  const delta = ms * 0.1
  return ms + (Math.random() * 2 - 1) * delta
}

function truncate(str, max) {
  const s = String(str || "")
  if (s.length <= max) return s
  return `${s.slice(0, max - 3)}...`
}

// Commit-status descriptions are single-line; collapse any whitespace runs
// (incl. newlines from server failure reasons) before truncating.
function singleLine(str) {
  return String(str || "").replace(/\s+/g, " ").trim()
}

function deriveContext(promptTitle, promptId) {
  const slugSource = promptTitle || promptId || "eval"
  const slug = String(slugSource)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
  return slug ? `2027/eval/${slug}` : "2027/eval"
}

class HttpStatusError extends Error {
  constructor(status, message, retryAfter) {
    super(message)
    this.status = status
    this.retryAfter = retryAfter
  }
}

async function postJson(url, apiKey, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let parsed
  try {
    parsed = text ? JSON.parse(text) : {}
  } catch {
    parsed = { raw: text }
  }
  if (!res.ok) {
    const detail = parsed?.error || parsed?.detail || text || `HTTP ${res.status}`
    const retryAfter = res.headers.get("retry-after")
    throw new HttpStatusError(res.status, `POST ${url} failed (${res.status}): ${detail}`, retryAfter)
  }
  return parsed
}

// Retry POSTs on transient 5xx / network errors. 4xx fails immediately so a
// bad config (e.g. wrong promptId) doesn't sit retrying.
async function postJsonWithRetry(url, apiKey, body, { attempts = 3, baseDelayMs = 1000, core } = {}) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await postJson(url, apiKey, body)
    } catch (e) {
      const transient = e instanceof HttpStatusError ? e.status >= 500 : true
      if (!transient || i === attempts - 1) throw e
      const retryAfter = Number(e.retryAfter)
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : baseDelayMs * 2 ** i
      core?.warning(`attempt ${i + 1}/${attempts} failed, retrying in ${Math.round(delay)}ms: ${e.message}`)
      await sleep(delay)
    }
  }
}

async function getJson(url, apiKey) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  const text = await res.text()
  let parsed
  try {
    parsed = text ? JSON.parse(text) : {}
  } catch {
    parsed = { raw: text }
  }
  if (!res.ok) {
    const detail = parsed?.error || parsed?.detail || text || `HTTP ${res.status}`
    const retryAfter = res.headers.get("retry-after")
    throw new HttpStatusError(res.status, `GET ${url} failed (${res.status}): ${detail}`, retryAfter)
  }
  return parsed
}

async function findStickyComment(github, owner, repo, prNumber, marker, core) {
  const MAX_PAGES = 10
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { data } = await github.rest.issues.listComments({
      owner,
      repo,
      issue_number: prNumber,
      per_page: 100,
      page,
    })
    const found = data.find((c) => c.body && c.body.includes(marker))
    if (found) return found
    if (data.length < 100) return null
    if (page === MAX_PAGES) {
      core?.warning(
        `sticky-comment scan hit ${MAX_PAGES * 100}-comment cap without finding marker — will create a duplicate comment`,
      )
    }
  }
  return null
}

async function upsertComment(github, owner, repo, prNumber, marker, body, core) {
  const fullBody = body.includes(marker) ? body : `${marker}\n${body}`
  const existing = await findStickyComment(github, owner, repo, prNumber, marker, core)
  if (existing) {
    await github.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existing.id,
      body: fullBody,
    })
    return existing.id
  }
  const { data } = await github.rest.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body: fullBody,
  })
  return data.id
}

async function setCommitStatus(github, owner, repo, sha, params) {
  await github.rest.repos.createCommitStatus({
    owner,
    repo,
    sha,
    state: params.state,
    description: truncate(singleLine(params.description), STATUS_DESC_MAX),
    target_url: params.targetUrl,
    context: params.context,
  })
}

function scoreBar(score, width = 20) {
  const s = Math.max(0, Math.min(100, Number(score) || 0))
  const filled = Math.round((s / 100) * width)
  return "█".repeat(filled) + "░".repeat(Math.max(0, width - filled))
}

// For time/cost/errors/interruptions: lower is better. The existing delta
// helpers return strings prefixed with "+"/"-"; map that sign to an arrow.
// Anything not clearly signed passes through without an arrow.
function metricArrow(deltaStr) {
  if (!deltaStr) return ""
  if (deltaStr.startsWith("-")) return `▼ ${deltaStr}`
  if (deltaStr.startsWith("+")) return `▲ ${deltaStr}`
  return deltaStr
}

// Server-supplied free-form strings (failureReason, keyFinding, verdict, etc.)
// get rendered inside ```diff fences. If one of them contains a literal
// triple-backtick run it would close the fence early and leak the rest into
// the comment as raw markdown. Break any 3+ backtick run with zero-width
// spaces — invisible to humans, neutralizes the fence parser.
function sanitizeForFence(str) {
  return String(str || "").replace(/`{3,}/g, (run) => run.split("").join("​"))
}

function formatDelta(delta) {
  const rounded = Math.round(delta * 10) / 10
  const abs = Math.abs(rounded)
  const display = Number.isInteger(abs) ? String(abs) : abs.toFixed(1)
  if (rounded > 0) return `+${display} pts vs baseline`
  if (rounded < 0) return `-${display} pts vs baseline`
  return "Same as baseline"
}

function renderTestedLine(urlMapRaw) {
  if (!urlMapRaw) return null
  let parsed
  try {
    parsed = JSON.parse(urlMapRaw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const parts = Object.entries(parsed)
    .filter(([, value]) => typeof value === "string" && value.length > 0)
    .map(([host, value]) => {
      let previewHost
      try {
        previewHost = new URL(value).hostname
      } catch {
        previewHost = value
      }
      return `${host} → ${previewHost}`
    })
  if (parts.length === 0) return null
  return `Tested: ${parts.join(", ")}`
}

function formatSecondsDelta(seconds) {
  if (!Number.isFinite(seconds) || seconds === 0) return null
  const abs = Math.abs(seconds)
  let display
  if (abs >= 60) {
    const m = Math.floor(abs / 60)
    const s = Math.round(abs % 60)
    display = s > 0 ? `${m}m ${s}s` : `${m}m`
  } else {
    display = `${Math.round(abs)}s`
  }
  return seconds > 0 ? `+${display}` : `-${display}`
}

function formatCostDelta(usd) {
  if (!Number.isFinite(usd) || Math.abs(usd) < 0.005) return null
  const abs = Math.abs(usd).toFixed(2)
  return usd > 0 ? `+$${abs}` : `-$${abs}`
}

function formatCountDelta(n) {
  if (!Number.isFinite(n) || n === 0) return null
  return n > 0 ? `+${n}` : String(n)
}

function deriveDashboardUrl(report, statusUrl) {
  if (report && report.url) {
    return report.url.replace(/\/+$/, "").replace(/\/reports\/[^/]+$/, "")
  }
  if (!statusUrl) return null
  return statusUrl.replace(/\/+$/, "").replace(/\/api\/v1\/runs\/[^/]+$/, "")
}

// "completed" + null score means the agent didn't actually finish the task.
// Surface the highest-signal explanation the report carries — keyFinding
// matches the "KEY FINDING" line on the dashboard report page.
function dnfMessage(report, failureReason) {
  if (report && typeof report.keyFinding === "string" && report.keyFinding.trim()) {
    return report.keyFinding.trim()
  }
  if (report && report.summary && typeof report.summary.whatDidnt === "string" && report.summary.whatDidnt.trim()) {
    return report.summary.whatDidnt.trim()
  }
  if (report && typeof report.verdict === "string" && report.verdict.trim()) {
    return report.verdict.trim().split(/\r?\n/)[0]
  }
  if (failureReason) return String(failureReason)
  return "Task did not complete — no score recorded"
}

function renderScoreBlock(report, baseline) {
  if (!report || report.score == null) return null
  const bar = scoreBar(report.score)
  const hasBaseline = baseline && typeof baseline.score === "number"
  if (!hasBaseline) {
    return ["```", `  ${bar}`, "```"].join("\n")
  }
  const delta = report.score - baseline.score
  const rounded = Math.round(delta * 10) / 10
  const abs = Math.abs(rounded)
  const display = Number.isInteger(abs) ? String(abs) : abs.toFixed(1)
  let prefix
  let annotation
  if (rounded > 0) {
    prefix = "+"
    annotation = `▲ +${display} pts vs baseline`
  } else if (rounded < 0) {
    prefix = "-"
    annotation = `▼ -${display} pts vs baseline`
  } else {
    prefix = " "
    annotation = "Same as baseline"
  }
  return ["```diff", `${prefix} ${bar}   ${annotation}`, "```"].join("\n")
}

// Markdown table of the metrics the run reports, with ▼/▲ deltas where a
// baseline is available. Only columns the current run populates show up.
function renderMetricsTable(current, baseline) {
  if (!current || typeof current !== "object") return null
  const cols = []

  if (current.time) {
    let v = current.time
    if (baseline && typeof current.timeSeconds === "number" && typeof baseline.timeSeconds === "number") {
      const d = formatSecondsDelta(current.timeSeconds - baseline.timeSeconds)
      if (d) v += `  ${metricArrow(d)}`
    }
    cols.push({ header: "Time", value: v })
  }
  if (current.cost) {
    let v = current.cost
    if (baseline && typeof current.costUsd === "number" && typeof baseline.costUsd === "number") {
      const d = formatCostDelta(current.costUsd - baseline.costUsd)
      if (d) v += `  ${metricArrow(d)}`
    }
    cols.push({ header: "Cost", value: v })
  }
  if (typeof current.errors === "number") {
    let v = String(current.errors)
    if (baseline && typeof baseline.errors === "number") {
      const d = formatCountDelta(current.errors - baseline.errors)
      if (d) v += `  ${metricArrow(d)}`
    }
    cols.push({ header: "Errors", value: v })
  }
  if (typeof current.interruptions === "number") {
    let v = String(current.interruptions)
    if (baseline && typeof baseline.interruptions === "number") {
      const d = formatCountDelta(current.interruptions - baseline.interruptions)
      if (d) v += `  ${metricArrow(d)}`
    }
    cols.push({ header: "Interruptions", value: v })
  }

  if (cols.length === 0) return null
  const header = `| ${cols.map((c) => c.header).join(" | ")} |`
  const sep = `| ${cols.map(() => "---").join(" | ")} |`
  const row = `| ${cols.map((c) => c.value).join(" | ")} |`
  return [header, sep, row].join("\n")
}

// Client-side renderers — server returns minimal status now, action renders
// the comment + commit status from { status, prompt.title, report?, baseline?, failureReason }.
function renderComment({ status, promptTitle, statusUrl, runUrl, report, baseline, failureReason, sha, urlMapRaw }) {
  const title = promptTitle || "(unknown)"
  const sha7 = sha ? String(sha).slice(0, 7) : ""
  const statusLink = runUrl || statusUrl

  const footer = () => {
    const parts = []
    if (sha7) parts.push(`Commit \`${sha7}\``)
    if (statusLink) parts.push(`[Status →](${statusLink})`)
    return parts.length ? parts.join("  ·  ") : null
  }

  if (status === "failed") {
    const lines = [`### 2027 // ${title} — Eval failed`]
    if (failureReason) {
      lines.push("", "```diff", `- ${sanitizeForFence(singleLine(failureReason))}`, "```")
    }
    const foot = footer()
    if (foot) lines.push("", foot)
    return lines.join("\n")
  }

  if (status !== "completed" && status !== "superseded") {
    const lines = [
      `### 2027 // ${title} — Running…`,
      "",
      "```",
      "  ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒",
      "```",
    ]
    const foot = footer()
    if (foot) lines.push("", foot)
    return lines.join("\n")
  }

  if (status === "superseded") {
    const lines = [`### 2027 // ${title} — Superseded`]
    const foot = footer()
    if (foot) lines.push("", foot)
    return lines.join("\n")
  }

  // status === "completed"
  const hasScore = report && report.score != null && report.grade
  const heading = hasScore
    ? `### 2027 // ${title} — **${report.grade} ${report.score}/100**`
    : `### 2027 // ${title} — Did not finish`
  const lines = [heading]

  if (!hasScore) {
    const msg = sanitizeForFence(singleLine(dnfMessage(report, failureReason)))
    if (msg) lines.push("", "```diff", `- ${msg}`, "```")
  }

  const scoreBlock = renderScoreBlock(report, baseline)
  if (scoreBlock) lines.push("", scoreBlock)

  const table = renderMetricsTable(report && report.metrics, baseline && baseline.metrics)
  if (table) lines.push("", table)

  const tested = renderTestedLine(urlMapRaw)
  if (tested) lines.push("", tested)

  const tailParts = []
  if (sha7) tailParts.push(`Commit \`${sha7}\``)
  if (report && report.url) tailParts.push(`[View report →](${report.url})`)
  const dashboardUrl = deriveDashboardUrl(report, statusUrl)
  if (dashboardUrl) tailParts.push(`[Dashboard](${dashboardUrl})`)
  if (tailParts.length) lines.push("", tailParts.join("  ·  "))

  return lines.join("\n")
}

function renderCommitStatus({ status, statusUrl, runUrl, report, failureReason }) {
  const statusLink = runUrl || statusUrl
  if (status === "pending" || status === "running") {
    return { state: "pending", description: "Running eval...", targetUrl: statusLink }
  }
  if (status === "completed") {
    const hasScore = report && report.score != null
    if (!hasScore) {
      return {
        state: "failure",
        description: `Did not finish — ${dnfMessage(report, failureReason)}`,
        targetUrl: report?.url || statusLink,
      }
    }
    if (report?.url) {
      return { state: "success", description: "Completed — see report", targetUrl: report.url }
    }
    return { state: "success", description: "Completed — see status page", targetUrl: statusLink }
  }
  if (status === "failed") {
    // setCommitStatus handles singleLine + truncate; pass raw failureReason here.
    const description = failureReason || "Eval failed — see status page"
    return { state: "error", description, targetUrl: statusLink }
  }
  if (status === "superseded") {
    return { state: "success", description: "Superseded by newer commit", targetUrl: statusLink }
  }
  return { state: "pending", description: "Running eval...", targetUrl: statusLink }
}

function extractPrFromContext(context) {
  if (context.payload && context.payload.pull_request) {
    const pr = context.payload.pull_request
    return {
      number: pr.number,
      title: pr.title,
      branch: pr.head && pr.head.ref,
      sha: pr.head && pr.head.sha,
      headRepoFullName: pr.head && pr.head.repo && pr.head.repo.full_name,
    }
  }
  if (context.payload && context.payload.deployment_status && context.payload.deployment) {
    const d = context.payload.deployment
    return {
      number: undefined,
      title: undefined,
      branch: d.ref,
      sha: d.sha,
      headRepoFullName: undefined,
    }
  }
  return { number: undefined, title: undefined, branch: undefined, sha: context.sha, headRepoFullName: undefined }
}

// Baseline is computed client-side from the runs-list endpoint instead of
// being returned on the run response. We pick the most recent prior
// published run for the same prompt; the current run is filtered out by id
// because it may already be in the published list by the time we fetch.
async function fetchBaseline(apiBase, apiKey, promptId, currentRunId, core) {
  const url = `${apiBase}/api/v1/runs?promptId=${encodeURIComponent(promptId)}&reportStatus=published&limit=2`
  try {
    const list = await getJson(url, apiKey)
    if (!Array.isArray(list)) return null
    const prior = list.find(
      (r) => r && r.runId !== currentRunId && r.report && typeof r.report.score === "number",
    )
    if (!prior) return null
    return {
      score: prior.report.score,
      grade: prior.report.grade || null,
      metrics: prior.report.metrics || null,
    }
  } catch (e) {
    core.warning(`baseline fetch failed (rendering without delta): ${e.message}`)
    return null
  }
}

async function lookupPrBySha(github, owner, repo, sha) {
  try {
    const { data } = await github.rest.repos.listPullRequestsAssociatedWithCommit({ owner, repo, commit_sha: sha })
    const open = data.find((p) => p.state === "open") || data[0]
    if (!open) return null
    return {
      number: open.number,
      title: open.title,
      branch: open.head && open.head.ref,
      sha: open.head && open.head.sha,
      headRepoFullName: open.head && open.head.repo && open.head.repo.full_name,
    }
  } catch (e) {
    return null
  }
}

async function run({ core, github, context }) {
  const apiKey = process.env.EVALS_API_KEY
  const apiBase = (process.env.EVALS_API_BASE_URL || "https://2027.dev/evals").replace(/\/$/, "")
  const promptId = process.env.EVALS_PROMPT_ID || undefined
  const urlMapRaw = process.env.EVALS_URL_MAP || ""
  const templateVarsRaw = process.env.EVALS_TEMPLATE_VARS || ""
  const explicitDeploymentUrl = process.env.EVALS_DEPLOYMENT_URL || ""
  // Defaults here must match action.yml — they're only used if the script is
  // invoked outside the composite step (rare, but worth keeping consistent).
  const waitTimeoutMin = Number(process.env.EVALS_WAIT_TIMEOUT_MINUTES || "20")
  const pollIntervalS = Number(process.env.EVALS_POLL_INTERVAL_SECONDS || "20")
  const timeoutFails = String(process.env.EVALS_TIMEOUT_FAILS || "false").toLowerCase() === "true"
  const skipComment = String(process.env.EVALS_SKIP_COMMENT || "false").toLowerCase() === "true"
  const skipStatus = String(process.env.EVALS_SKIP_STATUS || "false").toLowerCase() === "true"

  core.info(`2027 eval action: API base=${apiBase}`)

  if (!apiKey) {
    core.setFailed("api-key input is required")
    return
  }
  if (!promptId) {
    core.setFailed("prompt-id input is required")
    return
  }
  if (!Number.isFinite(waitTimeoutMin) || waitTimeoutMin <= 0) {
    core.setFailed(`wait-timeout-minutes must be a positive number (got '${process.env.EVALS_WAIT_TIMEOUT_MINUTES}')`)
    return
  }
  if (!Number.isFinite(pollIntervalS) || pollIntervalS <= 0) {
    core.setFailed(`poll-interval-seconds must be a positive number (got '${process.env.EVALS_POLL_INTERVAL_SECONDS}')`)
    return
  }

  let urlMap
  try {
    urlMap = JSON.parse(urlMapRaw)
  } catch (e) {
    core.setFailed(`url-map must be valid JSON: ${e.message}`)
    return
  }
  if (typeof urlMap !== "object" || urlMap === null || Array.isArray(urlMap)) {
    core.setFailed("url-map must be a JSON object")
    return
  }

  let templateVars
  if (templateVarsRaw.trim()) {
    try {
      templateVars = JSON.parse(templateVarsRaw)
    } catch (e) {
      core.setFailed(`template-vars must be valid JSON: ${e.message}`)
      return
    }
    if (typeof templateVars !== "object" || templateVars === null || Array.isArray(templateVars)) {
      core.setFailed("template-vars must be a JSON object")
      return
    }
  }
  // An empty {} is treated as "not set" — both for the url-map check below
  // and for body construction, so the action never ships a no-op `templateVars: {}`.
  const hasTemplateVars = templateVars && Object.keys(templateVars).length > 0

  const urlMapEntries = Object.values(urlMap)
  if (urlMapEntries.length === 0 && !hasTemplateVars) {
    core.setFailed("url-map must have at least one entry (or set template-vars for prompts that use template variables instead of a preview URL)")
    return
  }
  // deployment-url is no longer sent to the server (it derives the deployment
  // from url-map), but we still validate the same disambiguation rule so the
  // workflow YAML stays consistent and surfaces config bugs early.
  if (!explicitDeploymentUrl && urlMapEntries.length > 1) {
    core.setFailed("url-map has multiple entries, set 'deployment-url' input explicitly to disambiguate")
    return
  }

  const owner = context.repo.owner
  const repo = context.repo.repo
  let prInfo = extractPrFromContext(context)
  if (!prInfo.number && prInfo.sha) {
    const found = await lookupPrBySha(github, owner, repo, prInfo.sha)
    if (found) prInfo = found
  }
  const prNumber = prInfo.number
  const sha = prInfo.sha
  if (!prNumber) {
    core.setFailed(
      "could not derive pull request number from event context (try a pull_request or deployment_status trigger)",
    )
    return
  }
  if (!sha) {
    core.setFailed("could not derive commit sha from event context")
    return
  }

  // Fork detection — GITHUB_TOKEN is read-only on PRs from forks, so comment
  // + status writes will 403. Bail before burning eval budget. This runs
  // after PR resolution so deployment_status events (which don't carry
  // head-repo info in the payload) are also covered via lookupPrBySha.
  const baseRepoFullName = `${owner}/${repo}`
  if (prInfo.headRepoFullName && prInfo.headRepoFullName !== baseRepoFullName) {
    core.warning(
      `PR is from a fork (${prInfo.headRepoFullName} → ${baseRepoFullName}). GITHUB_TOKEN is read-only on forked PRs and cannot post comments or commit statuses. ` +
        `Use a 'pull_request_target' trigger (carefully — runs with full secrets), or skip with: ` +
        `\`if: github.event.pull_request.head.repo.full_name == github.repository\`. Exiting without starting an eval.`,
    )
    return
  }

  const startUrl = `${apiBase}/api/v1/prompts/${encodeURIComponent(promptId)}/run`
  core.info(`starting eval at ${startUrl}`)
  let started
  try {
    // The user-facing input is named `template-vars` to match what users see
    // in the prompt config (`templateVars: ["cliInstall"]` is the declaration).
    // Over the wire the run endpoint takes the *args* that satisfy those vars,
    // hence `templateArgs` here. Drift on this name lands as `400 Missing
    // template vars` from the server (it strips unknown keys via zod, then the
    // missing-vars check fires) — so the contract test pins the wire name.
    const startBody = hasTemplateVars ? { urlMap, templateArgs: templateVars } : { urlMap }
    started = await postJsonWithRetry(startUrl, apiKey, startBody, { core })
  } catch (e) {
    core.setFailed(`failed to start eval: ${e.message}`)
    return
  }

  const runId = started.runId
  const statusUrl = started.statusUrl
  if (!runId) {
    core.setFailed(`start response missing runId: ${JSON.stringify(started)}`)
    return
  }
  core.setOutput("run-id", runId)
  core.setOutput("status-url", statusUrl)

  const runApiUrl = `${apiBase}/api/v1/runs/${encodeURIComponent(runId)}`
  const marker = STICKY_MARKER(promptId)
  let promptTitle
  // Human-facing dashboard URL for this run, returned by the API alongside
  // statusUrl. Optional — falls back to statusUrl in renderers if absent.
  let runUrl

  try {
    const initial = await getJson(runApiUrl, apiKey)
    promptTitle = initial.prompt && initial.prompt.title
    runUrl = initial.runUrl
  } catch (e) {
    if (e instanceof HttpStatusError && [401, 403, 404].includes(e.status)) {
      core.setFailed(`fatal auth/lookup error fetching initial run state: ${e.message}`)
      return
    }
    core.warning(`could not fetch initial run state: ${e.message}`)
  }

  const ctxName = deriveContext(promptTitle, promptId)

  if (!skipComment) {
    await upsertComment(
      github,
      owner,
      repo,
      prNumber,
      marker,
      renderComment({ status: "pending", promptTitle, statusUrl, runUrl, report: null, baseline: null, failureReason: null, sha, urlMapRaw }),
      core,
    )
  }
  if (!skipStatus) {
    try {
      const initialStatus = renderCommitStatus({ status: "pending", statusUrl, runUrl, report: null, failureReason: null })
      await setCommitStatus(github, owner, repo, sha, { ...initialStatus, context: ctxName })
    } catch (e) {
      core.warning(`failed to set initial commit status: ${e.message}`)
    }
  }

  const deadline = Date.now() + waitTimeoutMin * 60 * 1000
  let last = null
  let backoffSec = pollIntervalS
  const MAX_BACKOFF_SEC = 60

  while (Date.now() < deadline) {
    // Cap sleep at remaining-time so we don't burn past the deadline on a
    // single long backoff (especially after a Retry-After bump).
    const remainingMs = deadline - Date.now()
    const sleepMs = Math.min(jitter(backoffSec * 1000), Math.max(0, remainingMs))
    await sleep(sleepMs)
    if (Date.now() >= deadline) break
    let current
    try {
      current = await getJson(runApiUrl, apiKey)
      backoffSec = pollIntervalS // reset on success
      runUrl = current.runUrl || runUrl
    } catch (e) {
      if (e instanceof HttpStatusError) {
        if ([401, 403, 404].includes(e.status)) {
          core.setFailed(`fatal error during polling: ${e.message}`)
          return
        }
        if (e.retryAfter) {
          const retryAfterSec = Number(e.retryAfter)
          if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
            backoffSec = Math.min(MAX_BACKOFF_SEC, Math.max(pollIntervalS, retryAfterSec))
            core.warning(`poll failed (${e.status}), honoring Retry-After=${retryAfterSec}s: ${e.message}`)
            continue
          }
        }
      }
      backoffSec = Math.min(MAX_BACKOFF_SEC, backoffSec * 2)
      core.warning(`poll failed, backing off to ${backoffSec}s: ${e.message}`)
      continue
    }
    last = current
    promptTitle = (current.prompt && current.prompt.title) || promptTitle
    const status = current.status
    if (status === "completed" || status === "failed" || status === "superseded") {
      // Race window: the queue writes eval_runs.status='completed' before it
      // back-fills reportSlug from the upload pipeline. If we caught the run
      // mid-handoff, do a few short grace polls so we can render the report
      // link instead of the API-only status page. Tracked in team2027/evals#136.
      if (status === "completed" && !current.report && !current.failureReason) {
        const GRACE_POLLS = 3
        const GRACE_INTERVAL_MS = 5000
        core.info("status=completed but report not yet linked — grace-polling for back-fill...")
        for (let i = 0; i < GRACE_POLLS; i++) {
          await sleep(GRACE_INTERVAL_MS)
          try {
            const retry = await getJson(runApiUrl, apiKey)
            last = retry
            runUrl = retry.runUrl || runUrl
            if (retry.report || retry.failureReason) break
          } catch (e) {
            core.warning(`grace-period poll failed (ignoring): ${e.message}`)
          }
        }
      }
      break
    }
  }

  const finalStatus = (last && last.status) || "pending"
  const report = (last && last.report) || null
  const failureReason = (last && last.failureReason) || null

  // Baseline is meaningful only when we have a fresh score to diff against.
  // Skip the extra round-trip on failed/superseded/timeout paths.
  const baseline =
    finalStatus === "completed" && report && typeof report.score === "number"
      ? await fetchBaseline(apiBase, apiKey, promptId, runId, core)
      : null

  // Emit outputs unconditionally so consumers can render their own comment/status
  // even when the built-in renderers are disabled via skip-comment / skip-status.
  core.setOutput("final-status", finalStatus === "pending" ? "running" : finalStatus)
  core.setOutput("prompt-title", promptTitle || "")
  core.setOutput("report-slug", (report && report.slug) || "")
  core.setOutput("report-url", (report && report.url) || "")
  core.setOutput("failure-reason", failureReason || "")
  core.setOutput("score", (report && report.score != null) ? String(report.score) : "")
  core.setOutput("grade", (report && report.grade) || "")
  core.setOutput("baseline-score", (baseline && baseline.score != null) ? String(baseline.score) : "")
  core.setOutput("report-json", report ? JSON.stringify(report) : "")
  core.setOutput("baseline-json", baseline ? JSON.stringify(baseline) : "")

  if (finalStatus === "completed" || finalStatus === "failed" || finalStatus === "superseded") {
    if (!skipComment) {
      const body = renderComment({ status: finalStatus, promptTitle, statusUrl, runUrl, report, baseline, failureReason, sha, urlMapRaw })
      await upsertComment(github, owner, repo, prNumber, marker, body, core)
    }
    if (!skipStatus) {
      const cs = renderCommitStatus({ status: finalStatus, statusUrl, runUrl, report, failureReason })
      try {
        await setCommitStatus(github, owner, repo, sha, { ...cs, context: ctxName })
      } catch (e) {
        core.warning(`failed to set final commit status: ${e.message}`)
      }
    }
    if (finalStatus === "failed") {
      core.setFailed(`eval failed: ${failureReason || "unknown failure"}`)
    }
    return
  }

  // timeout — still running. Keep PR check unblocked unless timeout-fails=true.
  if (!skipComment) {
    const timeoutBody = renderComment({ status: "running", promptTitle, statusUrl, runUrl, report: null, baseline: null, failureReason: null, sha, urlMapRaw })
    await upsertComment(github, owner, repo, prNumber, marker, timeoutBody, core)
  }
  const timeoutState = timeoutFails ? "failure" : "success"
  const timeoutDescription = timeoutFails
    ? "Eval timed out — failing per timeout-fails=true"
    : "Still running — see status page"
  if (!skipStatus) {
    try {
      await setCommitStatus(github, owner, repo, sha, {
        state: timeoutState,
        description: timeoutDescription,
        targetUrl: runUrl || statusUrl,
        context: ctxName,
      })
    } catch (e) {
      core.warning(`failed to set timeout commit status: ${e.message}`)
    }
  }
  core.info(
    `timeout reached after ${waitTimeoutMin} min — commit status would be '${timeoutState}' (timeout-fails=${timeoutFails})${skipStatus ? " [skipped]" : ""}`,
  )
}

module.exports = run
module.exports.renderComment = renderComment
module.exports.renderCommitStatus = renderCommitStatus
module.exports.formatDelta = formatDelta
module.exports.renderTestedLine = renderTestedLine
module.exports.deriveDashboardUrl = deriveDashboardUrl
module.exports.renderMetricsTable = renderMetricsTable
module.exports.formatSecondsDelta = formatSecondsDelta
module.exports.formatCostDelta = formatCostDelta
module.exports.formatCountDelta = formatCountDelta

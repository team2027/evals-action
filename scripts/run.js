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

async function findStickyComment(github, owner, repo, prNumber, marker) {
  for (let page = 1; page < 10; page++) {
    const { data } = await github.rest.issues.listComments({
      owner,
      repo,
      issue_number: prNumber,
      per_page: 100,
      page,
    })
    const found = data.find((c) => c.body && c.body.includes(marker))
    if (found) return found
    if (data.length < 100) break
  }
  return null
}

async function upsertComment(github, owner, repo, prNumber, marker, body) {
  const fullBody = body.includes(marker) ? body : `${marker}\n${body}`
  const existing = await findStickyComment(github, owner, repo, prNumber, marker)
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
    description: truncate(params.description || "", STATUS_DESC_MAX),
    target_url: params.targetUrl,
    context: params.context,
  })
}

// Client-side renderers — server returns minimal status now, action renders
// the comment + commit status from { status, prompt.title, report?, failureReason }.
function renderComment({ status, promptTitle, statusUrl, report, failureReason }) {
  const title = promptTitle || "(unknown)"
  if (status === "pending" || status === "running") {
    return `🔄 Running eval for **${title}** — [status page](${statusUrl})`
  }
  if (status === "completed") {
    if (report?.url) {
      return `✅ Eval complete for **${title}** — [view report](${report.url})`
    }
    return `✅ Eval complete for **${title}** — [status page](${statusUrl})`
  }
  if (status === "failed") {
    const reason = failureReason || "see status page"
    return `❌ Eval failed for **${title}**: ${reason}\n\n[status page](${statusUrl})`
  }
  if (status === "superseded") {
    return `↻ Eval superseded — [status page](${statusUrl})`
  }
  // Treat any unknown status as still-running so the comment stays informative.
  return `🔄 Running eval for **${title}** — [status page](${statusUrl})`
}

function renderCommitStatus({ status, statusUrl, report, failureReason }) {
  if (status === "pending" || status === "running") {
    return { state: "pending", description: "Running eval...", targetUrl: statusUrl }
  }
  if (status === "completed") {
    if (report?.url) {
      return { state: "success", description: "Completed — see report", targetUrl: report.url }
    }
    return { state: "success", description: "Completed — see status page", targetUrl: statusUrl }
  }
  if (status === "failed") {
    const description = failureReason
      ? truncate(failureReason, STATUS_DESC_MAX)
      : "Eval failed — see status page"
    return { state: "error", description, targetUrl: statusUrl }
  }
  if (status === "superseded") {
    return { state: "success", description: "Superseded by newer commit", targetUrl: statusUrl }
  }
  return { state: "pending", description: "Running eval...", targetUrl: statusUrl }
}

function extractPrFromContext(context) {
  if (context.payload && context.payload.pull_request) {
    const pr = context.payload.pull_request
    return {
      number: pr.number,
      title: pr.title,
      branch: pr.head && pr.head.ref,
      sha: pr.head && pr.head.sha,
    }
  }
  if (context.payload && context.payload.deployment_status && context.payload.deployment) {
    const d = context.payload.deployment
    return {
      number: undefined,
      title: undefined,
      branch: d.ref,
      sha: d.sha,
    }
  }
  return { number: undefined, title: undefined, branch: undefined, sha: context.sha }
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
    }
  } catch (e) {
    return null
  }
}

module.exports = async function run({ core, github, context }) {
  const apiKey = process.env.EVALS_API_KEY
  const apiBase = (process.env.EVALS_API_BASE_URL || "https://2027.dev/evals").replace(/\/$/, "")
  const promptId = process.env.EVALS_PROMPT_ID || undefined
  const urlMapRaw = process.env.EVALS_URL_MAP || ""
  const explicitDeploymentUrl = process.env.EVALS_DEPLOYMENT_URL || ""
  const waitTimeoutMin = Number(process.env.EVALS_WAIT_TIMEOUT_MINUTES || "5")
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

  // Fork detection — GITHUB_TOKEN is read-only on PRs from forks, so
  // comment + status writes will 403. Bail before burning eval budget.
  const headRepoFullName = context.payload?.pull_request?.head?.repo?.full_name
  const baseRepoFullName = `${context.repo.owner}/${context.repo.repo}`
  if (headRepoFullName && headRepoFullName !== baseRepoFullName) {
    core.warning(
      `PR is from a fork (${headRepoFullName} → ${baseRepoFullName}). GITHUB_TOKEN is read-only on forked PRs and cannot post comments or commit statuses. ` +
        `Use a 'pull_request_target' trigger (carefully — runs with full secrets), or skip with: ` +
        `\`if: github.event.pull_request.head.repo.full_name == github.repository\`. Exiting without starting an eval.`,
    )
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

  const urlMapEntries = Object.values(urlMap)
  if (urlMapEntries.length === 0) {
    core.setFailed("url-map must have at least one entry")
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

  const startUrl = `${apiBase}/api/v1/prompts/${encodeURIComponent(promptId)}/run`
  core.info(`starting eval at ${startUrl}`)
  let started
  try {
    started = await postJson(startUrl, apiKey, { urlMap })
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

  const runUrl = `${apiBase}/api/v1/runs/${encodeURIComponent(runId)}`
  const marker = STICKY_MARKER(promptId)
  let promptTitle

  try {
    const initial = await getJson(runUrl, apiKey)
    promptTitle = initial.prompt && initial.prompt.title
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
      renderComment({ status: "pending", promptTitle, statusUrl, report: null, failureReason: null }),
    )
  }
  if (!skipStatus) {
    try {
      const initialStatus = renderCommitStatus({ status: "pending", statusUrl, report: null, failureReason: null })
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
    await sleep(jitter(backoffSec * 1000))
    let current
    try {
      current = await getJson(runUrl, apiKey)
      backoffSec = pollIntervalS // reset on success
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
            const retry = await getJson(runUrl, apiKey)
            last = retry
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

  // Emit outputs unconditionally so consumers can render their own comment/status
  // even when the built-in renderers are disabled via skip-comment / skip-status.
  core.setOutput("final-status", finalStatus === "pending" ? "running" : finalStatus)
  core.setOutput("prompt-title", promptTitle || "")
  core.setOutput("report-slug", (report && report.slug) || "")
  core.setOutput("report-url", (report && report.url) || "")
  core.setOutput("failure-reason", failureReason || "")

  if (finalStatus === "completed" || finalStatus === "failed" || finalStatus === "superseded") {
    if (!skipComment) {
      const body = renderComment({ status: finalStatus, promptTitle, statusUrl, report, failureReason })
      await upsertComment(github, owner, repo, prNumber, marker, body)
    }
    if (!skipStatus) {
      const cs = renderCommitStatus({ status: finalStatus, statusUrl, report, failureReason })
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
    const timeoutBody = renderComment({ status: "running", promptTitle, statusUrl, report: null, failureReason: null })
    await upsertComment(github, owner, repo, prNumber, marker, timeoutBody)
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
        targetUrl: statusUrl,
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

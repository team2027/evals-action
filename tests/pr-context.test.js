// PR-resolution tests: covers the three event shapes the action understands
// (pull_request, deployment_status, issue_comment) and the API fallbacks that
// fill in missing sha/branch fields. issue_comment is the interesting case —
// the payload only carries the PR number, so we round-trip through
// pulls.get() to learn the head sha + branch.

const test = require("node:test")
const assert = require("node:assert/strict")

const RUN_PATH = require.resolve("../scripts/run.js")

function freshRun() {
  delete require.cache[RUN_PATH]
  return require(RUN_PATH)
}

function makeCore() {
  const calls = { failed: [], outputs: {}, warnings: [], info: [] }
  return {
    calls,
    setFailed: (m) => calls.failed.push(m),
    setOutput: (k, v) => { calls.outputs[k] = v },
    warning: (m) => calls.warnings.push(m),
    info: (m) => calls.info.push(m),
  }
}

function makeGithub({ pullsGet } = {}) {
  const calls = { comments: [], statuses: [], pullsGet: [] }
  return {
    calls,
    rest: {
      issues: {
        listComments: async () => ({ data: [] }),
        createComment: async (params) => { calls.comments.push(params); return { data: { id: 1 } } },
        updateComment: async (params) => { calls.comments.push(params); return { data: { id: 1 } } },
      },
      repos: {
        createCommitStatus: async (params) => { calls.statuses.push(params) },
        listPullRequestsAssociatedWithCommit: async () => ({ data: [] }),
      },
      pulls: {
        get: async (params) => {
          calls.pullsGet.push(params)
          if (pullsGet) return pullsGet(params)
          throw new Error("pulls.get not stubbed for this test")
        },
      },
    },
  }
}

function installFetch(scripted) {
  const captured = []
  const original = global.fetch
  global.fetch = async (url, init) => {
    captured.push({ url, init })
    const handler = scripted.find((s) => url.includes(s.match))
    if (!handler) throw new Error(`unexpected fetch: ${url}`)
    return {
      ok: handler.ok !== false,
      status: handler.status || 200,
      headers: { get: () => null },
      text: async () => JSON.stringify(handler.body || {}),
    }
  }
  return { captured, restore: () => { global.fetch = original } }
}

function setEnv(env) {
  for (const k of Object.keys(env)) process.env[k] = env[k]
}

function clearEnv() {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("EVALS_")) delete process.env[k]
  }
}

const BASE_ENV = {
  EVALS_API_KEY: "sk-test",
  EVALS_PROMPT_ID: "p-1",
  EVALS_URL_MAP: '{"acme.com":"https://preview.fly.dev"}',
  EVALS_WAIT_TIMEOUT_MINUTES: "1",
  EVALS_POLL_INTERVAL_SECONDS: "1",
}

const COMPLETED_RUN = {
  match: "/runs/r-1",
  body: { runId: "r-1", status: "completed", prompt: { title: "T" }, report: { score: 80, grade: "B" } },
}
const START_OK = {
  match: "/prompts/p-1/run",
  body: { runId: "r-1", statusUrl: "https://x/api/v1/runs/r-1", runUrl: "https://x/acme/runs/r-1" },
}
const NO_BASELINE = { match: "/runs?promptId=", body: [] }

test("issue_comment event resolves PR via pulls.get and starts the eval", async (t) => {
  clearEnv()
  setEnv(BASE_ENV)
  const { restore } = installFetch([START_OK, COMPLETED_RUN, NO_BASELINE])
  t.after(restore)

  const github = makeGithub({
    pullsGet: async ({ pull_number }) => ({
      data: {
        number: pull_number,
        title: "test pr",
        head: { ref: "feat/x", sha: "deadbeef", repo: { full_name: "acme/web" } },
      },
    }),
  })
  const context = {
    repo: { owner: "acme", repo: "web" },
    sha: undefined,
    payload: {
      issue: {
        number: 42,
        title: "test pr",
        pull_request: { url: "https://api.github.com/repos/acme/web/pulls/42" },
      },
      comment: { body: "trigger: preview" },
    },
  }

  const run = freshRun()
  const core = makeCore()
  await run({ core, github, context })

  assert.deepEqual(core.calls.failed, [], `unexpected setFailed: ${core.calls.failed.join(" | ")}`)
  assert.deepEqual(github.calls.pullsGet, [{ owner: "acme", repo: "web", pull_number: 42 }])
  // Sticky comment + commit statuses (pending → terminal) both wired with the
  // resolved sha/number from the API lookup, not the empty payload.
  assert.ok(github.calls.statuses.length >= 1)
  for (const s of github.calls.statuses) assert.equal(s.sha, "deadbeef")
  assert.equal(github.calls.comments[0].issue_number, 42)
})

test("issue_comment on a plain issue (not a PR) bails with a helpful error", async (t) => {
  clearEnv()
  setEnv(BASE_ENV)
  const { restore } = installFetch([])
  t.after(restore)

  const github = makeGithub()
  const context = {
    repo: { owner: "acme", repo: "web" },
    sha: undefined,
    payload: {
      issue: { number: 99, title: "bug report" /* no pull_request key */ },
      comment: { body: "trigger: preview" },
    },
  }

  const run = freshRun()
  const core = makeCore()
  await run({ core, github, context })

  assert.equal(core.calls.failed.length, 1)
  assert.match(core.calls.failed[0], /could not derive pull request number/)
  assert.match(core.calls.failed[0], /issue_comment/)
  assert.equal(github.calls.pullsGet.length, 0, "must not API-call for non-PR issues")
})

test("issue_comment on a fork PR exits cleanly without starting an eval", async (t) => {
  clearEnv()
  setEnv(BASE_ENV)
  const { captured, restore } = installFetch([])
  t.after(restore)

  const github = makeGithub({
    pullsGet: async () => ({
      data: {
        number: 7,
        title: "from a fork",
        head: { ref: "patch", sha: "f00", repo: { full_name: "outsider/web" } },
      },
    }),
  })
  const context = {
    repo: { owner: "acme", repo: "web" },
    sha: undefined,
    payload: {
      issue: { number: 7, pull_request: { url: "..." } },
      comment: { body: "trigger: preview" },
    },
  }

  const run = freshRun()
  const core = makeCore()
  await run({ core, github, context })

  assert.deepEqual(core.calls.failed, [], "fork bail is a warning, not a failure")
  assert.equal(captured.length, 0, "must not POST to the evals API for fork PRs")
  assert.equal(github.calls.statuses.length, 0)
  assert.match(core.calls.warnings.join(" | "), /fork/i)
})

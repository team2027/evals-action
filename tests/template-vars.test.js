// Unit tests for template-vars wiring: validates request-body shape, input
// validation, and the relaxed url-map check. Stubs global fetch + the github
// octokit so we exercise scripts/run.js end-to-end without network.

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

function makeGithub() {
  const calls = { comments: [], statuses: [] }
  return {
    calls,
    rest: {
      issues: {
        listComments: async () => ({ data: [] }),
        createComment: async (params) => {
          calls.comments.push(params)
          return { data: { id: 1 } }
        },
        updateComment: async (params) => {
          calls.comments.push(params)
          return { data: { id: 1 } }
        },
      },
      repos: {
        createCommitStatus: async (params) => { calls.statuses.push(params) },
        listPullRequestsAssociatedWithCommit: async () => ({ data: [] }),
      },
    },
  }
}

function makeContext() {
  return {
    repo: { owner: "acme", repo: "web" },
    sha: "abcdef1234567890",
    payload: {
      pull_request: {
        number: 42,
        title: "test pr",
        head: { ref: "feat/x", sha: "abcdef1234567890", repo: { full_name: "acme/web" } },
      },
    },
  }
}

// Capture every fetch call, return scripted JSON responses by URL substring.
// Returns { captured, restore } — call restore() in t.after to put the real
// fetch back so a later test that needs it doesn't silently get the stub.
function installFetch(scripted) {
  const captured = []
  const original = global.fetch
  global.fetch = async (url, init) => {
    captured.push({ url, init })
    const handler = scripted.find((s) => url.includes(s.match))
    if (!handler) throw new Error(`unexpected fetch: ${url}`)
    const body = handler.body || {}
    return {
      ok: handler.ok !== false,
      status: handler.status || 200,
      headers: { get: () => null },
      text: async () => JSON.stringify(body),
    }
  }
  const restore = () => { global.fetch = original }
  return { captured, restore }
}

function setEnv(env) {
  for (const k of Object.keys(env)) process.env[k] = env[k]
}

function clearEnv() {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("EVALS_")) delete process.env[k]
  }
}

test("POST /run body sends template values under the server's wire name `templateArgs`", async (t) => {
  clearEnv()
  setEnv({
    EVALS_API_KEY: "sk-test",
    EVALS_PROMPT_ID: "p-1",
    EVALS_URL_MAP: '{"acme.com":"https://preview.fly.dev"}',
    EVALS_TEMPLATE_VARS: '{"cliInstall":"npm i -g https://pkg.pr.new/x"}',
    EVALS_WAIT_TIMEOUT_MINUTES: "1",
    EVALS_POLL_INTERVAL_SECONDS: "1",
  })
  const { captured, restore } = installFetch([
    { match: "/prompts/p-1/run", body: { runId: "r-1", statusUrl: "https://x/api/v1/runs/r-1" } },
    { match: "/runs/r-1", body: { runId: "r-1", status: "completed", prompt: { title: "T" }, report: { score: 80, grade: "B" } } },
    { match: "/runs?promptId=", body: [] },
  ])
  t.after(restore)

  const run = freshRun()
  const core = makeCore()
  await run({ core, github: makeGithub(), context: makeContext() })

  assert.deepEqual(core.calls.failed, [], `unexpected setFailed: ${core.calls.failed.join(" | ")}`)
  const post = captured.find((c) => c.init && c.init.method === "POST" && c.url.includes("/prompts/p-1/run"))
  assert.ok(post, "no POST to /prompts/p-1/run captured")
  const body = JSON.parse(post.init.body)
  assert.deepEqual(body.urlMap, { "acme.com": "https://preview.fly.dev" })
  assert.deepEqual(body.templateArgs, { cliInstall: "npm i -g https://pkg.pr.new/x" })
  // Guard against accidentally re-introducing the legacy field name that the
  // server's zod schema strips, which surfaced as `400 Missing template vars`
  // (issue #6). If anyone renames the wire field back to `templateVars` this
  // assertion catches it before it ships to a real prompt.
  assert.equal("templateVars" in body, false, "must not send the legacy `templateVars` field name")
})

test("POST /run body omits templateArgs when input is an empty object (validator and builder agree)", async (t) => {
  clearEnv()
  setEnv({
    EVALS_API_KEY: "sk-test",
    EVALS_PROMPT_ID: "p-1",
    EVALS_URL_MAP: '{"acme.com":"https://preview.fly.dev"}',
    EVALS_TEMPLATE_VARS: "{}",
    EVALS_WAIT_TIMEOUT_MINUTES: "1",
    EVALS_POLL_INTERVAL_SECONDS: "1",
  })
  const { captured, restore } = installFetch([
    { match: "/prompts/p-1/run", body: { runId: "r-1", statusUrl: "https://x/api/v1/runs/r-1" } },
    { match: "/runs/r-1", body: { runId: "r-1", status: "completed", prompt: { title: "T" }, report: { score: 80, grade: "B" } } },
    { match: "/runs?promptId=", body: [] },
  ])
  t.after(restore)

  const run = freshRun()
  const core = makeCore()
  await run({ core, github: makeGithub(), context: makeContext() })

  const post = captured.find((c) => c.init && c.init.method === "POST")
  const body = JSON.parse(post.init.body)
  assert.deepEqual(body, { urlMap: { "acme.com": "https://preview.fly.dev" } })
  assert.equal("templateArgs" in body, false, "empty {} must not leak into the request body")
  assert.equal("templateVars" in body, false)
})

test("POST /run body omits templateArgs when input is empty (back-compat)", async (t) => {
  clearEnv()
  setEnv({
    EVALS_API_KEY: "sk-test",
    EVALS_PROMPT_ID: "p-1",
    EVALS_URL_MAP: '{"acme.com":"https://preview.fly.dev"}',
    EVALS_WAIT_TIMEOUT_MINUTES: "1",
    EVALS_POLL_INTERVAL_SECONDS: "1",
  })
  const { captured, restore } = installFetch([
    { match: "/prompts/p-1/run", body: { runId: "r-1", statusUrl: "https://x/api/v1/runs/r-1" } },
    { match: "/runs/r-1", body: { runId: "r-1", status: "completed", prompt: { title: "T" }, report: { score: 80, grade: "B" } } },
    { match: "/runs?promptId=", body: [] },
  ])
  t.after(restore)

  const run = freshRun()
  const core = makeCore()
  await run({ core, github: makeGithub(), context: makeContext() })

  const post = captured.find((c) => c.init && c.init.method === "POST")
  const body = JSON.parse(post.init.body)
  assert.deepEqual(body, { urlMap: { "acme.com": "https://preview.fly.dev" } })
  assert.equal("templateArgs" in body, false)
})

test("template-vars accepts empty url-map (CLI / non-URL evals)", async (t) => {
  clearEnv()
  setEnv({
    EVALS_API_KEY: "sk-test",
    EVALS_PROMPT_ID: "p-1",
    EVALS_URL_MAP: "{}",
    EVALS_TEMPLATE_VARS: '{"cliInstall":"npm i -g foo"}',
    EVALS_WAIT_TIMEOUT_MINUTES: "1",
    EVALS_POLL_INTERVAL_SECONDS: "1",
  })
  const { captured, restore } = installFetch([
    { match: "/prompts/p-1/run", body: { runId: "r-1", statusUrl: "https://x/api/v1/runs/r-1" } },
    { match: "/runs/r-1", body: { runId: "r-1", status: "completed", prompt: { title: "T" }, report: { score: 80, grade: "B" } } },
    { match: "/runs?promptId=", body: [] },
  ])
  t.after(restore)

  const run = freshRun()
  const core = makeCore()
  await run({ core, github: makeGithub(), context: makeContext() })

  assert.deepEqual(core.calls.failed, [], `unexpected setFailed: ${core.calls.failed.join(" | ")}`)
  const post = captured.find((c) => c.init && c.init.method === "POST")
  const body = JSON.parse(post.init.body)
  assert.deepEqual(body.urlMap, {})
  assert.deepEqual(body.templateArgs, { cliInstall: "npm i -g foo" })
})

test("empty url-map without template-vars still fails fast", async (t) => {
  clearEnv()
  setEnv({
    EVALS_API_KEY: "sk-test",
    EVALS_PROMPT_ID: "p-1",
    EVALS_URL_MAP: "{}",
    EVALS_WAIT_TIMEOUT_MINUTES: "1",
    EVALS_POLL_INTERVAL_SECONDS: "1",
  })
  const { restore } = installFetch([])
  t.after(restore)

  const run = freshRun()
  const core = makeCore()
  await run({ core, github: makeGithub(), context: makeContext() })

  assert.equal(core.calls.failed.length, 1)
  assert.match(core.calls.failed[0], /url-map must have at least one entry/)
  assert.match(core.calls.failed[0], /template-vars/)
})

test("empty url-map with empty template-vars object also fails fast (no silent {} pass-through)", async (t) => {
  clearEnv()
  setEnv({
    EVALS_API_KEY: "sk-test",
    EVALS_PROMPT_ID: "p-1",
    EVALS_URL_MAP: "{}",
    EVALS_TEMPLATE_VARS: "{}",
    EVALS_WAIT_TIMEOUT_MINUTES: "1",
    EVALS_POLL_INTERVAL_SECONDS: "1",
  })
  const { captured, restore } = installFetch([])
  t.after(restore)

  const run = freshRun()
  const core = makeCore()
  await run({ core, github: makeGithub(), context: makeContext() })

  assert.equal(core.calls.failed.length, 1)
  assert.match(core.calls.failed[0], /url-map must have at least one entry/)
  assert.equal(captured.length, 0, "must not POST when both inputs are empty")
})

test("template-vars rejects invalid JSON", async (t) => {
  clearEnv()
  setEnv({
    EVALS_API_KEY: "sk-test",
    EVALS_PROMPT_ID: "p-1",
    EVALS_URL_MAP: '{"acme.com":"https://x"}',
    EVALS_TEMPLATE_VARS: "not-json",
    EVALS_WAIT_TIMEOUT_MINUTES: "1",
    EVALS_POLL_INTERVAL_SECONDS: "1",
  })
  const { restore } = installFetch([])
  t.after(restore)

  const run = freshRun()
  const core = makeCore()
  await run({ core, github: makeGithub(), context: makeContext() })

  assert.equal(core.calls.failed.length, 1)
  assert.match(core.calls.failed[0], /template-vars must be valid JSON/)
})

test("template-vars rejects non-object JSON (array / scalar)", async (t) => {
  const { restore } = installFetch([])
  t.after(restore)

  for (const raw of ['["a","b"]', '"a string"', "42"]) {
    clearEnv()
    setEnv({
      EVALS_API_KEY: "sk-test",
      EVALS_PROMPT_ID: "p-1",
      EVALS_URL_MAP: '{"acme.com":"https://x"}',
      EVALS_TEMPLATE_VARS: raw,
      EVALS_WAIT_TIMEOUT_MINUTES: "1",
      EVALS_POLL_INTERVAL_SECONDS: "1",
    })

    const run = freshRun()
    const core = makeCore()
    await run({ core, github: makeGithub(), context: makeContext() })

    assert.equal(core.calls.failed.length, 1, `should fail for raw=${raw}`)
    assert.match(core.calls.failed[0], /template-vars must be a JSON object/)
  }
})

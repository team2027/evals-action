# 2027 Evals — GitHub Action

Self-hostable GitHub Action that runs a [2027.dev/evals](https://2027.dev/evals)
agent-experience eval against your PR's preview deployment, then posts the
result as a sticky PR comment + commit status.

## When to use this

Use this action if you want to keep GitHub creds inside your own runners and
avoid installing the managed `2027-evals` GitHub App. The action authenticates
to 2027 with a per-org API key; the runtime `GITHUB_TOKEN` posts the comment
and commit status.

If you'd rather we manage everything end-to-end, install the
[2027 Evals GitHub App](https://github.com/apps/2027-evals) instead — same UX,
no workflow YAML required.

## Pull requests from forks

`GITHUB_TOKEN` is read-only on PRs from forked repositories, which means the
action cannot post comments or commit statuses. The action detects this case
and exits cleanly without starting an eval (so you don't burn budget on a
no-op).

If you want evals on fork PRs, you have two options:

1. **`pull_request_target` trigger.** Runs in the context of the base repo
   with full secrets and a writable token. Read GitHub's
   [security advisory](https://securitylab.github.com/research/github-actions-preventing-pwn-requests/)
   first — `pull_request_target` is dangerous if you check out untrusted code.
2. **Skip the action on fork PRs.** Add this guard:
   ```yaml
   if: github.event.pull_request.head.repo.full_name == github.repository
   ```

## Quickstart

### 1. Create an API key

Go to `https://2027.dev/evals/<orgDomain>/settings`, scroll to **API Keys**,
name it (e.g. `CI pipeline`) and click **Create key**. The key is shown once —
copy it and save it as `EVALS_API_KEY` in your repo secrets
(`Settings → Secrets and variables → Actions`).

### 2. Find your `prompt-id`

Open your prompt in the dashboard
(`https://2027.dev/evals/<orgDomain>/prompts/<id>`) and copy the UUID from the
prompt-id block under the title.

You can also list all prompt IDs via the API:

```bash
curl -H "Authorization: Bearer $EVALS_API_KEY" \
  https://2027.dev/evals/api/v1/prompts
```

### 3. Add a workflow

Pick the recipe that matches your preview platform:

| Platform / use case | Recipe |
|---------------------|--------|
| Vercel, Mintlify, anything using GitHub's [Deployments API](https://docs.github.com/en/rest/deployments) | `on: deployment_status` (below) |
| Netlify | `on: status` with context filter (below) |
| Anything else, or you want full control | Run after your own deploy step (below) |
| Manual re-run from a PR (label or comment mention) | `on: pull_request: [labeled]` + `issue_comment` (below) |

#### Vercel / Mintlify (`on: deployment_status`)

Triggers on the platform's success deployment event — `target_url` is the preview URL.

```yaml
# .github/workflows/eval.yml
name: 2027 eval
on:
  deployment_status:
jobs:
  eval:
    if: github.event.deployment_status.state == 'success'
    runs-on: ubuntu-latest
    permissions:
      contents: read        # for actions/checkout
      pull-requests: write  # sticky PR comment
      statuses: write       # commit status check
    steps:
      - uses: actions/checkout@v6
      - uses: team2027/evals-action@v0.2.0
        with:
          api-key: ${{ secrets.EVALS_API_KEY }}
          prompt-id: 12345678-1234-1234-1234-1234567890ab
          url-map: |
            { "acme.com": "${{ github.event.deployment_status.target_url }}" }
```

#### Netlify (`on: status`)

Netlify posts a legacy commit status (not a Deployment), so we trigger on `status` events and filter by context.

```yaml
name: 2027 eval
on:
  status:
jobs:
  eval:
    if: |
      github.event.state == 'success' &&
      contains(github.event.context, 'netlify/deploy-preview')
    runs-on: ubuntu-latest
    permissions:
      contents: read        # for actions/checkout
      pull-requests: write  # sticky PR comment
      statuses: write       # commit status check
    steps:
      - uses: actions/checkout@v6
      - uses: team2027/evals-action@v0.2.0
        with:
          api-key: ${{ secrets.EVALS_API_KEY }}
          prompt-id: 12345678-1234-1234-1234-1234567890ab
          url-map: |
            { "acme.com": "${{ github.event.target_url }}" }
```

#### Anything else (run after your own deploy step)

Works on any platform — the action runs as a step right after your existing deploy step and consumes its output.

```yaml
name: 2027 eval
on:
  pull_request:
    types: [opened, synchronize]
jobs:
  deploy-and-eval:
    runs-on: ubuntu-latest
    permissions:
      contents: read        # for actions/checkout
      pull-requests: write  # sticky PR comment
      statuses: write       # commit status check
    steps:
      - uses: actions/checkout@v6
      - id: deploy
        uses: amondnet/vercel-action@v25
        with:
          vercel-token: ${{ secrets.VERCEL_TOKEN }}
          vercel-project-id: ${{ secrets.VERCEL_PROJECT_ID }}
          vercel-org-id: ${{ secrets.VERCEL_ORG_ID }}
      - uses: team2027/evals-action@v0.2.0
        with:
          api-key: ${{ secrets.EVALS_API_KEY }}
          prompt-id: 12345678-1234-1234-1234-1234567890ab
          url-map: |
            { "acme.com": "${{ steps.deploy.outputs.preview-url }}" }
```

#### On-demand triggers (label / comment mention)

Re-run an eval on an existing PR without pushing a commit — useful for
testing prompt changes, retrying after a flake, or letting a reviewer fire
the eval manually. Two complementary triggers:

```yaml
name: 2027 eval (on-demand)
on:
  pull_request:
    types: [labeled]
  issue_comment:
    types: [created]
jobs:
  eval:
    if: >-
      (github.event_name == 'pull_request' &&
        github.event.label.name == 'trigger: preview') ||
      (github.event_name == 'issue_comment' &&
        github.event.issue.pull_request &&
        contains(github.event.comment.body, '@2027dev'))
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
      statuses: write
    steps:
      - uses: actions/checkout@v6
      - uses: team2027/evals-action@v0.7.0
        with:
          api-key: ${{ secrets.EVALS_API_KEY }}
          prompt-id: 12345678-1234-1234-1234-1234567890ab
          url-map: |
            { "acme.com": "https://your-preview-url" }
```

Three gotchas worth knowing:

1. **Where the workflow is loaded from differs by event.** `issue_comment`
   always uses the workflow file on your default branch — so this YAML must
   land on `main` before comment mentions can trigger it. `pull_request:
   labeled` uses the workflow on the **PR's head branch**, which means an
   already-open PR won't pick up new triggers until you merge `main` into
   its branch.
2. **Always gate with an `if:`.** Without one, every label / every PR
   comment would fire a paid eval. The filter above is the minimum: a
   specific label name plus a mention substring.
3. **Don't key `concurrency.group` on the PR number when you're listening
   to `issue_comment`.** GitHub evaluates `concurrency` *before* `if:`, so
   an unrelated bot comment on the same PR would cancel an in-flight eval
   even though its body fails the `@2027dev` filter. Key off the comment
   id (unique per comment) so each comment gets its own group:
   ```yaml
   concurrency:
     group: ${{ github.workflow }}-${{ github.event.comment.id || github.head_ref || github.ref }}
     cancel-in-progress: true
   ```

#### Prompts with template variables (e.g. CLI / non-URL evals)

If your prompt declares `templateVars` (e.g. a per-PR CLI build URL stamped
into the task), pass them via `template-vars`. `url-map` becomes optional —
omit it for evals that don't target a web preview.

```yaml
- uses: team2027/evals-action@v0.2.0
  with:
    api-key: ${{ secrets.EVALS_API_KEY }}
    prompt-id: 12345678-1234-1234-1234-1234567890ab
    template-vars: |
      { "cliInstall": "npm i -g https://pkg.pr.new/org/repo/@scope/cli@${{ github.sha }}" }
```

## Workflow setup

### Required permissions

The action needs exactly these scopes on the workflow's `GITHUB_TOKEN`:

```yaml
permissions:
  contents: read          # checkout
  pull-requests: write    # sticky PR comment + look up the PR for a commit
  statuses: write         # commit status check
```

You do **not** need `issues: write`. PR comments are served by GitHub's
issue-comments REST endpoint, but token-scope-wise `pull-requests: write`
already covers them — granting `issues: write` only widens the surface area
without enabling anything the action uses.

If you set `skip-comment: true` you can drop `pull-requests: write` (the PR
lookup still works on `contents: read`). If you set `skip-status: true` you
can drop `statuses: write`.

### Concurrency — supersede in-flight runs

For PR-triggered workflows, set `cancel-in-progress: true` so a new push
cancels the stale workflow:

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.head_ref || github.ref }}
  cancel-in-progress: true
```

> **Caveat for `deployment_status` triggers.** `github.head_ref` is empty on
> deployment events and `github.ref` falls back to the deployment SHA, which
> would put every commit in its own group (no supersession). Key on the
> deployment's branch ref instead:
> ```yaml
> concurrency:
>   group: ${{ github.workflow }}-${{ github.event.deployment.ref }}
>   cancel-in-progress: true
> ```

This is safe with our backend's supersession logic. If the cancelled workflow
had already started an eval run, the next workflow's call to our API will
mark the older run `superseded` automatically — the action handles that as a
terminal state (commit status `success`, "superseded by newer commit" in the
sticky comment). If the cancelled workflow died before creating a run, there's
simply nothing to supersede.

## Inputs

| Name | Required | Default | Description |
|------|----------|---------|-------------|
| `api-key` | yes | — | 2027 API key (store as repo secret) |
| `api-base-url` | no | `https://2027.dev/evals` | Override for self-hosted evals deployments |
| `prompt-id` | yes | — | Prompt UUID. List via `GET /api/v1/prompts`. |
| `url-map` | conditional | `{}` | JSON object mapping production hostnames to preview URLs. Values must be full `http(s)` URLs (not bare hostnames). Optional when `template-vars` carries the prompt's variables (e.g. CLI / non-URL evals). |
| `template-vars` | conditional | — | JSON object of values for the prompt's declared template variables (sent to the API as `templateArgs`). Required when the prompt declares non-empty `templateVars`; the server rejects the run otherwise with `400 Missing template vars`. |
| `deployment-url` | no | first `url-map` value | Required when `url-map` has more than one entry |
| `wait-timeout-minutes` | no | `20` | Poll for at most this many minutes before exiting |
| `poll-interval-seconds` | no | `20` | Seconds between status polls (used as base for backoff) |
| `timeout-fails` | no | `false` | When `true`, a polling timeout marks the commit status as `failure` (blocks merge). Default `false` marks it `success` so checks don't get stuck pending. |
| `skip-comment` | no | `false` | When `true`, the action does not post the sticky PR comment. Use this if you want to render your own comment from the outputs. |
| `skip-status` | no | `false` | When `true`, the action does not set the commit status. Use this if you want to set your own status from the outputs. |
| `github-token` | no | `${{ github.token }}` | Token used to post the PR comment + commit status |

## Outputs

| Name | Description |
|------|-------------|
| `run-id` | UUID of the eval run on 2027 |
| `status-url` | API endpoint that reflects the run's current state |
| `final-status` | Terminal state observed before the action exited: `completed`, `failed`, `superseded`, or `running` (on timeout) |
| `prompt-title` | Human-readable title of the evaluated prompt |
| `report-slug` | Report slug if the run produced one, empty string otherwise |
| `report-url` | Full URL to the dashboard report page, empty string if no report |
| `failure-reason` | Server-provided failure reason if the run failed, empty string otherwise |
| `score` | Final score (0-100) when the run produced a report, empty string otherwise |
| `grade` | Final letter grade when the run produced a report, empty string otherwise |
| `baseline-score` | Score of the most recent prior published report for the same prompt, empty string if no baseline |
| `report-json` | Full report object as stringified JSON (`{slug, url, score, grade, metrics, dimensions}`). Forward-compatible — picks up new API fields without an action release. Empty string when no report. |
| `baseline-json` | Baseline object as stringified JSON (`{score, grade}`). Empty string when no baseline. |

### Rendering your own comment

Set `skip-comment` and/or `skip-status` to `true` and consume the outputs from a downstream step:

```yaml
- id: eval
  uses: team2027/evals-action@v0.2.0
  with:
    api-key: ${{ secrets.EVALS_API_KEY }}
    prompt-id: 12345678-1234-1234-1234-1234567890ab
    url-map: |
      { "acme.com": "${{ github.event.deployment_status.target_url }}" }
    skip-comment: true

- uses: actions/github-script@v9
  with:
    script: |
      const status = '${{ steps.eval.outputs.final-status }}'
      const title = '${{ steps.eval.outputs.prompt-title }}'
      const reportUrl = '${{ steps.eval.outputs.report-url }}'
      const failure = '${{ steps.eval.outputs.failure-reason }}'
      const score = '${{ steps.eval.outputs.score }}'
      const grade = '${{ steps.eval.outputs.grade }}'
      const baseline = '${{ steps.eval.outputs.baseline-score }}'
      const delta = score && baseline ? ` (${Number(score) - Number(baseline) >= 0 ? '+' : ''}${Number(score) - Number(baseline)} vs baseline)` : ''
      const body = status === 'completed' && reportUrl
        ? `🎉 **${title}** — ${grade} ${score}/100${delta} → [report](${reportUrl})`
        : status === 'failed'
        ? `💥 **${title}** failed: ${failure}`
        : `⏱ **${title}** still running`
      await github.rest.issues.createComment({
        ...context.repo,
        issue_number: context.payload.pull_request.number,
        body,
      })
```

## Behavior

- The action calls `POST /api/v1/prompts/<prompt-id>/run` to create a run,
  then polls `GET /api/v1/runs/<run-id>` until completion or until the
  `wait-timeout-minutes` budget expires. The PR comment and commit status
  are rendered inside the action from the response (`status`, `prompt.title`,
  optional `report`, optional `failureReason`).
- On `completed` → commit status `success`, links to the report when
  available, otherwise to the status page.
- On `failed` → commit status `error`, action fails the build with the
  server's `failureReason`.
- On `superseded` → commit status `success` (a newer commit replaced this run).
- On timeout → by default, commit status becomes `success` with a "still
  running" description so the check doesn't stay stuck pending; set
  `timeout-fails: true` to use `failure` instead. Action exits 0 either way.
- **Polling resilience.** Auth/lookup errors (`401`/`403`/`404`) bail
  immediately. `5xx` and network errors get exponential backoff with jitter
  capped at 60s, honoring `Retry-After` if the server sends it.

The PR comment is sticky — re-runs of the same prompt update the same comment
via the marker `<!-- 2027-eval-comment:<promptId> -->`.

## Limitations (v1)

- **Poll mode only.** The action stays running for the duration of the eval.
  Fire-and-forget mode (queue completes asynchronously and pings back via
  webhook) is planned.
- **Single prompt per call.** Use `strategy.matrix` in your workflow to fan
  out across multiple prompts.

## API base URL

`api-base-url` defaults to `https://2027.dev/evals`, the managed production
deployment. The input exists so the action can point at a different API host
in the future (self-hosted evals, staging) — there's no public alternative
host today.

The action logs the resolved API base on the first line of its output, so you
can verify which deployment your CI is hitting.

## Source

Distributed from [team2027/evals-action](https://github.com/team2027/evals-action).
Developed alongside the public REST API in [team2027/evals](https://github.com/team2027/evals)
— issues that span both repos are filed there.

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

| Platform | Recipe |
|----------|--------|
| Vercel, Mintlify, anything using GitHub's [Deployments API](https://docs.github.com/en/rest/deployments) | `on: deployment_status` (below) |
| Netlify | `on: status` with context filter (below) |
| Anything else, or you want full control | Run after your own deploy step (below) |

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

## Inputs

| Name | Required | Default | Description |
|------|----------|---------|-------------|
| `api-key` | yes | — | 2027 API key (store as repo secret) |
| `api-base-url` | no | `https://2027.dev/evals` | Override for self-hosted evals deployments |
| `prompt-id` | yes | — | Prompt UUID. List via `GET /api/v1/prompts`. |
| `url-map` | yes | — | JSON object mapping production hostnames to preview URLs. Values must be full `http(s)` URLs (not bare hostnames). |
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

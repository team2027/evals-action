# Completed

Terminal state. Success is keyed on `report.outcome === "succeeded"` — the
only value that turns the commit status green. Every other outcome
(`goal_not_met`, `no_creds`, `excluded`, `scoring_failed`) or a missing
report renders as **Did not finish** and sets the commit status to `failure`.

## Sections (in order, each optional)

1. Heading — `**Succeeded**` or `Did not finish`
2. DNF reason (only when not succeeded) — first of `keyFinding`, `summary.whatDidnt`, `nullNotice`, `verdict`, `failureReason`, then the raw outcome
3. Metrics table — `Time | Cost | Errors | Interruptions`, with ▲/▼ deltas vs the most recent prior succeeded run for the same prompt
4. Prompt body — default-closed `<details><summary>prompt</summary>` block carrying `prompt.text`
5. Mapping blockquote — template-var lines, then url-map lines. Omitted when both are empty.
6. Footer — short SHA · `[View report →]` · `[Dashboard]`

---

## Succeeded, with baseline

```markdown
### 2027 // Sign up and create a project — **Succeeded**

| Time | Cost | Errors | Interruptions |
| --- | --- | --- | --- |
| 2m 14s  ▲ +14s | $0.12  ▼ -$0.03 | 1  ▲ +1 | 0 |

<details><summary>prompt</summary>

Sign up at acme.com, create a project named "demo", and copy the API key.

</details>

> acme.com → `preview-pr-42.fly.dev`

Commit `a1b2c3d`  ·  [View report →](https://2027.dev/evals/acme.com/reports/abc123)  ·  [Dashboard](https://2027.dev/evals/acme.com)
```

## Succeeded, first run for this prompt

The baseline lookup (`GET /api/v1/runs?promptId=…&reportStatus=published&limit=2`)
found no prior succeeded run with metrics, so no arrows render.

```markdown
### 2027 // Sign up and create a project — **Succeeded**

| Time | Cost | Errors | Interruptions |
| --- | --- | --- | --- |
| 2m 14s | $0.12 | 1 | 0 |

<details><summary>prompt</summary>

Sign up at acme.com, create a project named "demo", and copy the API key.

</details>

> acme.com → `preview-pr-42.fly.dev`

Commit `a1b2c3d`  ·  [View report →](https://2027.dev/evals/acme.com/reports/abc123)  ·  [Dashboard](https://2027.dev/evals/acme.com)
```

## Did not finish

```markdown
### 2027 // Sign up and create a project — Did not finish

```diff
- ⚠️ Score nulled: AI judge determined the task was not completed.
```

| Time | Cost | Errors | Interruptions |
| --- | --- | --- | --- |
| 2m 14s | $0.12 | 1 | 0 |

<details><summary>prompt</summary>

Sign up at acme.com, create a project named "demo", and copy the API key.

</details>

> acme.com → `preview-pr-42.fly.dev`

Commit `a1b2c3d`  ·  [View report →](https://2027.dev/evals/acme.com/reports/abc123)  ·  [Dashboard](https://2027.dev/evals/acme.com)
```

---

## Cross-cutting rules

- Dashboard URL is derived by trimming `/reports/<slug>` (and any trailing slash) off `report.url`.
- Metric deltas are computed from `timeSeconds` / `costUsd` (numeric); sub-half-cent and zero deltas are suppressed.
- Template-var values longer than 80 characters are truncated with an ellipsis.

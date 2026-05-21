# Completed

Terminal success state. The comment shape adapts to which fields the API
returned on `GET /api/v1/runs/:id` and whether a baseline run exists.

## Sections (in order, each optional)

1. Heading
2. Status line — bold `grade (score/100)` when present, else `Eval complete`
3. Score delta vs baseline (only when both `score` and `baseline.score` are present)
4. Metrics line — `Time · Cost · Errors · Interruptions`, with deltas in parens when baseline metrics exist
5. Mapping blockquote — one line per template-var (`> {{name}} => \`value\``) followed by one line per url-map entry (`> domain => \`previewHost\``). Omitted entirely when both maps are empty.
6. `Commit:` short SHA
7. Link row — `[View report →] · [Dashboard]`

---

## Rich: score + baseline + metrics + url-map

The full layout. Everything optional rendered.

```markdown
## 2027 AX Eval — Sign up and create a project

✅ **B+ (87/100)**

+5 pts vs baseline

Time: 2m 14s (+14s) · Cost: $0.12 (-$0.03) · Errors: 1 (+1) · Interruptions: 0

> acme.com => `preview-pr-42.fly.dev`

Commit: `a1b2c3d`

[View report →](https://2027.dev/evals/acme.com/reports/abc123) · [Dashboard](https://2027.dev/evals/acme.com)
```

Notes on the metrics line:

- `Time` / `Cost` use the API's display strings (`"2m 14s"`, `"$0.12"`).
- Deltas are computed from `timeSeconds` / `costUsd` (numeric) for accuracy.
- Sub-half-cent and zero-second deltas are suppressed.
- `Errors` and `Interruptions` only show a delta when non-zero — `0 → 0` renders as `Interruptions: 0` with no parens.

---

## No baseline — first run for this prompt

The baseline lookup (`GET /api/v1/runs?promptId=…&reportStatus=published&limit=2`)
returned no prior runs. Delta lines disappear; current-state values still
render so the metrics line stays informative.

```markdown
## 2027 AX Eval — Sign up and create a project

✅ **B+ (87/100)**

Time: 2m 14s · Cost: $0.12 · Errors: 1 · Interruptions: 0

> acme.com => `preview-pr-42.fly.dev`

Commit: `a1b2c3d`

[View report →](https://2027.dev/evals/acme.com/reports/abc123) · [Dashboard](https://2027.dev/evals/acme.com)
```

---

## Baseline but no metrics

API returned `report.score` / `report.grade` but `report.metrics` is null
(legacy run, or metrics not yet computed). Score delta still renders;
metrics line is omitted entirely.

```markdown
## 2027 AX Eval — Sign up and create a project

✅ **B+ (87/100)**

+5 pts vs baseline

> acme.com => `preview-pr-42.fly.dev`

Commit: `a1b2c3d`

[View report →](https://2027.dev/evals/acme.com/reports/abc123) · [Dashboard](https://2027.dev/evals/acme.com)
```

---

## Minimal fallback — no score / grade

API returned `report.url` but no `score` / `grade` (e.g., older API version,
or report wasn't scored). The bold header reverts to generic `Eval complete`;
all the report-link plumbing still renders.

```markdown
## 2027 AX Eval — Sign up and create a project

✅ Eval complete

> acme.com => `preview-pr-42.fly.dev`

Commit: `a1b2c3d`

[View report →](https://2027.dev/evals/acme.com/reports/abc123) · [Dashboard](https://2027.dev/evals/acme.com)
```

---

## Template-vars prompt — no `url-map`, just per-PR template args

CLI / non-URL evals pass `template-vars` instead of a `url-map`. The
blockquote then carries only the template-var lines.

```markdown
## 2027 AX Eval — Install the Sanity CLI

✅ **A- (91/100)**

> {{cliInstall}} => `npm i -g https://pkg.pr.new/team2027/sanity-cli/@sanity/cli@1ca9807`

Commit: `a1b2c3d`

[View report →](https://2027.dev/evals/sanity/reports/xyz) · [Dashboard](https://2027.dev/evals/sanity)
```

---

## Cross-cutting rules

- Dashboard URL is derived by trimming `/reports/<slug>` (and any trailing slash) off `report.url`.
- The mapping blockquote renders in both the `running` and `completed` comments. Template-var lines appear first, then url-map lines, all inside a single blockquote.
- Same-as-baseline (zero score delta) collapses the delta line to "Same as baseline".
- Negative deltas use `-N pts vs baseline`.
- Empty `url-map` entries are filtered out before rendering. If both maps are empty / null / unparseable, the blockquote is omitted entirely.
- Template-var values longer than 80 characters are truncated with an ellipsis so the line stays readable on a PR page.

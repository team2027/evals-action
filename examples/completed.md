# PR comment formats

All possible outputs of `renderComment` in `scripts/run.js`, rendered against
realistic inputs. The function dispatches on `status` and degrades gracefully
when optional fields (`report.score`, `report.grade`, `baseline.score`,
`failureReason`, `urlMapRaw`) are absent.

Common formatting rules across every branch:

- Heading is always `## 2027 AX Eval — <prompt title>` (or `(unknown)` when title missing).
- SHA is truncated to 7 chars.
- Sections are separated by blank lines so GitHub renders each as its own paragraph.
- `Tested:` line only renders inside `completed`. Other branches show the status-page link.
- Dashboard link is derived by stripping `/reports/<slug>` off the report URL (or `/api/v1/runs/<id>` off the status URL).

---

## Running / pending

Initial poll state — no report yet, links only to the status page.

```markdown
## 2027 AX Eval — Sign up and create a project

🔄 Running eval

Commit: `a1b2c3d`

[Status page →](https://2027.dev/evals/api/v1/runs/abc-123)
```

---

## Completed — rich (score, grade, positive baseline delta)

Full result with grade/score header, baseline delta line, tested-url mapping,
and a dashboard link derived from the report URL.

```markdown
## 2027 AX Eval — Sign up and create a project

✅ **B+ (87/100)**

+5 pts vs baseline

Tested: acme.com → preview-pr-42.fly.dev

Commit: `a1b2c3d`

[View report →](https://2027.dev/evals/acme.com/reports/abc123) · [Dashboard](https://2027.dev/evals/acme.com)
```

---

## Completed — negative delta

Score lands under the baseline; delta line uses `-N pts vs baseline`.

```markdown
## 2027 AX Eval — Sign up and create a project

✅ **C (73/100)**

-12 pts vs baseline

Tested: acme.com → preview-pr-42.fly.dev

Commit: `a1b2c3d`

[View report →](https://2027.dev/evals/acme.com/reports/abc123) · [Dashboard](https://2027.dev/evals/acme.com)
```

---

## Completed — same as baseline (zero delta), multi-host url-map

When `report.score === baseline.score`, the delta line collapses to a flat
"Same as baseline". Multi-entry url-map renders all hosts comma-joined.

```markdown
## 2027 AX Eval — Sign up and create a project

✅ **A- (91/100)**

Same as baseline

Tested: acme.com → preview-pr-42.fly.dev, www.acme.com → www-preview-pr-42.fly.dev

Commit: `a1b2c3d`

[View report →](https://2027.dev/evals/acme.com/reports/abc123) · [Dashboard](https://2027.dev/evals/acme.com)
```

---

## Completed — perfect score, no baseline, no url-map

With baseline and url-map both absent, the comment collapses to header +
score + commit + links. No delta line, no `Tested:` line.

```markdown
## 2027 AX Eval — Sign up and create a project

✅ **A+ (100/100)**

Commit: `a1b2c3d`

[View report →](https://2027.dev/evals/acme.com/reports/abc123) · [Dashboard](https://2027.dev/evals/acme.com)
```

---

## Completed — minimal (no score, no grade, no baseline)

Fallback path used when the API returned a report URL but no score/grade
(e.g. dashboard PR not yet shipped). Header reverts to generic "Eval
complete" — the rest of the layout is preserved.

```markdown
## 2027 AX Eval — Sign up and create a project

✅ Eval complete

Tested: acme.com → preview-pr-42.fly.dev

Commit: `a1b2c3d`

[View report →](https://2027.dev/evals/acme.com/reports/abc123) · [Dashboard](https://2027.dev/evals/acme.com)
```

---

## Failed — with reason

The server-provided `failureReason` is rendered as its own paragraph between
the bold "Eval failed" line and the commit line. No truncation in the comment
(the commit-status check is the only thing that truncates).

```markdown
## 2027 AX Eval — Sign up and create a project

❌ **Eval failed**

Browser agent timed out on step 4 — could not locate signup form

Commit: `a1b2c3d`

[Status page →](https://2027.dev/evals/api/v1/runs/abc-123)
```

---

## Failed — no reason

When `failureReason` is null/empty, the reason paragraph is omitted entirely.

```markdown
## 2027 AX Eval — Sign up and create a project

❌ **Eval failed**

Commit: `a1b2c3d`

[Status page →](https://2027.dev/evals/api/v1/runs/abc-123)
```

---

## Superseded

A newer commit triggered a fresh run for the same prompt; this one was
short-circuited. Uses the `↻` glyph instead of ✅/❌.

```markdown
## 2027 AX Eval — Sign up and create a project

↻ Eval superseded

Commit: `a1b2c3d`

[Status page →](https://2027.dev/evals/api/v1/runs/abc-123)
```

---

## Unknown status (defensive fallback)

Any `status` value that isn't `completed`, `failed`, `superseded`, `pending`,
or `running` falls into the running-branch rendering above (same as the
pending/running format). The renderer never returns undefined.

# Failed

Terminal error state — the eval ran but the browser agent (or pipeline)
couldn't finish. The action also calls `core.setFailed()` so the GH job
turns red.

## With server-provided reason

The most common case. `failureReason` is rendered as its own paragraph
between the bold header and the commit line — no truncation in the comment
(only the commit-status check truncates, since it's a single-line field).

```markdown
## 2027 AX Eval — Sign up and create a project

❌ **Eval failed**

Browser agent timed out on step 4 — could not locate signup form

Commit: `a1b2c3d`

[Status page →](https://2027.dev/evals/api/v1/runs/abc-123)
```

## Without reason

`failureReason` was null/empty. The reason paragraph is omitted entirely
rather than rendering a placeholder. The action still sets `core.setFailed`
with `"unknown failure"`.

```markdown
## 2027 AX Eval — Sign up and create a project

❌ **Eval failed**

Commit: `a1b2c3d`

[Status page →](https://2027.dev/evals/api/v1/runs/abc-123)
```

## Notes

- No `report`, no metrics line — failed runs don't produce reports.
- Link target is the action's polling endpoint, not the dashboard.
- The commit-status check description does single-line collapse + 140-char truncation on the failure reason, but the comment renders the full text.

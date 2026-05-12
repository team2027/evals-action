# Superseded

A newer commit triggered a fresh eval for the same prompt + PR; the queue
short-circuited this one. Uses the `↻` glyph instead of ✅/❌ to signal
"not failed, just out-of-date".

```markdown
## 2027 AX Eval — Sign up and create a project

↻ Eval superseded

Commit: `a1b2c3d`

[Status page →](https://2027.dev/evals/api/v1/runs/abc-123)
```

## Notes

- The commit-status check is set to `success` (not `failure`) so the PR
  isn't blocked by a stale run.
- No report — the run never produced one. Status page link is the action's
  polling endpoint.
- The action does NOT call `core.setFailed` for superseded runs — they're
  expected during rapid pushes.

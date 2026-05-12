# Running / pending

Posted on initial poll, before the eval reaches a terminal state. Updated
in-place via the sticky-comment marker as the action polls.

```markdown
## 2027 AX Eval — Sign up and create a project

🔄 Running eval

Commit: `a1b2c3d`

[Status page →](https://2027.dev/evals/api/v1/runs/abc-123)
```

## Notes

- `pending` and `running` render identically.
- Unknown / future status values also fall through to this format
  (defensive default — the renderer never returns empty).
- No `report`, no `baseline`, no `Tested:` line — those only appear after
  terminal completion.
- The status-page link is always the action's polling endpoint, not the
  dashboard. Dashboard link only appears on `completed`.

# Running / pending

Posted on initial poll, before the eval reaches a terminal state. Updated
in-place via the sticky-comment marker as the action polls.

```markdown
## 2027 AX Eval — Sign up and create a project

🔄 Running eval

> {{cliInstall}} => `npm i -g https://pkg.pr.new/team2027/sanity-cli/@sanity/cli@1ca9807`
> acme.com => `preview-pr-42.fly.dev`

Commit: `a1b2c3d`

[Status page →](https://2027.dev/evals/api/v1/runs/abc-123)
```

## Notes

- `pending` and `running` render identically.
- Unknown / future status values also fall through to this format
  (defensive default — the renderer never returns empty).
- The mapping blockquote (template-vars first, then url-map) is surfaced
  here as soon as the run is started, so users can confirm the eval picked
  up the right preview / per-PR build without waiting for completion. It's
  omitted entirely when both maps are empty.
- No `report` and no `baseline` — those only appear after terminal completion.
- The status-page link is always the action's polling endpoint, not the
  dashboard. Dashboard link only appears on `completed`.

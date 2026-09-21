# Terminal tracker (`pnpm cli -- tracker`)

A dense, fixed-height terminal dashboard for one project — sized for a narrow pane, meant to
sit alongside builder panes rather than replace the web UI. It polls the same in-process
`getBoardStatus` the web board and `status --watch` use (no server round-trip), so it works from
the main checkout without a running dev server.

```bash
pnpm cli -- tracker                     # live dashboard, refreshes every 5s
pnpm cli -- tracker --once              # one static frame, then exit
pnpm cli -- tracker --json              # raw snapshot as JSON, for scripting (implies --once)
pnpm cli -- tracker -i 10 --project foo # 10s refresh, explicit project
```

## Flags

| Flag | Default | Does |
|---|---|---|
| `-p, --project <id>` | active project | Which project to show. Same id forms as every other CLI command (`pnpm cli -- list` prints them). |
| `-i, --interval <seconds>` | `5` | Refresh interval while polling. Clamped to a minimum of 2s. Ignored with `--once`/`--json`. |
| `--once` | off | Print a single frame and exit — no polling loop, no `console.clear()`. |
| `--json` | off | Print the raw `BoardStatusResponse` snapshot as JSON instead of a rendered frame. Implies `--once`. |

With no `--once`/`--json`, the command polls forever: it clears the screen, renders a frame,
prints `Refreshing every <n>s. Press Ctrl+C to exit.`, and repeats. `Ctrl+C`/`SIGTERM` exit
cleanly (exit code 0).

## Reading a frame

```
agentic-kanban | WIP 3/5 | in-progress:3 review:1 done:12
* #1141 Add the terminal tracker (2h4m)
o #1150 Fix disconnect handling (18m)
! #1183 Stranded merge-train rows (41m)
-- attention --
! #1183 stale in review
```

**Header line** — `<project name> | WIP <active>/<limit> | <status>:<count> ...`. WIP is the
project's resolved active-workspace count over its configured limit (`resolveWipLimit` — the
Strategy Bullseye's `activeAgentsTarget`, see the root `CLAUDE.md`'s WIP section). The column
counts are every issue's `statusName`, not just in-flight ones, so a status with 0 in-flight
work but a full backlog still shows a count.

**In-flight lines** — one per issue whose main workspace is in an active status
(`ACTIVE_WORKSPACE_STATUSES`: `active`, `fixing`, `reviewing`, `awaiting-plan-approval`):

```
<glyph> #<issue-number> <title> (<age>)
```

`<age>` is time since `lastActivity`, compact (`45s`, `12m`, `3h12m`, `2d4h`) — the same
shape `timeSince` uses elsewhere in the app. When there is no in-flight work the line reads
`(no in-flight workspaces)`.

**Blocked/attention section** — only printed when at least one issue has
`attention?.bucket === "needs_attention"` (the same bucket the web board's attention badge
reads). Each line is `! #<issue-number> <reason-label>`, where the label is
`attention.label` if the server set one, else the raw `attention.reason`
(`idle-awaiting` / `stale-in-review` / `closed-in-review`).

### Status glyphs

| Glyph | Status |
|---|---|
| `*` | `active` / `fixing` |
| `o` | `reviewing` / `awaiting-plan-approval` |
| `!` | `blocked` (also used for the attention section, which is a different field) |
| `x` | `error` |
| `.` | `idle` / anything unrecognised |

Every line is truncated (never wrapped) to the terminal width, so the frame's line count is
fixed for a given snapshot — a live pane never scrolls its own dashboard out from under itself.
Width comes from `process.stdout.columns`, clamped to a minimum of 20.

## `--json` contract

`--json` prints the raw `BoardStatusResponse` (`packages/shared/src/types/api/board.ts`) via
`getBoardStatus`, unrendered — the same shape the CLI's `renderTrackerFrame` consumes, so a
script gets strictly more than the rendered dashboard shows:

```jsonc
{
  "project": { "id": "...", "name": "...", "repoPath": "...", "defaultBranch": "master" },
  "generatedAt": "2026-09-21T10:00:00.000Z",
  "totals": { "totalIssues": 42, "inProgress": 3, "activeWorkspaces": 3, "runningSessions": 3 },
  "issues": [
    {
      "issueNumber": 1141,
      "issueId": "...",
      "title": "Add the terminal tracker",
      "priority": "medium",
      "issueType": "feature",
      "statusName": "in-progress",
      "workspace": { "id": "...", "branch": "...", "status": "active", "workingDir": "...", "baseBranch": "master", "isDirect": false, "readyForMerge": false },
      "session": { "id": "...", "status": "running", "startedAt": "...", "endedAt": null },
      "sessionStats": { "durationMs": 7200000, "totalCostUsd": 1.2, "inputTokens": 12000, "outputTokens": 3000, "numTurns": 8, "model": "claude-sonnet-5", "success": true },
      "diffStats": { "filesChanged": 4, "insertions": 120, "deletions": 30 },
      "conflicts": { "hasConflicts": false, "conflictingFiles": [] },
      "lastActivity": "2026-09-21T08:00:00.000Z",
      "lastOutput": ["..."],
      "lastAgentMessage": "...",
      "attention": null,
      "mergeState": null
    }
  ]
}
```

Every field is documented on the type itself (`BoardStatusIssue`/`BoardStatusResponse` in
`packages/shared/src/types/api/board.ts`); the two worth calling out because the rendered
frame collapses them:

- **`workspace`/`session`/`sessionStats`/`diffStats` can each independently be `null`** — an
  issue with no workspace yet, a workspace whose agent hasn't started a session, etc. A
  consumer must null-check each rather than assuming they travel together.
  - `attention` and `mergeState` are `null`/absent unless the issue is actually in that
  bucket — that is what the rendered frame's attention section filters on
  (`attention?.bucket === "needs_attention"`).

Pipe it into `jq`, or into any script that wants a project's live state without shelling out to
the REST API or spinning up the server — the CLI reads the same DB in-process.

## Recipe: a dedicated herdr pane for the tracker

A useful layout when driving several builder workspaces at once (see `docs/decisions/
018-herdr-optional-agent-support.md` — herdr is a terminal multiplexer, not an agent provider;
the board does not launch anything into it today, so this is a manual pane you set up
yourself, not a board feature):

```powershell
# One-time: split a narrow tracker pane off your current one, cwd'd into the main checkout.
# pane split takes no command of its own — splitting and running are two calls.
$current = (herdr pane current | ConvertFrom-Json).result.pane.pane_id
$tracker = (herdr pane split $current --direction right --ratio 0.25 `
  --cwd C:\projects\andrena\agentic-kanban --focus false | ConvertFrom-Json).result.pane_id
herdr pane rename $tracker "tracker"

# Run the live dashboard for the project you're driving in it:
herdr pane run $tracker "pnpm cli -- tracker --project agentic-kanban -i 5"
```

Or point it at a pane you already have (`herdr pane list` to find the id):

```powershell
herdr pane run <pane-id> "pnpm cli -- tracker --project agentic-kanban -i 5"
```

Keep the tracker pane pointed at the **main checkout**, not a worktree — `pnpm cli --` needs
`packages/shared/dist` built, which worktrees don't carry (see the root `CLAUDE.md`'s worktree
section). A narrow pane (20-40 columns) is enough: the frame truncates to whatever width it
gets rather than wrapping, so a slim column stays readable.

For a script driving several projects instead of a human watching one, poll `--json` on an
interval instead of the live `--once`-less mode — it is cheaper (no render pass) and gives a
script everything it needs to decide, e.g., which project's WIP has headroom.

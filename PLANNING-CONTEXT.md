# Planning Context — #1002: Add a --dry-run flag to `pnpm cli -- cleanup`

## Goal
Add a `--dry-run` flag to the `cleanup` CLI command (`packages/server/src/cli/commands/project.ts`)
that lists what would be removed without deleting anything, then prints a summary count.

## Key finding: the command is already read-only

The ticket description says "the 'cleanup' skill/CLI command deletes stale worktrees/sessions."
That's true of the **skill** (`.claude/skills/cleanup/SKILL.md`, a subagent that runs real
`git worktree remove --force` / deletes session dirs / deletes E2E DB rows over HTTP), but it is
**not** true of the CLI command in scope here.

`pnpm cli -- cleanup` (registered in `project.ts:74-107`) currently:
- Queries closed workspaces with a `workingDir` set (via `getClosedWorkspaces()`).
- Prints each stale worktree's branch/path.
- Never deletes anything — it explicitly instructs the user to run
  `git worktree remove --force <path>` manually.

So the CLI command is already a "dry preview." There is no session-id or artifact-file deletion
logic in this command at all — those concepts (session dirs, E2E artifacts) belong only to the
`cleanup` *skill*, which is out of scope per "keep the change scoped to the CLI cleanup command
implementation and its test."

## Affected areas
- `packages/server/src/cli/commands/project.ts` — the `cleanup` command's `.action()`.
- `packages/server/src/__tests__/cli.test.ts` — existing `describe("CLI cleanup", ...)` block
  (lines ~292-324) already covers the no-flag behavior; needs a new test for `--dry-run`.

Not in scope (per ticket's scope note and the MCP tool being a separate consumer):
- `packages/mcp-server/src/tools/cleanup-project.ts` (same reporting logic, different entry point,
  not a "CLI cleanup command").
- `.claude/skills/cleanup/SKILL.md` (the subagent-driven deleter).
- `packages/server/src/__tests__/stale-worktree-cleanup.test.ts` (tests a different, not-yet-wired
  route-level stale-worktree DELETE endpoint; unrelated to this CLI command).

## Proposed approach
Since the current command has no destructive behavior to gate, the practical interpretation of
"add `--dry-run`" is:
1. Add a `--dry-run` (or `-n`) boolean option to the `cleanup` command via commander's `.option()`.
2. Keep behavior functionally identical in both modes (list stale worktrees, no deletion) since
   there's nothing destructive to skip yet — but shape the output around the ticket's ask:
   - List each worktree path (and branch/workspace id) that "would be removed."
   - Print a final summary count line distinguishing dry-run output (e.g.
     `Dry run: N worktree(s) would be removed. No changes made.`).
3. Add a unit test in `cli.test.ts` asserting `--dry-run` produces the "would be removed" listing
   and summary count, and that the DB is unchanged after running it (no workspace rows mutated —
   trivially true here since the command never wrote to the DB, but assert it explicitly per the
   ticket's "no filesystem/DB changes" requirement).

This keeps the change additive and scoped: one new flag, adjusted print statements, one new test
block, no behavior change for the no-flag path.

## Open questions
- The ticket assumes a destructive command; the actual command performs no destructive action.
  I'm treating `--dry-run` as formalizing/confirming the existing preview behavior with clearer
  "would be removed" phrasing and an explicit summary count, rather than gating any real deletion
  (since there is none to gate) — flagging this discrepancy rather than expanding scope to add
  destructive behavior + a flag to skip it, which the ticket's scope note ("keep the change scoped
  to the CLI cleanup command implementation and its test") argues against.
- No session-id or artifact-file listing exists in this command's data source
  (`getClosedWorkspaces()` only returns workspace/worktree rows) — will not fabricate those in
  the summary output since the underlying command has no such capability.

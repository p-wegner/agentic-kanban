# Final Plan — #1002: `--dry-run` flag for `pnpm cli -- cleanup`

Both fork plans (`PLAN-CLAUDE.md`, `PLAN-CODEX.md`) independently reached the same
conclusion, so this plan adopts their shared approach verbatim rather than picking
between alternatives.

## Key finding (agreed by both plans)

`pnpm cli -- cleanup` (`packages/server/src/cli/commands/project.ts`) is already
non-destructive: it lists closed workspaces with a stale `workingDir` and tells the
user to remove them manually via `git worktree remove --force`. It does not delete
worktrees, sessions, DB rows, or artifact files — that destructive behavior belongs
to the separate `.claude/skills/cleanup` subagent, explicitly out of scope per the
ticket.

## Chosen approach

Add a `--dry-run` boolean option to the existing `cleanup` command. Since there is no
real deletion to gate, `--dry-run` formalizes the existing preview behavior with
explicit "would be removed" wording and a summary count:

- No flag: keep current output byte-for-byte unchanged (regression safety).
- `--dry-run` with 0 stale worktrees: print a dry-run-flavored zero-count message.
- `--dry-run` with N stale worktrees: print a header, list each `branch -> workingDir`,
  then a final summary line `Dry run: N worktree(s) would be removed. No changes made.`
  Do not print the manual-removal instruction in dry-run mode (that hint is for the
  real/report mode).

No new data sources, no session-id/artifact-file listing (not available from
`getClosedWorkspaces()`), no destructive behavior added anywhere.

## Files changed

1. `packages/server/src/cli/commands/project.ts` — add `--dry-run` option, branch output.
2. `packages/server/src/__tests__/cli.test.ts` — add a test asserting dry-run output
   content and that no DB/filesystem mutation occurs (workspace row unchanged).

## Test strategy

Unit test only, using existing `runCli`/`createTestDb`/seed helpers. Assert:
- dry-run output contains "would be removed" and the correct count,
- dry-run output does NOT contain the manual-removal instruction text,
- workspace row (`status`, `workingDir`) is unchanged after the dry-run call.

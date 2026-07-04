# Parallel fork artifacts

Issue #1002 — "Add a --dry-run flag to pnpm cli -- cleanup"

2 parallel branch(es) completed. Your job at this **Consolidate Plan & Implement** stage: review each branch's diff below, consolidate them into a single coherent result on this (parent) branch, resolve any overlaps, and then advance the workflow.

### Branch: feature/ak-1002-add-a-dry-run-flag-to-pnpm-cli-cleanup__fork-claude-plan
Status: cancelled

Agent summary:
 output to print a \"would be removed\" listing plus a summary count (leaving the no-flag path untouched), and a new unit test in `cli.test.ts` verifying the dry-run output and confirming no DB/filesystem mutation occurs. Committed as `2ce514c0`.","stop_reason":"end_turn","session_id":"d1ac1115-b6d5-4386-9e7f-9d4845464154","total_cost_usd":1.1012064999999998,"usage":{"input_tokens":20571,"cache_creation_input_tokens":116837,"cache_read_input_tokens":857755,"output_tokens":5342,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":116837,"ephemeral_5m_input_tokens":0},"inference_geo":"not_available","iterations":[{"input_tokens":2,"output_tokens":226,"cache_read_input_tokens":83088,"cache_creation_input_tokens":589,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":589},"type":"message"}],"speed":"standard"},"modelUsage":{"claude-haiku-4-5-20251001":{"inputTokens":925,"outputTokens":18,"cacheReadInputTokens":0,"cacheCreationInputTokens":0,"webSearchRequests":0,"costUSD":0.001015,"contextWindow":200000,"maxOutputTokens":32000},"claude-sonnet-5":{"inputTokens":20571,"outputTokens":5342,"cacheReadInputTokens":857755,"cacheCreationInputTokens":116837,"webSearchRequests":0,"costUSD":1.1001914999999998,"contextWindow":1000000,"maxOutputTokens":64000}},"permission_denials":[],"terminal_reason":"completed","fast_mode_state":"off","uuid":"313182d1-7896-47df-aafc-7e73425df23e"}


Diff vs parent:
```diff
diff --git a/PLAN-CLAUDE.md b/PLAN-CLAUDE.md
new file mode 100644
index 00000000..c6937391
--- /dev/null
+++ b/PLAN-CLAUDE.md
@@ -0,0 +1,101 @@
+# Implementation Plan — #1002: `--dry-run` flag for `pnpm cli -- cleanup`
+
+## Chosen approach
+
+`PLANNING-CONTEXT.md` already established the key fact: `pnpm cli -- cleanup`
+(`packages/server/src/cli/commands/project.ts:74-107`) is already non-destructive —
+it only reports closed workspaces that still have a `workingDir` (git worktree) and
+tells the user to remove them manually. There is no session-id or artifact-file
+deletion logic in this command; that only exists in the separate `.claude/skills/cleanup`
+subagent, which is explicitly out of scope.
+
+Given that, `--dry-run` can't gate a real deletion (there isn't one), so I'm
+implementing it as an **explicit, additive reporting mode**: same commander command,
+a new boolean `--dry-run` option, and when set the command prints each stale
+worktree as an item "would be removed" plus a final summary count line, instead of
+the current "can be removed manually" phrasing. Without the flag, behavior and
+output are byte-for-byte unchanged (verified by keeping the existing tests
+untouched). This satisfies the ticket's literal ask (list what would be removed,
+print a summary count, no destructive/DB/filesystem changes) without inventing
+destructive behavior just to gate it, which would violate the scope note.
+
+## Files to change
+
+1. **`packages/server/src/cli/commands/project.ts`** (cleanup command, lines ~74-107)
+   - Add `.option("--dry-run", "List what would be removed without making changes")`
+     to the `cleanup` command definition.
+   - In `.action()`, accept the options object (commander passes it as the first
+     arg when the command has options): `.action(async (options: { dryRun?: boolean }) => { ... })`.
+   - Branch the output:
+     - If `withWorktrees.length === 0`: keep existing "No stale worktrees found."
+       message for both modes (nothing to preview either way).
+     - If `options.dryRun` is true:
+       - Print a header, e.g. `Dry run: found ${withWorktrees.length} worktree(s) that would be removed:`
+       - Print each as `  ${ws.branch} -> ${ws.workingDir}` (same line shape as today).
+       - Print a final summary line, e.g. `Dry run complete: ${withWorktrees.length} worktree(s) would be removed. No changes made.`
+       - Do NOT print the "can be removed manually with git worktree remove" hint in
+         dry-run mode (that instructional text is for the real/report mode).
+     - Else (no flag): keep the exact existing output untouched.
+   - No new imports needed; `getClosedWorkspaces()` stays the sole data source.
+   - Update `.description()` / `.addHelpText("after", ...)` to mention `--dry-run`
+     briefly, consistent with other commands' help text conventions in this file.
+
+2. **`packages/server/src/__tests__/cli.test.ts`** (existing `describe("CLI cleanup", ...)` block, ~line 294-324)
+   - Add a new `it("--dry-run lists worktrees without making changes", ...)` test:
+     - Seed a project, issue, and a closed workspace with `workingDir` set (same
+       seeding pattern as the existing "lists closed workspaces with worktrees" test,
+       lines 306-323).
+     - Run `runCli(["cleanup", "--dry-run"], ctx.dbPath)`.
+     - Assert `result.status === 0`.
+     - Assert stdout contains the dry-run summary phrasing (e.g. `"would be removed"`
+       and a count matching the number of seeded stale workspaces, e.g. `"1 worktree(s)"`).
+     - Assert stdout does NOT contain the manual-removal instruction text (`"git worktree remove --force"`)
+       to confirm the two modes render distinctly.
+     - Assert no filesystem/DB changes: re-open the DB after the CLI call and verify
+       the workspace row's `status` and `workingDir` are unchanged (still `"closed"`
+       / the original path) — proving `--dry-run` (and indeed the command in general)
+       performs no mutation. This directly satisfies the ticket's "no filesystem/DB
+       changes" requirement.
+   - Optionally add a second small test: `--dry-run` with zero stale worktrees still
+     prints "No stale worktrees found." (same as no-flag path) — cheap regression
+     guard that the empty-case message isn't duplicated/changed.
+
+## Ordered steps
+
+1. Add the `--dry-run` option and branch the `.action()` output in `project.ts`.
+2. Run existing `CLI cleanup` tests to confirm the no-flag path is unchanged.
+3. Add the new `--dry-run` test(s) to `cli.test.ts`, seeding a closed workspace with
+   a worktree, and assert on stdout content + DB-row-unchanged.
+4. Run `pnpm exec vitest run cli.test.ts` (or `pnpm test:mine -- --changed HEAD`) from
+   the worktree to confirm everything passes.
+5. Commit only the two changed files.
+
+## Risks / tradeoffs
+
+- **Ticket implies destructive behavior that doesn't exist.** Risk: a reviewer
+  expects `--dry-run` to gate real deletion. Mitigated by keeping
+  `PLANNING-CONTEXT.md`'s documented discrepancy visible and scoping strictly to
+  what the command actually does — expanding scope to add real deletion + a flag to
+  skip it would violate "keep the change scoped to the CLI cleanup command
+  implementation and its test" and silently introduce a destructive capability that
+  wasn't asked for by tests or other consumers.
+- **Session ids / artifact files aren't listed.** The ticket text ("worktree paths,
+  session ids, artifact files") describes the skill's scope, not this command's data
+  source. Fabricating fake session-id/artifact entries in this CLI command's output
+  would be misleading since `getClosedWorkspaces()` has no such data. Flagging this
+  as a known gap rather than inventing unsupported output.
+- **Commander option destructuring.** Need to confirm commander passes the options
+  object as the action's first (and only, since this command takes no positional
+  args) parameter — consistent with other flagged commands already in this file (a
+  quick check of a sibling command's `.action((options) => ...)` signature during
+  implementation will confirm the exact shape).
+
+## Test strategy
+
+- Unit-level only (per ticket), inside the existing `cli.test.ts` file using the
+  established `runCli()` + `createTestDb()` + `seedProject`/`seedIssue` helpers —
+  no new test infrastructure needed.
+- Core assertions: (a) dry-run output shape/count, (b) dry-run output differs from
+  normal-mode output (no manual-removal instruction), (c) DB state unchanged after
+  dry-run (row-level check), (d) no-flag path remains byte-identical to current
+  behavior (regression guard via the pre-existing tests, left untouched).

```

---

### Branch: feature/ak-1002-add-a-dry-run-flag-to-pnpm-cli-cleanup__fork-codex-plan
Status: joined


Diff vs parent:
```diff
diff --git a/PLAN-CODEX.md b/PLAN-CODEX.md
new file mode 100644
index 00000000..e63fcaeb
--- /dev/null
+++ b/PLAN-CODEX.md
@@ -0,0 +1,78 @@
+# Codex Plan: Add `--dry-run` to `pnpm cli -- cleanup`
+
+## Context
+
+Issue #1002 asks for a `--dry-run` flag on `pnpm cli -- cleanup` that lists what would be removed without deleting anything and prints a summary count. The important code-level finding is that the CLI cleanup command is already non-destructive: `packages/server/src/cli/commands/project.ts` only queries closed workspaces with `workingDir`, prints them, and tells the user to remove them manually. It does not remove worktrees, sessions, database rows, or artifact files.
+
+The destructive cleanup behavior mentioned in the ticket belongs to the project `cleanup` skill, not the CLI command. Per the ticket's scope constraint, the implementation should stay in the CLI cleanup command and its CLI test.
+
+## Chosen Approach
+
+Add a `--dry-run` boolean option to the existing `cleanup` command and make dry-run output explicitly say what would be removed while preserving the current no-flag behavior as a read-only listing.
+
+Because the command has no deletion path today, the flag should not introduce real cleanup behavior or new data sources. It should formalize the existing preview behavior:
+
+- `cleanup` continues to list closed workspaces with stale worktree paths and manual removal guidance.
+- `cleanup --dry-run` lists the same stale worktree candidates using "would remove" wording.
+- `cleanup --dry-run` prints a final summary such as `Dry run: 1 worktree(s) would be removed. No changes made.`
+- If no stale worktrees exist, dry-run should still exit successfully and report that zero worktrees would be removed.
+
+This approach is deliberately conservative: it satisfies the flag/output/test requirement without turning a preview command into a destructive command or touching the separate cleanup skill.
+
+## Files To Change
+
+- `packages/server/src/cli/commands/project.ts`
+  - Add `.option("--dry-run", "List cleanup targets without removing anything.")` to the `cleanup` command.
+  - Update the action signature to accept options.
+  - Branch only the output wording and summary for dry-run mode.
+
+- `packages/server/src/__tests__/cli.test.ts`
+  - Add a focused test inside `describe("CLI cleanup", ...)` for `cleanup --dry-run`.
+  - Seed one closed workspace with a real temporary directory path.
+  - Assert dry-run output includes the worktree path, "would" wording, and the summary count.
+  - Assert the filesystem path still exists after the command.
+  - Assert the workspace row still exists and its `workingDir`/`status` are unchanged after the command.
+
+## Ordered Implementation Steps
+
+1. In `project.ts`, add the Commander option to the `cleanup` command before `.addHelpText(...)` or before `.action(...)`.
+2. Change `.action(async () => { ... })` to `.action(async (options: { dryRun?: boolean }) => { ... })`.
+3. Keep the existing `runMigrations()`, `getClosedWorkspaces()`, and `workingDir` filter unchanged.
+4. For zero results:
+   - Existing mode: keep `No stale worktrees found.`
+   - Dry-run mode: print a clear zero-count dry-run message, for example `Dry run: 0 worktree(s) would be removed. No changes made.`
+5. For nonzero results:
+   - Existing mode: keep current output as much as possible to avoid breaking expectations.
+   - Dry-run mode: print a heading like `Dry run: would remove N stale worktree(s):`, then list `branch -> workingDir`, then print the final summary count.
+6. Do not add worktree deletion, session cleanup, artifact cleanup, or DB mutation logic.
+7. Add the unit test in `cli.test.ts` using existing helpers (`createTestDb`, `seedProject`, `seedIssue`, `runCli`) and direct Drizzle reads for the post-run DB assertion.
+8. Run the relevant test command from the worktree root:
+   - `pnpm test:mine -- --changed HEAD`
+   - If vitest import resolution fails, report that and do not run `pnpm install`.
+9. Self-review the diff for scope: only `project.ts` and `cli.test.ts` should change for implementation.
+
+## Test Strategy
+
+Primary test: a new CLI unit test for `cleanup --dry-run` in `packages/server/src/__tests__/cli.test.ts`.
+
+The test should verify all acceptance points that exist in this CLI command's actual data model:
+
+- Output lists the stale worktree path.
+- Output says the worktree would be removed.
+- Output includes a summary count.
+- The filesystem directory still exists after the command.
+- The workspace row still exists after the command.
+- The workspace row's `status` remains `closed`.
+- The workspace row's `workingDir` remains the original path.
+
+Existing `cleanup` tests should continue to cover no-flag behavior:
+
+- `cleanup` with no stale worktrees prints the existing no-op message.
+- `cleanup` with closed workspaces lists them.
+
+## Risks And Tradeoffs
+
+- The ticket mentions session ids and artifact files, but the CLI cleanup command has no session or artifact cleanup source today. Adding those would require broader repository queries and would be a behavior expansion beyond the scoped CLI command change.
+- Because the CLI command is already read-only, `--dry-run` is mostly an output/contract flag. This may look smaller than the ticket wording implies, but it matches the actual implementation surface.
+- Avoid changing no-flag output unnecessarily; downstream tests or user muscle memory may rely on the current manual-removal guidance.
+- Do not touch `.claude/skills/cleanup/SKILL.md`; that is the destructive cleanup skill and explicitly outside this branch's scoped CLI-command work.

```
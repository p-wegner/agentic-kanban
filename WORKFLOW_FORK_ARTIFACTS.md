# Parallel fork artifacts

Issue #1002 — "Add a --dry-run flag to pnpm cli -- cleanup"

2 parallel branch(es) completed. Your job at this **Consolidate & Fix** stage: review each branch's diff below, consolidate them into a single coherent result on this (parent) branch, resolve any overlaps, and then advance the workflow.

### Branch: feature/ak-1002-add-a-dry-run-flag-to-pnpm-cli-cleanup__fork-claude-review
Status: joined


Diff vs parent:
```diff
diff --git a/REVIEW-FINDINGS-CLAUDE.md b/REVIEW-FINDINGS-CLAUDE.md
new file mode 100644
index 00000000..8be12673
--- /dev/null
+++ b/REVIEW-FINDINGS-CLAUDE.md
@@ -0,0 +1,71 @@
+# Review Findings — #1002 `--dry-run` flag for `pnpm cli -- cleanup`
+
+Reviewed commit `07e34457` against `PLAN-FINAL.md`.
+
+## MAJOR — dry-run output doesn't cover session ids or artifact files, per the ticket text
+
+**File:** `packages/server/src/cli/commands/project.ts:104-111`
+
+The ticket asks for a dry-run that "lists what WOULD be removed (worktree paths,
+session ids, artifact files) without deleting anything." The implementation only
+lists worktree branch/path pairs from `getClosedWorkspaces()`. Session ids and
+artifact files are never enumerated or mentioned in the output.
+
+`PLAN-FINAL.md` documents this as a deliberate scope reduction, reasoning that the
+existing `cleanup` CLI command was already non-destructive and only ever dealt with
+worktrees — the destructive session/artifact cleanup lives in the separate
+`.claude/skills/cleanup` subagent. That's a defensible read of the current CLI
+command's actual behavior, but it means the shipped feature is narrower than what
+the ticket explicitly enumerates. Whoever closes this ticket should confirm the
+narrower scope is acceptable, or the ticket should be amended/split so the
+"session ids, artifact files" part is tracked separately (e.g. against the
+`.claude/skills/cleanup` subagent) rather than silently dropped.
+
+**Suggested fix:** Either extend the CLI `cleanup` command's dry-run to also
+surface session ids / artifact files tied to the closed workspaces (would require
+new repository queries), or explicitly narrow the ticket and note in the PR/ticket
+that session-id/artifact-file reporting is out of scope for this CLI command and
+handled elsewhere.
+
+## MINOR — no-flag help text still says "does NOT auto-remove" without mentioning `--dry-run` in the command description
+
+**File:** `packages/server/src/cli/commands/project.ts:76`
+
+The `.description(...)` string is unchanged and only documents the no-flag
+behavior; `--dry-run` is only mentioned in the `--option` help string and the
+`addHelpText` example block. Minor discoverability gap — `--help` output leads
+with a description that reads as if this command has only one mode.
+
+**Suggested fix:** Add a short clause to the description mentioning `--dry-run`
+exists, or leave as-is since the option list and examples already surface it.
+
+## MINOR — dry-run "0 worktrees" test doesn't add a DB-mutation assertion
+
+**File:** `packages/server/src/__tests__/cli.test.ts:356-360`
+
+The zero-worktree dry-run test only asserts stdout content, not lack of DB
+mutation (unlike the N-worktree test at lines 325-354, which does verify the
+workspace row is untouched). Since there's nothing to mutate in the empty-list
+path, this is low risk, but it's an asymmetry worth noting — if `getClosedWorkspaces()`
+or filtering logic ever gained a side effect, this test wouldn't catch it in the
+zero-count branch.
+
+**Suggested fix:** Optionally add a trivial "no rows exist / no rows created"
+assertion for symmetry, though not required given the current code path has no
+write operations before this branch.
+
+## Notes (not findings)
+
+- No-flag behavior is confirmed byte-for-byte unchanged (existing test at
+  `cli.test.ts:306-323` still passes against the new code, and the new option
+  is additive/optional).
+- Control flow in the three-branch `if/if/fallthrough` structure in the action
+  handler is correct — each branch calls `process.exit(0)` before falling
+  through to the next, and `withWorktrees.length === 0` is mutually exclusive
+  with the following `options.dryRun` check for the non-empty case.
+- Test coverage does verify "no changes made" via workspace row equality
+  (id/status/workingDir unchanged) after a dry-run — satisfies the ticket's
+  "unit test covering dry-run mode makes no filesystem/DB changes" requirement
+  for the DB side. No filesystem/worktree-removal side effect exists in this
+  code path to begin with (the command was already non-destructive), so there
+  is nothing further to assert there.

```

---

### Branch: feature/ak-1002-add-a-dry-run-flag-to-pnpm-cli-cleanup__fork-codex-review
Status: joined


Diff vs parent:
```diff
diff --git a/REVIEW-FINDINGS-CODEX.md b/REVIEW-FINDINGS-CODEX.md
new file mode 100644
index 00000000..7003cb48
--- /dev/null
+++ b/REVIEW-FINDINGS-CODEX.md
@@ -0,0 +1,5 @@
+# Codex Review Findings
+
+No findings.
+
+Test note: `pnpm test:mine -- --changed HEAD` was run from the worktree root and failed because `vitest` is not available in the worktree packages. Per instruction, no dependency install was attempted.

```
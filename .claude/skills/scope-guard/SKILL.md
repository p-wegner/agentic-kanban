---
name: scope-guard
description: Pre-commit check for scope creep — diff working changes vs the task, flag unrelated files, run targeted tests, then commit
argument-hint: "[issue number or short task description]"
---

# scope-guard

Run this right before committing. It verifies the working changes stay within the scope of the task, flags scope creep, watches for known regression pitfalls, and runs targeted tests. Only commit once scope is clean and tests pass.

Argument `$ARGUMENTS` is either a kanban issue number (e.g. `42`) or a short description of the task.

## Step 1 — Establish the task definition

If given an issue number, fetch the ticket to get ground truth on what should change:

```bash
pnpm cli -- issue get <N>
```

From the title/description, extract the **files and areas the task is expected to touch**. If only a short description was given, infer the intended scope from it. Hold this as the baseline for judging every changed file.

## Step 2 — Inspect the working changes

```bash
git diff --stat HEAD
git diff --name-only HEAD
```

For **each** changed file, judge: does it relate directly to the task? Flag any file whose name/area does not appear in the ticket or isn't required to satisfy it.

## Step 3 — Apply the scope-creep signal

Per CLAUDE.md, warn if **either** holds:
- **>3–4 files** changed for a task that sounds small, or
- the diff contains **renames, reformatting, or feature additions** unrelated to the task (refactors must be behavior-preserving — no new features).

Restate the rules: only change what the task requires; don't fix pre-existing issues unless they directly block the task; don't rename/restructure/reformat outside scope.

## Step 4 — Handle flagged changes

For each flagged, unrelated change, choose one:
- **Revert it** (it doesn't belong in this commit), or
- For a genuine issue noticed in passing, **leave the code untouched and file a ticket** instead of fixing inline:
  - `mcp__agentic-kanban__create_issue`, or
  - `pnpm cli -- issue create`

Do not fix unrelated issues inline.

## Step 5 — Watch for documented regression pitfalls

Explicitly check the diff for these known traps before committing:
- **Refactor drops features** — wrapping UI in a new pattern can silently drop state fields, toggles, or save logic. Confirm every field/toggle/handler that existed still exists.
- **Reimplementation removes existing UI** — re-implementing a feature from scratch can delete client UI that already lives in master. Verify with `git show master:<file>` before assuming the new version is complete.
- **Inconsistent styling** — similar form fields added at different times can diverge; unify styling between comparable fields.

Call out anything suspicious in these categories directly.

## Step 6 — Run targeted tests

Run only the tests covering the changed files (Windows-aware: use Bash tool for `$(...)`, or list files explicitly in PowerShell):

```bash
pnpm --filter agentic-kanban test -- --related $(git diff --name-only HEAD)
```

If PowerShell can't expand `$(...)`, list the changed paths after `--related` manually.

## Step 7 — Commit

Only after scope is verified clean **and** tests pass. The project rule is **Always commit** after finishing a task — don't wait to be asked. End the commit message with the required trailer:

```
Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
```

If scope is **not** clean or tests fail, stop and report — do not commit.

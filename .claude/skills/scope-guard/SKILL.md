---
name: scope-guard
description: Pre-commit check for scope creep — diff working changes vs the task, flag unrelated files, run the project's fast checks, then commit. Stack-agnostic (reads the project's stack profile, not hard-coded to the TS monorepo).
argument-hint: "[issue number or short task description]"
---

# scope-guard

Run this right before committing, **in any project** (not just this TS monorepo). It verifies the working changes stay within the scope of the task, flags scope creep, watches for known regression pitfalls, and runs the project's fast checks. Only commit once scope is clean and the fast checks pass.

Argument `$ARGUMENTS` is either a kanban issue number (e.g. `42`) or a short description of the task.

The commands below are resolved **per stack** from the project's stack profile (Step 0), so this skill works for node/rust/go/python/java/… — never assume `pnpm`/`vitest`.

## Step 0 — Resolve the project's fast checks (per stack)

The board persists a **stack profile** per project (#786) and writes its commands into the worktree. Read them in this order — first source that yields a command wins:

1. **`.claude/smart-hooks-rules.json`** (generated from the stack profile, #787). It contains a `rules` array; each rule has a `name` and a `command`. Use:
   - the rule named **`Typecheck`** → your fast typecheck command, and
   - the rule named **`Quick tests`** (or **`Tests`** when there's no quick variant) → your fast-test command.
2. **`.claude/hooks/verify-gate.config.json`** → its `command` is the project's full build/test merge-gate; use it as the fast check if no smart-hooks rule exists (it may be slower, but it's the right per-stack command).
3. **Fallback by stack**, only if neither file is present: pick the quick-test subset for the detected ecosystem — e.g. node `npm test` / `pnpm test:mine` / `vitest related <files>`, rust `cargo test`, go `go test ./...`, python `python -m pytest -x`, java `./gradlew test`. In **this** repo specifically the quick subset is `pnpm --filter agentic-kanban exec vitest related <changed files>` (vitest v4 uses `related` as a subcommand — the `--related` flag is broken).

Read JSON files with the Read tool. If none resolves a command, say so in Step 6 and run no tests rather than guessing a wrong command.

## Step 1 — Establish the task definition

If given an issue number, fetch the ticket to get ground truth on what should change. Use the board's own tools (work in any project):
- MCP: `mcp__agentic-kanban__get_issue`, or
- REST: `GET /api/issues/<id>` (or `GET /api/issues/:id/detail-bundle`).

(In this repo you can also use `pnpm cli -- issue get <N>`, but prefer MCP/REST so the skill works from any project's worktree.)

From the title/description, extract the **files and areas the task is expected to touch**. If only a short description was given, infer the intended scope from it. Hold this as the baseline for judging every changed file.

## Step 2 — Inspect the working changes

```bash
git diff --stat HEAD
git diff --name-only HEAD
```

For **each** changed file, judge: does it relate directly to the task? Flag any file whose name/area does not appear in the ticket or isn't required to satisfy it.

## Step 3 — Apply the scope-creep signal

Warn if **either** holds:
- **>3–4 files** changed for a task that sounds small, or
- the diff contains **renames, reformatting, or feature additions** unrelated to the task (refactors must be behavior-preserving — no new features).

Restate the rules: only change what the task requires; don't fix pre-existing issues unless they directly block the task; don't rename/restructure/reformat outside scope.

## Step 4 — Handle flagged changes

For each flagged, unrelated change, choose one:
- **Revert it** (it doesn't belong in this commit), or
- For a genuine issue noticed in passing, **leave the code untouched and file a ticket** instead of fixing inline:
  - `mcp__agentic-kanban__create_issue`, or
  - REST `POST /api/issues` (or `pnpm cli -- issue create` in this repo).

Do not fix unrelated issues inline.

## Step 5 — Watch for documented regression pitfalls

These traps are stack-agnostic — apply whichever fit what the diff touches:
- **Refactor drops behavior** — wrapping or restructuring existing code can silently drop a field, branch, flag, handler, or save path. Confirm every input/output/side-effect that existed still exists. (For a UI project: every state field, toggle, and handler.)
- **Reimplementation removes existing code** — re-implementing a feature from scratch can delete logic that already lives on the base branch. Verify with `git show <baseBranch>:<file>` before assuming the new version is complete. (For a UI project, this is most often deleted client UI.)
- **Inconsistent style** — similar constructs added at different times can diverge (form fields, error handling, naming); unify comparable cases instead of leaving them inconsistent.

Call out anything suspicious in these categories directly.

## Step 6 — Run the project's fast checks

Run the command(s) resolved in **Step 0** against the changed files. Prefer the cheapest signal first (typecheck, then quick/affected tests):

- If a `related`/affected-only form exists for the stack (e.g. vitest `related`, or a `test:changed` script), pass it the changed paths from `git diff --name-only HEAD`. If your shell can't expand a `$(...)` substitution (PowerShell), list the changed paths explicitly.
- Otherwise run the resolved quick-test command as-is.

If Step 0 resolved **no** command for this project, state that no fast-check command is configured and skip the run — do not invent one.

## Step 7 — Commit

Only after scope is verified clean **and** the fast checks pass (or are legitimately absent per Step 6). The project rule is **Always commit** after finishing a task — don't wait to be asked. End the commit message with the required trailer:

```
Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
```

If scope is **not** clean or the fast checks fail, stop and report — do not commit.

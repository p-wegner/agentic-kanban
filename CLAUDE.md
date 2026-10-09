# CLAUDE.md

Operational detail lives in skills and in `docs/agent-guide/` (the rationale, incidents and full
detail behind every rule here). When a task matches a skill, invoke it — don't re-derive its steps.
When you work in an area below, read its linked guide page first.

**This file is the lean set every session loads, builders included (#1313).** Operator/Conductor
material — two boards and promotion, board-feedback modes, agent providers, board operations,
roles, skill map, workspace flow — lives in **`docs/agent-guide/operator-reference.md`**; read it
when you are driving the board rather than building a ticket. Don't grow this file with operator
material (`claude-md-builder-budget.test.ts` enforces the budget and the split).

## What This Is
Cleanroom reimplementation of [vibe-kanban](https://github.com/BloopAI/vibe-kanban): a kanban board for AI-driven coding tasks. Personal, single-user, local-first. TypeScript monorepo: Hono + Drizzle + React + MCP SDK + Tauri v2. Stages 0–13 done. Progress: `docs/state.md`.

**Two boards (#1013):** the board you TALK TO (`127.0.0.1:3001`/5173, every `mcp__agentic-kanban__*` call) is the **stable** build; **this** checkout is the **dev** board (`pnpm dev:devboard`, 3101/5273, own DB). Landing on master does not change the board you use — only `pnpm promote` does. Runbook: `docs/two-boards.md`.

## Hard Constraints — never violate
- **Never delete/wipe `kanban.db`** (no `pnpm db:reset`, no `rm`/`Remove-Item`/truncate/`Out-File`/redirect, any path form incl. `/mnt/c/...`). Delete individual issues/workspaces via MCP/API. The `validate-command-safety.js` PreToolUse guard blocks this — when it fires, STOP and ask the user; never weaken or route around it. For migration/lock/WAL problems use the `db-doctor` skill (`pnpm db:repair`, never deletes).
- **Never kill ALL node processes; never use `Start-Process`; never poll ports in a loop** — they flash terminal windows and kill other agents' worktree servers. Run headless; spawn Node with `windowsHide: true`. See `dev-server` skill.
- **Always commit** after finishing a task, unprompted. PR creation skipped — manual merge only.
- **Local only** — no cloud/multi-tenant/OAuth. Windows; use `uv`/`uv venv` for Python.
- **`#N` always means a kanban issue number, never a GitHub PR.**

## Scope Discipline
Change only what the task requires. Don't fix unrelated issues, rename/reformat out of scope, or add features while refactoring. File a kanban ticket (`mcp__agentic-kanban__create_issue`) for unrelated issues instead of fixing inline. Run `scope-guard` before committing (creep signal: >3–4 files for a small task, or files unrelated to the ticket). For narrow tickets that name the expected files, compare the staged file list to that scope and treat unrelated deletions as a blocker before commit.

**A partial refactor ("batch 1 of N", "N remain") needs a disclosure channel (#691)** before it merges: a shrink-only ratchet test for the remainder (pattern: `packages/shared/__tests__/wire-dto-single-declaration.test.ts`) **or** a follow-up ticket naming exactly what remains — plus the true state in `CONTINUE.md`. Neither is acceptable, however correct the batch.

**Several agents in ONE checkout: commit by pathspec, never via the shared index** — `git commit -F msg.txt -- <paths>`; never `git add -A`/`-a`/`.`; on `index.lock` wait and retry, never `git reset`. When another agent has uncommitted edits in a file you also changed, or after a private-index commit, use the **`shared-checkout-commit`** skill (private index + CAS `update-ref`, main checkout only). A worktree/builder/reviewer session **never writes the base ref** (`update-ref refs/heads/master`, `branch -f master`, `push … master`, `checkout master`): it rebases its own branch and lets the board land it (#1237, hard-blocked under `KANBAN_WORKTREE_DIR`).

## Board Feedback — a flaw IN THE BOARD
Never silently drop the finding. In a **worktree** the rule is fixed: `file-ticket` — report it and keep going, always passing `projectId` explicitly (your `CLAUDE.local.md` carries the exact call). Modes (`fix-direct`, `file-ticket`, `file-and-drive`, `gh-issue`) and their resolution order for the main checkout: `docs/agent-guide/operator-reference.md`. The worktree rendering is `buildBoardFeedbackSection` (`packages/shared/src/lib/ticket-context.ts`); keep it in sync.

## Board tools, providers, skills
Tool precedence: **MCP** (`mcp__agentic-kanban__*`) → **CLI** (`pnpm cli -- ...`) → **REST**; use the board's own features (review, `merge_workspace`, rebase, enhance) rather than replicating them. **`#N` tickets:** `pnpm cli -- issue get <N>`; run `pnpm cli --` from the MAIN checkout. **Project-specific skills live only in `.claude/skills/` — do NOT add them to `packages/server/src/builtin-skills.ts`** (built-ins ship in npm). After adding an MCP tool or CLI command run `pnpm skill:generate` (`bundled-skill-freshness.test.ts`). Never read raw provider/profile/roster prefs outside `resolveProjectRuntimeConfig`; change the default provider only with the `set-provider-default` skill. Skills a builder has are listed in its `CLAUDE.local.md`; others: `.claude/skills/<name>/SKILL.md`.

## Architecture Rules
- **Git:** high-level ops only in `packages/shared/src/lib/git-service.ts` (server/mcp copies are re-exports). **Spawn git only via `packages/shared/src/lib/git-exec.ts`** (`gitExec`/`gitExecOrThrow`/`gitExecSync`, deep import, node-only) — never a private `execGit`/`execFile("git")` (`git-exec-single-spawn.test.ts`). **Never `git reset --soft <branch>` in a worktree**; no `--no-edit` on `git rebase`.
- **Pre-merge gate** (`pre-merge-gate.service.ts`): a suite that reads state outside its import graph (spawns a script, reads `MIGRATIONS_DIR`, walks a tree) carries `// @gate:always-run` (optionally `when:<globs>`); `always-run-marker-ratchet.test.ts` enforces it. Gate tiers (`verify_gate_strategy_<id>`) only weaken VISIBLY; `impact` is opt-in, never a default. Read `docs/agent-guide/pre-merge-gate.md` before touching the gate, the markers or `test-mine.mjs`.
- **Vite binds wide but the API does not** (#866): `devProxyGuard.ts` rejects non-loopback `/api`/`/health`/`/ws`. Never `KANBAN_HOST=0.0.0.0`.
- **A builder writes ONLY in its own worktree** (#959) — any other repo is hard-blocked; if a card needs a change elsewhere, file a ticket against that project.
- **Commit messages: no UTF-8 BOM** (#976) — write the `-F` file with Bash, never a PowerShell redirect.
- **Time-dependent code:** inject `now?: string` (ISO, persisted) or `nowMs?: number` (arithmetic) — no other spelling (`time-injection-spelling-ratchet.test.ts`); seed test timestamps relative to `Date.now()`, never hardcoded ISO.
- **Hooks:** `settings.json` hook commands use forward slashes and `${CLAUDE_PROJECT_DIR}/`-prefixed paths (braced: headless sessions run hooks through PowerShell, where the bare form is empty and the guard fails open, #1311). New Claude safety hooks must also handle Codex input (`.codex/hooks.json`; `tool_name`, `tool_input.command`, patch/write, `cwd`). Git tests: `.trim()` and assert keywords, not exact strings.
- **Resilience:** agent subprocess callbacks are try/catch'd in `agent.service.ts`; `auto_monitor` is force-disabled on every boot.

Detail and incidents: `docs/agent-guide/architecture-notes.md`.

### PowerShell (worst-failing tool)
Never assign `$pid`/`$host`/`$home`/`$true`/`$null`/`$pshome` (use `$procId`/`$projectId`). No `2>&1` on native exes. Prefer `try { … -ErrorAction Stop } catch {}`. API/preference **writes** via `curl` (Bash) or MCP, never `Invoke-RestMethod -Method Put`. Write `"${i}:"`, not `$i:`. PS 5.1: no `&&`/`||`/ternary/`??`; pass `-Encoding utf8`.

### Worktrees
- Worktrees get a real `pnpm install -r`, so test/typecheck/`pnpm install` **in the worktree** is safe. Exception: a worktree created while Dependency Symlinks was ON holds junctions into main — never `pnpm install`/`add` there; recreate it.
- **Run vitest FROM the worktree; run `pnpm cli --` from the MAIN checkout** (or use MCP/REST). vitest 4 has no related flag: `pnpm exec vitest related <file>` or `pnpm test:mine -- --changed HEAD`.
- **Migration numbers:** check the highest in the main checkout's `packages/shared/drizzle`; add a `_journal.json` entry (the test list is journal-derived).
- **`git stash` can drop tracked changes** — prefer a WIP commit.
- **Nested worktrees (`<main>/.claude/worktrees/*`) get NO `pnpm install` and NO `pnpm dev`** (#1033); put checkouts that need deps in the sibling `.worktrees/` layout and remove dirs with `node scripts/safe-rmdir.mjs <dir>`. If main's `node_modules` links vanish: `pnpm install -r --offline` in main.
- **Recovery:** resume one stale workspace at a time (then at most two more). A ~1 s transcript with zero tokens = launch failed; stop it and rebuild the branch.

## Common Commands
- **Inner loop:** `[ -f .claude/skills/test-impact/tools/impact.mjs ] && node .claude/skills/test-impact/tools/impact.mjs select --min-score 1.0 --format vitest`, then run what it prints — **`select`, never `build`**. A green selection is not a green gate.
- **`pnpm test:mine` is the gate** — run it (and `pnpm --filter agentic-kanban test` for cross-cutting changes) before mark-ready.
- `pnpm typecheck` (bounded workers, incremental; a new package with a `tsconfig.json` must be added to `PACKAGES` in `scripts/typecheck.mjs`).
- `pnpm dev:devboard` in the main checkout, plain `pnpm dev` in a worktree (`feature/<N>-…` = `3001+N`/`5173+N`); never plain `pnpm dev` in main. Safe headless launch: `dev-server` skill. `pnpm promote --dry-run` first, always.

## Documentation Map
- `docs/agent-guide/` — `operator-reference` (operator/Conductor material), `board-feedback`, `agent-providers`, `pre-merge-gate`, `architecture-notes`, `board-operations`
- `docs/state.md` (progress), `docs/decisions/`, `docs/two-boards.md`, `docs/worker-fleet.md`, `.llm/workflows.md`
- `packages/server/CLAUDE.md` — server-package detail (incl. Butler ops)

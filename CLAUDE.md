# CLAUDE.md

Operational detail lives in skills (see Skill Map). When a task matches a skill, invoke it — don't re-derive its steps here.

## What This Is
Cleanroom reimplementation of [vibe-kanban](https://github.com/BloopAI/vibe-kanban): a kanban board for AI-driven coding tasks. Personal, single-user, local-first. TypeScript monorepo: Hono + Drizzle + React + MCP SDK + Tauri v2. Stages 0–13 done. Progress: `docs/state.md`.

Active project is "agentic-kanban" — use it for all monitor/workspace/MCP operations. On startup `deduplicateProjects()` removes legacy duplicates; if two show for one repo, restart the server.

## Hard Constraints — never violate
- **Never delete/wipe `kanban.db`** (no `pnpm db:reset`, no `rm`/`Remove-Item`/truncate/`Out-File`/redirect, any path form incl. `/mnt/c/...`). Delete individual issues/workspaces via MCP/API. The `validate-command-safety.js` PreToolUse guard blocks this — when it fires, STOP and ask the user; never weaken or route around it. For migration/lock/WAL problems use the `db-doctor` skill (`pnpm db:repair`, never deletes).
- **Never kill ALL node processes; never use `Start-Process`; never poll ports in a loop** — they flash terminal windows and kill other agents' worktree servers. Run headless; spawn Node with `windowsHide: true`. See `dev-server` skill.
- **Always commit** after finishing a task, unprompted. PR creation skipped — manual merge only.
- **Local only** — no cloud/multi-tenant/OAuth. Windows; use `uv`/`uv venv` for Python.
- **`#N` always means a kanban issue number, never a GitHub PR.**

## Scope Discipline
Change only what the task requires. Don't fix unrelated issues, rename/reformat out of scope, or add features while refactoring. File a kanban ticket (`mcp__agentic-kanban__create_issue`) for unrelated issues instead of fixing inline. Run `scope-guard` before committing (creep signal: >3–4 files for a small task, or files unrelated to the ticket).
For narrow tickets that name the expected files, compare the staged file list to that scope and treat unrelated deletions as a blocker before commit.

### Declaring a partial refactor ("batch 1 of N") requires a disclosure channel (#691)
A commit message that says "batch 1", "N remain", or "the rest is a mechanical follow-up" is a
promise about future work — and a promise with nowhere to land is invisible: #569 (13 of 74
duplicates removed, 61 never migrated), #591 (a shared `ExecResult` helper with 0 non-test
callers), and #513 (a commit that understated the remaining count 2.4×) all closed as Done with
no trail. Before such a commit merges, it must do at least one of:
- **Add or point at a shrink-only ratchet test** that fails if the remainder regrows (see
  `packages/shared/__tests__/wire-dto-single-declaration.test.ts` for the pattern: a
  grandfathered set that may only shrink, plus a test that catches a stale entry).
- **File a follow-up ticket** (`mcp__agentic-kanban__create_issue`) referencing the original
  ticket number, describing exactly what remains.
Doing neither is not an acceptable disclosure of partial work, even if the batch-1 portion is
itself correct and tested. Record the true current state in `CONTINUE.md` (see the global
CLAUDE.md's `CONTINUE.md`/`BACKLOG.md` convention) when landing a batch-1 commit.

### Several agents committing in ONE checkout — commit by pathspec, never via the index
`git add <paths>` + `git commit` is NOT safe when other agents work in the same checkout: the index is
shared process-wide, so a concurrent `git add`/`git reset` between your add and your commit sweeps
THEIR files into YOUR commit under YOUR message — or drops yours. This happened: `0a7d00bef3` carries
one agent's loop-convergence work plus another's monitor/git-exec work under a single misleading
subject. It is not rewritable once someone has built on it.

**Use a pathspec-limited commit, which ignores the shared index entirely:**
```bash
git commit -F msg.txt -- packages/server/src/services/foo.ts packages/server/src/__tests__/foo.test.ts
```
Never `git add -A`/`-a`/`.` in a shared checkout. On `index.lock` contention, wait and retry — do not
`git reset` to "clean up", which is what destroys the other agent's staged state. Intermediate commits
may then not typecheck standalone (a symbol can land one commit later); that is acceptable as long as
HEAD is coherent — say so in the commit message.

**Pathspec is NOT enough when two agents edit the SAME file** — it takes that path's whole current
worktree state, so it commits the other agent's half-written hunks under your subject. That is the
`0a7d00bef3` failure again, just via a different door. Waiting works only if they commit; when they
don't, commit YOUR HUNKS ONLY through a private index, which touches neither the shared index nor the
working tree:
```bash
export GIT_INDEX_FILE=$(mktemp)          # a private index — the shared one is untouched
git read-tree HEAD                        # start from HEAD, not from whatever is staged
# stage only your version of the contested file (e.g. from a blob you wrote aside),
# then build the commit object directly and move the ref under a compare-and-swap:
tree=$(git write-tree)
new=$(git commit-tree "$tree" -p "$(git rev-parse HEAD)" -F msg.txt)
git update-ref refs/heads/master "$new" "$(git rev-parse HEAD)"   # CAS: fails if HEAD moved
unset GIT_INDEX_FILE
```
The `update-ref` old-value argument is the point: if another agent committed while you were building,
it fails instead of clobbering. Afterwards verify `git diff HEAD -- <file>` is *exactly* the other
agent's remaining delta, so you can show you left their work intact and committable.

**Aftermath to clean up:** a private-index commit leaves any NEW file it added looking
**staged-deleted** in the shared index (the shared index never learned about it, but HEAD now has
it). Reconcile with a targeted `git add <your-new-files>` — and check afterwards that you did not
also stage a neighbour's in-flight edit. If you did, unstage exactly that path with
`git restore --staged -- <path>`, never `git reset`, which is what destroys the other agent's
staged state.

## Board Feedback Conventions — what to do when you hit a flaw IN THE BOARD
Using the board (driving a project, implementing a ticket, running the monitor) surfaces bugs and
impediments in the board itself. There are four ways to route that feedback. Pick by CONTEXT, not by
taste — the first three are preferred, and **never silently drop the finding**:

| Mode | Use when |
|---|---|
| **`fix-direct`** — fix it in the board's code now | Best outcome. Only when you can edit the board's main checkout without colliding with other activity — especially when the flaw BLOCKS planned work. |
| **`file-ticket`** — file a board ticket for later | The safe default. Use whenever direct work would collide with another agent/session, or the flaw is off your current task's path. |
| **`file-and-drive`** — file a ticket AND drive the board to implement it | The flaw is worth fixing now but you shouldn't hand-edit master (e.g. mid-drive with builders running). |
| **`gh-issue`** — file an issue on the board's GitHub repo | For machines that only CONSUME the board and do no active development on it — no local checkout to fix, no shared DB to file into. |

**Deployment decides what is even POSSIBLE — check this before preference:**

| Deployment | What's available |
|---|---|
| **git clone** (development) | All four. The board's repo is usually registered as a project, so there's a real backlog; source is editable. |
| **`npx agentic-kanban` / npm install** | `gh-issue` only. The code is an immutable package under `node_modules`/the npx cache — nothing to fix, and no board project to file into. |
| **`docker run`** | `gh-issue` only. Source lives in the image; edits die with the container. |

So on a consumer install, "file a ticket" is not a cheaper `gh-issue` — it's a **worse** one: the
ticket lands in whatever project backlog is at hand, about code nobody on that machine maintains,
and is never actioned. The board computes this itself in
`packages/server/src/services/board-feedback-routing.ts` (`detectBoardDeployment`) and renders the
resulting instruction into every worktree's ticket-context file. A registered board project always
wins — if the operator tracks the board ON the board, that's where they look.

**Choosing the mode — resolution order:**
1. **Deployment first.** If this board is packaged or containerized, it's `gh-issue`. Stop here.
2. **`CLAUDE.local.md` in the board's MAIN CHECKOUT** sets it, via a line `Board feedback mode: <mode>`.
   That file is gitignored, so it is per-machine — which is the point: a dev box says `fix-direct`,
   a consumer box says `gh-issue`.
3. **No such file and you are in the main checkout (fresh clone)** — ASK the user which mode they want
   the first time it comes up, then offer to record it in `CLAUDE.local.md`. Don't guess.
4. **You are in a WORKTREE** — always **`file-ticket`** (or `gh-issue` per rule 1). See the collision
   note below: a worktree's `CLAUDE.local.md` is not config, and a builder must not hand-edit the
   board's main checkout while other workspaces are live. Report it and keep going — a found bug is
   never a reason to abandon your ticket.

**`CLAUDE.local.md` means two different things — do not confuse them:**
- **Main checkout** → per-machine human/agent config (the `Board feedback mode:` line above).
- **Worktree** → the board GENERATES it as the ticket-context file (`TICKET_CONTEXT_FILENAME` in
  `packages/shared/src/lib/ticket-context.ts`): ticket text, context primer, stack profile, sibling
  repos, service stack. It is rewritten on every workspace creation, so **anything you put there by
  hand is lost** — never store config in a worktree's copy, and never treat it as user-authored.

**File against the RIGHT project — this is the easy mistake.** `create_issue` defaults to the board's
**active project**, which is usually NOT the project you are working in. A builder in `pantry` that
finds a *board* flaw must file it against the **agentic-kanban** project, not `pantry`. Always pass
`projectId` explicitly. (Real instance: two board bugs were filed into the `bookvault` fixture project
and sat there unactionable until they were moved to the dev board as #209/#210.) The generated
worktree ticket context names the board's project and id for exactly this reason.

**How the convention reaches a builder in ANOTHER repo.** A builder driving `pantry` reads *pantry's*
CLAUDE.md, never this one — so this section alone would never be seen. The board therefore renders the
routing into the ticket-context file it writes into **every** worktree
(`buildBoardFeedbackSection`, `packages/shared/src/lib/ticket-context.ts`). Keep the two in sync: this
section is the rationale, that function is what agents actually execute.

## Agent Providers
Pi runs as `pi --mode json` with explicit `--extension <worktree>/.pi/plugin/agentic-kanban-hooks.ts` and repeated `--skill <worktree>/.claude/skills/<name>/SKILL.md` flags for the skills materialized into the workspace. Pi 0.73.1 rejects `--approve`; do not add it. Safety hooks are hard pre-tool gates via Pi's `tool_call` event, and the adapter delegates to the existing `.claude/hooks/*.js` scripts instead of reimplementing DB-safety or cross-worktree write logic.

Claude Code, Codex, Copilot — selectable via Settings → Agent. Claude reads `~/.claude/settings_*.json`, Codex `~/.codex/<name>.config.toml`, Copilot the CLI default or a configured model profile.

**Provider default — single source of truth = the Strategy Bullseye pref (`board_strategy_<projectId>`).** It fans out to all consumers: `selectProviderFromStrategy` → `POST /api/workspaces` default, `resolveMonitorTunables` (deterministic monitor), and a regenerated `objective.md` (the Conductor agent). Two values sit *outside* that fan-out and drift if set independently — the `provider`/`claude_profile` settings prefs (butler/review/UI) and the provider-scoped `default_model_<provider>` (claude/codex/pi; the old cross-provider global `default_model` key was retired by #902 — a cross-provider model id is now structurally unrepresentable). **To change the default, use the `set-provider-default` skill** — it sets the Bullseye, mirrors the settings prefs, scopes/clears the chosen provider's `default_model_<provider>`, and verifies all agree. Never hand-edit one source alone. (The code-level fix to collapse these is tracked on the board.)

**Profile allowlist — a per-project CONSTRAINT, not another default.** `allowed_profiles_<projectId>`
(Settings → Agent → "Profiles this project may use") lists the `{provider, name}` pairs a project is
permitted to launch on. Absent/empty = unrestricted, which is every project by default. When set it is
applied LAST, after every selector above has chosen — so it outranks an explicit per-workspace profile
override, the Strategy Bullseye, a workspace's baked-in selection, and a global `claude_profile` that the
auth-rotation ring rewrote after a usage limit. The Bullseye stays the single source of truth for *which*
profile is preferred; this decides which are *permissible*, and the two are deliberately separate concerns
(a Bullseye is a priority list that falls through on quota, which is the opposite of a restriction).
Multiple entries are fallback order: the resolver takes the first that is not cooling. When ALL of them are
cooling the project **holds** — `resolveProviderConfig` returns a `profileHold` and workspace creation
refuses with `PROFILE_ALLOWLIST_HOLD` — rather than borrowing an unlisted account, since for a project
pinned to a client subscription the wrong account is worse than no progress. A present-but-unparseable
value also holds (fail closed). Logic: `packages/shared/src/lib/profile-allowlist.ts`; enforcement seam:
`resolveProjectRuntimeConfig`.

**The guarantee stops at the machine boundary, so a restricted project does not go remote
(#651).** A fleet worker authenticates the agent with its OWN local login and the board
deliberately sends no credentials (decision 012 — `CLAUDE_CONFIG_DIR` is not in
`REMOTE_SPEC_ENV_ALLOWLIST`, by design), so the board can pick a permitted profile but
cannot make the worker honour it. `resolveWorkerPlacement` therefore refuses remote
placement for any project with a non-empty (or unreadable) allowlist: it falls back to the
host, which CAN enforce the list, and a `worker_dispatch_strict` project HOLDS with the
restriction as the reason rather than borrowing an unlisted account. Worker-side
attestation — a worker declaring which profiles it can authenticate as, the way it already
declares `--providers`/`--labels` — is what would narrow this from "never" to "only to a
worker that can prove it qualifies"; until then, allowlist and fleet dispatch are mutually
exclusive on the same project.

## Board Operations
Tool precedence: **MCP** (`mcp__agentic-kanban__*`) → **CLI** (`pnpm cli -- ...`) → **REST**. Use the board's own features — review (`POST /api/workspaces/:id/review`), merge (`merge_workspace`), fix-and-merge, rebase (`update-base`), enhance, dependency-analyze — don't replicate manually. For narrow questions use `list_issues`/`get_board_status`, not unbounded `list_workspaces`. Don't hand-roll `curl | python`.

- Read a ticket: `pnpm cli -- issue get <N>` (`--json` for JSON).
- Backlog as ONE markdown file, both ways: `pnpm cli -- backlog export --out BACKLOG.md [--status …]` / `pnpm cli -- backlog import FILE [--apply]` (preview first); MCP `export_backlog_markdown` / `import_backlog_markdown`; UI Settings → UI → Export menu. Format + rules: `docs/backlog-markdown.md`.
- "resume #N" = `pnpm cli -- workspace resume <N>` (relaunch agent), not manual investigation.
- **Ticket groups (#661, decision 015)**: N coupled tickets in ONE workspace — one agent, one review, one merge-gate run; every ticket keeps its identity and closes when the branch lands. The grouping signal is the `coupled_with` edge: declare it at ticket creation (`create_issues_batch` `dependencies`) instead of writing "do together with #X" in prose, and consolidate an already-granular backlog with MCP `propose_ticket_groups` / `POST /api/issues/group-scan` (preview first, `apply: true` writes edges). The monitor then auto-starts the whole component as one group (cap 4; opt out per project with `auto_group_coupled_<id>=false`); manual starts pass `memberIssueIds` to `POST /api/workspaces`. Sizing rule for NEW tickets: a ticket is gate-sized — a few-minutes change is not its own ticket, it is a group member or part of its neighbour. (`workspaces.issueId` stays the group's LEAD; members live in `workspace_issue_members`.)
- `board-navigator` + `kanban-workflow` skills = full tool/command/workflow reference.
- **Butler** = warm per-project assistant (press `i`, MCP `ask_butler`, or `pnpm cli -- butler ask`).

## Architecture Patterns

### Git service — single source of truth
High-level git ops in `packages/shared/src/lib/git-service.ts`; `server/src/services/git.service.ts` and `mcp-server/src/git-service.ts` are thin re-exports — **edit only the shared file**. Invariants: `syncBranchToHead()`/`ensureOnBranch()` guard detached HEAD in worktrees; **never `git reset --soft <branch>` in a worktree** (corrupts `.git`); `detectConflicts()` uses read-only `git merge-tree`; `getWorkingTreeDiff()` also lists untracked files (`git ls-files --others`).

**Spawning git — the adapter.** The ONLY sanctioned place to spawn the `git` CLI is `packages/shared/src/lib/git-exec.ts` (the adapter/port). Use its `gitExec` (never-throws, returns `{stdout,stderr,code,error}`), `gitExecOrThrow` (normalised error), or `gitExecSync`; import via the deep path `@agentic-kanban/shared/lib/git-exec` (node-only — never the client-reachable barrel). **Do NOT write a private `execGit`/`execFile("git", …)` helper** — that drift is what made the "single source of truth" a lie across ~17 files. Enforced by `packages/shared/__tests__/git-exec-single-spawn.test.ts`, which scans all package `src/` (tests excluded) and fails on any raw git spawn outside the adapter.

### Vite dev server bind — UI is wide, the API is not (#866)
`packages/client/vite.config.ts` binds `server.host` to `"::"` (all interfaces, not loopback) so
`http://localhost:5173` works on Windows (browsers resolve `localhost` to `::1` first; an
IPv4-only bind fails) and so the UI is reachable over Tailscale (`allowedHosts: [".ts.net"]`,
`73e4bf03fb`). The board API behind the `/api`/`/health`/`/ws` proxies has **no authentication of
its own** — same shape as the concern `KANBAN_FLEET_HOST`/`KANBAN_GIT_HTTP_HOST` exist for in the
Worker Fleet section above. Binding the UI wide would otherwise hand every device on the tailnet
full unauthenticated read+write on the board. **Fix: the proxy's `bypass` (`devProxyGuard.ts`)
rejects any `/api`/`/health`/`/ws` request whose TCP peer isn't loopback (`127.0.0.1`/`::1`/the
IPv4-mapped form), independent of what `host` is bound to** — so the UI stays reachable from
another device but the API behind it does not. `VITE_HOST` remains the escape hatch to restrict
the UI bind itself (e.g. `VITE_HOST=127.0.0.1`).

### Pre-merge gate — tiered, and the always-run guard set is DECLARED, not hand-listed
`packages/server/src/services/pre-merge-gate.service.ts` runs `verify_script` (+ the boot/render
smoke check) before a merge lands. Its test half can be scoped to the packages/files a diff
actually touches (`scripts/test-mine.mjs`, honoring `KANBAN_TEST_PACKAGES`/`KANBAN_TEST_FILES`),
but scoping by import graph (`vitest related`) is blind to any suite that asserts a property of
the whole repo tree without importing what it checks (a spawned hook script, a `MIGRATIONS_DIR`
read, a recursive `readdirSync` scan) — those are exactly the guard/ratchet/parity/scanner
suites, and a hand-maintained "always run these" list silently drifts (#483: 7 of that failure
set were unlisted tree-scanners).

**Fix — classify by declaration.** A suite that reaches state outside its own import graph
carries a top-of-file `// @gate:always-run` marker (see `repo-path-literal-ratchet.test.ts`).
`scripts/test-mine.mjs` builds its always-run set (`ALWAYS_RUN_TESTS`) by scanning each
package's `__tests__` dir for that marker — the list can't drift from what's actually forced to
run, because it no longer exists independently. The companion
`packages/server/src/__tests__/always-run-marker-ratchet.test.ts` is the OTHER half: it
statically re-derives the same "reaches outside its own import graph" signature (spawns a
script under `.claude`/`.codex`/`scripts`, reads `MIGRATIONS_DIR`, or recursively walks a
directory tree) and fails when a matching file carries no marker — so a NEW guard suite can't be
silently unmarked the way the #483 set was. A file that matches the signature but is genuinely
reachable via its own imports (so scoping is safe for it) goes in that test's
`KNOWN_SAFE_UNMARKED` with a one-line reason instead of being force-marked. This is a heuristic
net, not a proof — a suite whose ambient read hides behind a helper won't match the regexes;
accepted, since the marker mechanism only needs to narrow the gap, not close it.

**Tier visibility.** `verify_gate_strategy_<projectId>` (`full` | `scoped` | `scoped-base-watch`,
default `full` until a base-health backstop exists) is the ONE named pref that replaces the
`verify_file_scope`/implicit-scoping booleans an operator could otherwise misalign. A level may
only weaken verification VISIBLY: a passing gate's message always names what ran, e.g.
`pre-merge gate passed (tier: file-scoped, 3 changed file(s), +14 guard suites, workers 6)` —
never a bare "passed" that hides whether scoping applied.

### Windows / hooks
- **Hook commands in `settings.json`**: use forward slashes (`\\` → `MODULE_NOT_FOUND`) and prefix the script with `$CLAUDE_PROJECT_DIR/` — never a hardcoded absolute path (breaks on every other clone/machine) and never a bare relative path (fails on CWD shift). `$CLAUDE_PROJECT_DIR` is set by Claude Code for hook execution (not for the Bash tool) and resolves to the session's repo root, so it works across machines, clones, and worktrees. This is the convention `project-scaffold.ts` ships to every scaffolded project. The hook scripts themselves self-locate (via `git rev-parse`/`__dirname` + the `KANBAN_MAIN_CHECKOUT` override), so they hold no machine-specific paths either.
- **Codex hook parity**: `.codex/hooks.json` routes shell checks through `.claude/hooks/smart-hooks-runner.js`, patch/write through `prevent-cross-worktree-writes.js`. New Claude safety hooks must also handle Codex input (`tool_name`, `tool_input.command`, patch/write, `cwd`).
- **Git tests**: `.trim()` content assertions (CRLF vs LF); assert on keywords, not exact strings.
- **No `--no-edit` on `git rebase`** — that's a `git merge` flag; `git rebase` rejects it with "unknown option". Non-interactive rebase already opens no editor, so just drop the flag (recurring agent error, ~5 failed calls/window).

### PowerShell (worst-failing tool, ~17% of calls)
- **Never name a variable `$pid`/`$host`/`$home`/`$true`/`$null`/`$pshome`** — read-only automatics; assigning throws and silently keeps the built-in (REST hits the WRONG id). Use `$procId`/`$projectId`. (Blocked by `validate-command-safety`.)
- **Don't pipe native-exe stderr with `2>&1`** — PS 5.1 wraps lines as ErrorRecords and flips `$?`/exit to failure on success. stderr is already captured.
- **Prefer `try { ... -ErrorAction Stop } catch {}`** over blanket `$ErrorActionPreference='SilentlyContinue'` (latter hides the error but still exits 1).
- **API/preference *writes*: use `curl` (Bash) or an MCP tool, NOT `Invoke-RestMethod -Method Put`** — the PS body/JSON round-trip silently no-ops. Reads via `Invoke-RestMethod` are fine.
- **Don't write `$var:`** — `$var` followed by `:` parses as a drive ref. Use `"${i}:"`.
- PS 5.1: no `&&`/`||`/ternary/`??`; default UTF-16 (pass `-Encoding utf8`); no Unix `head`/`tail`/`which`/`touch`/`grep` (use Read/Grep/Glob).

### Worktrees (read before testing/typechecking in one)
- **New worktrees get real `node_modules` via install-per-worktree** (Dependency Symlinks is now OFF for this project as of 2026-06-14; the worktree runs the project's setup script `pnpm install -r` on creation, ~10s against the warm pnpm store). So `pnpm test:mine` / `pnpm exec vitest` / `tsc` **run IN the worktree** — no "relocate to main" dance. Because the deps are a genuine install (not a junction into main), `pnpm install`/`add` in the worktree is **safe** and isolated — it can't write back into the main checkout. This is the same model new projects get by default (#810: registration derives the stack install command into `setup_script`, stack-aware — `pnpm install -r`, `cargo fetch`, `uv sync`, …). The opt-in junction fast-path still exists (Settings → project → Dependency Symlinks); it trades ~10s of install for Windows junction fragility — prefer install.
  - **Transition caveat**: worktrees created *while symlinks were ON* still hold junctions into main. For those, the old rule holds — **never `pnpm install`/`add` in a junctioned worktree** (writes through the junction into main); the `validate-command-safety` hook auto-isolates on a real dep change and blocks unnecessary reinstalls. Recreate such a worktree to move it onto the install model.
- **Run vitest FROM the worktree** (new test files exist only on your branch). **Opposite for `pnpm cli --`: run from the MAIN checkout** (worktrees lack `packages/shared/dist`; use MCP/REST instead). `--related` broken in vitest 4 — use `pnpm exec vitest related <file>` from the package, or `pnpm test:mine -- --changed HEAD`.
- **Migration number collisions**: parallel branches pick the same next number. Check the highest in the **main checkout** `packages/shared/drizzle` first. The test migration list (`packages/server/src/__tests__/helpers/migrations.ts`) is now **journal-derived** (reads `drizzle/meta/_journal.json`) — no manual edit needed to make tests see a new table; just give the new migration a `_journal.json` entry.
- **`git stash` is dangerous** — can silently drop tracked changes. Verify `git diff --stat HEAD`; prefer a WIP commit.

### Time-dependent tests
Inject optional `now?: string` (`nowOverride`) into any service calling `new Date()` for staleness/expiry; seed timestamps as `new Date(Date.now() - N).toISOString()`, never hardcoded ISO strings that age out.

**Two sanctioned spellings, because there are two jobs (#614)** — the same parameter was spelled nine ways across 178 declarations, so a reader could not tell whether a function was time-injectable without opening it:
- **`now?: string`** — ISO, for code that PERSISTS the value (it lands in a column).
- **`nowMs?: number`** — epoch ms, for pure arithmetic (`ageMs`, TTL comparisons).

Everything else (`nowIso`, `nowOverride`, `now: Date`, `now: () => number`, …) is grandfathered at its current count by `time-injection-spelling-ratchet.test.ts` and may only shrink. Adding a tenth spelling fails that gate — **true since #721**, and it was not true before: the gate was a regex over six hard-coded names, so it could only catch the REUSE of a spelling someone had already used, and `asOf: number` / `currentTimeMs: number` were both verified to pass. It now matches the SHAPE of an injection point on the TS AST (a `now`/`clock`/`instant` word or an `asOf…` prefix; a `time`/`date`/`epoch` word made specific by a currentness marker or by being optional/defaulted; or — name-independently — any time-typed parameter defaulting to or coalesced with a clock read), so a name it has never seen fails it too.

### In-flight workspace recovery
Don't resume many stale workspaces at once — one, then at most two more once healthy. A transcript showing ~1 s with zero tokens = launch-failed/stale; stop it and rebuild the branch.

## Agent Roles
Shared vocabulary; each maps to one mechanism — don't conflate.

| Name | Role | Mechanism | Trigger |
|---|---|---|---|
| **Conductor** | Out-of-process orchestrator driving an opted-in project (merge/unstick/start/refill) | `scripts/board-monitor/loop.sh` + a project objective; fresh session each ~30-min cycle | Dev board: `nohup bash scripts/board-monitor/loop.sh`; other projects: Start Mode `conductor` |
| **Autopilot** | In-process deterministic monitor (default for *other* projects; off here) | `runMonitorCycle`, `auto_monitor` pref | Settings → Workflow → Board Monitoring |
| **Steward** | In-process LLM monitor (off by default; reads `objective.md`) | `monitor-butler.ts`, `monitor_butler_enabled` | the `monitor_butler_enabled` pref |
| **Builder** | Per-ticket implementer in a worktree | `POST /api/workspaces` → agent in a worktree | New Workspace / Conductor |
| **Butler** | Warm conversational per-project assistant | Claude Agent SDK, in-process, one warm session/project | Butler view (`i`), `ask_butler`, `pnpm cli -- butler ask` |
| **Sentinel** | Human-side watch — polls Conductor health, reports one line, recovers only on failure | interactive Claude + `/loop` + cron | `/sentinel`, `sentinel` skill |
| **Smith** | Compounding-engineering session — analyzes past runs, forges durable improvements | `fleet-analysis`/`session-inspector`/`learning-step`/`distill-learnings` | those skills |

## Board-Monitor Orchestrator (this dev board)
The control plane for THIS board is the out-of-process loop `scripts/board-monitor/`: `loop.sh` spawns a fresh agent every ~30 min (`MONITOR_SLEEP`) reading `objective.md` (Claude unless `MONITOR_AGENT=codex`). Distinct from the in-process server monitor (off here, default elsewhere).

`objective.md` = single source of truth for monitor policy incl. its TUNABLE TARGETS block; re-read each iteration (no restart needed). The **Strategy Bullseye** UI (`board_strategy_<projectId>` pref) feeds all monitors via a generated `objective.md` block (agents) + `resolveMonitorTunables` pref read (deterministic); falls back to legacy `nudge_*` prefs. Per-cycle checklist = `board-monitor` skill; rationale = `docs/decisions/006-...md`.

> This board's `objective.md` DOES carry `STRATEGY_BULLSEYE_GENERATED_*` markers, so saving the Bullseye is safe: it rewrites only the block between them (TUNABLE TARGETS, STRATEGY WEIGHTS, PROVIDER POLICY) and auto-commits. The hand-authored `## FOCUS POLICY` block sits BELOW the END marker and is never touched — edit that one by hand. (An older caveat here claimed the file had no markers and that a Bullseye save would clobber it; that was stale, and verified so by an actual save in `839176433a`.)

### Driving a different project hands-off
**The single control for how a project's tickets get auto-started is its per-project Start Mode** (`start_mode_<projectId>` ∈ `manual | monitor | conductor`), resolved by `resolveStartPolicy()` (`start-policy.service.ts`) — the one decision EVERY auto-start path consults: in-process monitor **scheduling** (whether cycles run at all — `monitorShouldRun`/`monitorDrivenProjectIds` route through `resolveStartPolicy`, fixed ad729e70 per arch-review §3.4), per-cycle relaunch/merge/nudge, the post-merge dependency cascade, backlog refill, scheduled crons. Legacy `board_autodrive_<id>` is now DERIVED via `resolveStartPolicy` (back-compat), not read beside it — so `manual` is a true kill-switch and a `monitor` project schedules even with the global `auto_monitor` off. See decision 008. Set/observe it in the **Monitor view → Start Mode** control.
- **`manual`** — nothing auto-starts; only explicit `POST /api/workspaces` / relaunch. A true kill-switch (incl. the post-merge cascade, which previously leaked past every "drive" switch).
- **`monitor`** — the **in-process engine** (`runMonitorCycle` + auto-review/auto-merge + stranded-review reconciler) auto-starts unblocked backlog up to WIP. This is the supported hands-off driver for any project (NOT the Conductor / Monitor Butler — decision 006).
- **`conductor`** — the out-of-process loop is the sole driver; in-process stands down. The server supervisor launches `scripts/board-monitor/loop.sh` with that project's `repoPath`, `.kanban/objective.md`, and `.kanban/conductor/` state directory. Start/stop it from the Monitor view (Conductor mode) — `conductor-control.service.ts` / `POST /api/projects/:id/conductor`.
- **Back-compat / setDriveEnabled**: `board_autodrive_<projectId>="true"` (the legacy keystone) still works — Start Mode DERIVES `monitor` from it when `start_mode_<id>` is unset, and `setDriveEnabled` (the one-switch) writes `start_mode` (on=monitor/off=manual) so they never drift. Per-project Start Mode supersedes the global `auto_monitor`.
- Strategy Bullseye still feeds tunables via `resolveMonitorTunables` (no `objective.md` needed; `writeStrategyObjective` no-ops for non-Conductor repos). Legacy fallback: WIP = `nudge_wip_limit`, `backlogFloor=3`, `maxNewStartsPerCycle=3`.
- Tag an issue `no-auto-start` to keep the monitor from launching it.

## Worker Fleet (remote compute)
Agents can execute on OTHER machines. Workers dial the board (`agentic-kanban worker start --board <url> --token <pairing-token>`), hold a WebSocket for assignments, and stream output back — the board's broadcast/persistence/exit-classification are untouched, because only PLACEMENT moved (`Placement = host | container | remote`, dispatched in `agent-dispatch.service.ts`). Decision 012.
- **Opt in per project**: `worker_dispatch_<projectId>=true`; require capabilities with `worker_labels_<projectId>=docker,linux`; `worker_dispatch_strict_<projectId>=true` forbids the host fallback (the monitor then skips with `no_available_worker` instead of running locally).
- **Git transport**: the board serves its repos over token-authed git smart HTTP; a worker clones, works in its OWN checkout, and pushes to `refs/kanban/incoming/<branch>` (pushes to `refs/heads/*` are refused — those are checked out in board worktrees). The board fast-forwards the real branch from there, so diff/review/merge are unchanged. **Fast-forward only** — divergence is held and reported, never forced.
- A worker on the SAME machine can skip git transport with `worker start --shares-filesystem`.
- **Credentials never leave their machine**: a worker authenticates its agent with its own local login; the board sends none. Enforced (#244), not just intended — the remote launch spec's env comes from the allowlist in `packages/server/src/lib/remote-spec-env.ts` and the worker MERGES it over its own environment. Adding a var an agent needs remotely means adding it to that allowlist; anything credential-shaped is rejected there by design.
- **Git tokens are per assignment** (#247): scoped to one worker + one project + one incoming ref, expiring, and invalidated by `revokeWorker` (which also closes the worker's live socket). The startup incoming-ref sweep lands a ref only when the DB holds a matching dispatch (#246) — an unmatched ref is held and reported, never fast-forwarded.
- **The board ASKS instead of waiting** (#887): a worker remembers every `sessionId` it was ever handed, so `probe_session` → `unknown` is an AUTHORITATIVE "the assignment never arrived", not a timeout's guess (measured: a lost assign held a session 100 minutes). Sent once, after `ASSIGN_SILENCE_PROBE_MS` of zero output. **Silence is NOT `unknown`** — a worker older than the message cannot answer, so an unanswered probe holds exactly as before and #883's silence TTL stays the backstop. `unknown` counts only from the worker the session was assigned TO. Board half: `services/agent-remote-liveness.ts` (which also owns the free half — the `hello` reverse-reconcile); worker half: `worker/worker-session-registry.ts`.
- **Strict dispatch is enforced at LAUNCH time too** (#245): `strict` rides on the `Placement`, so a worker vanishing between placement and `assign` fails the session with `NO_AVAILABLE_WORKER` instead of quietly running on the board host.
- **Never `KANBAN_HOST=0.0.0.0` for a fleet** — the board API has no auth. Expose `KANBAN_FLEET_PORT` (worker register/heartbeat/ws only) and `KANBAN_GIT_HTTP_PORT` (git transport only) instead; both are opt-in, bearer-token authed, and the board API is never mounted on them. Remote workers point `--board` at the FLEET port. `KANBAN_FLEET_HOST` / `KANBAN_GIT_HTTP_HOST` narrow WHICH interface each one binds (absent = every interface, as before) — on a VPN that is what turns "keep it on a trusted network" into an actual control. Don't put a path-based reverse proxy (`tailscale serve`, an nginx prefix) in front of the git transport: the worker rebuilds the URL as `scheme://<host>:<git-port>/git/<projectId>` and drops the prefix, so the clone hangs with no visible cause.
- UI: command palette → "Worker Fleet" (pair/revoke, status, capacity, labels).

## Server Resilience
Agent subprocess callbacks wrapped in try/catch in `agent.service.ts`; `uncaughtException`/`unhandledRejection` log `[fatal]`; stale sessions cleaned on startup in `index.ts` after migrations. `auto_monitor` force-disabled on every boot.

## Agent Skills
Prompt templates in the `agent_skills` table, written to `.claude/skills/<name>/SKILL.md` in the worktree on creation. API: `GET/POST/PUT/DELETE /api/agent-skills` (`?projectId=` = global + project); MCP: `list/get/create/export_agent_skills`.
- **Built-in** (`packages/server/src/builtin-skills.ts`, `isBuiltin: true`, `pnpm db:seed`): `board-navigator`, `code-review`, `code-review-thorough`, `dependency-analyzer`, `ticket-enhancer`, `orchestrator`, `monitor-nudge`, `kanban-workflow`, `backlog-markdown` (agentic import/export of a backlog as one `.md`, see `docs/backlog-markdown.md`), `fleet-worker`. Generic, shipped in npm.
- **Project-specific** live only in `.claude/skills/` (e.g. `publish`, `cleanup`, `board-monitor`, `dev-server`, `db-doctor`) — **do NOT add to `builtin-skills.ts`**. `session-inspector` is **not a copy here any more** (2026-08-26): it is a gitignored junction to `C:\projectsndrena\claude-session-tools\session-inspector` (github.com/p-wegner/session-inspector-skill), the single source of truth — recreate the junction on a fresh clone. Board-local session scripts with no counterpart there (`scripts/session-rank.mjs`, `scripts/output-style.mjs`, `scripts/analyze-failure-recovery.mjs`) stay in `scripts/`.
- The review prompt uses built-in `code-review`; override per-project with a project-scoped `code-review` skill. Placeholders: `{{branch}}`, `{{baseBranch}}`, `{{issueId}}`, `{{autoFixInstructions}}`.
- A **plugin** skill is junctioned into `.claude/skills/<name>` on enable, so it is a *disk* skill with a whole bundle (`tools/`, `references/`), not a DB row. Both the scanners and `copySkillToWorktree` handle that now — junctions are followed (`readdir` reports them as symlinks, never directories) and the FULL directory is copied into the worktree, since a skill whose `tools/` is missing documents commands that don't exist.

### Bundled skills — a DIRECTORY that ships in the package, generated from source
`packages/server/skills/<name>/` (in `files`, so it ships on npm). Today: **`agentic-kanban`** — the
board's own feature map for any agent on any machine: a hand-written overview plus `references/`
(concepts, workflows, and a generated MCP-tool / CLI / views-and-shortcuts reference).

Why a directory and not another `builtin-skills.ts` string: a prompt string cannot carry a
`references/` bundle, and it cannot be **linked**. A bundled skill is junctioned into its install
target, so one install keeps tracking the package across upgrades instead of rotting into a copy of
last release's feature list.

- **Generated from source, not maintained by hand.** `node packages/server/scripts/generate-bundled-skill.mjs`
  (`pnpm skill:generate`) extracts the MCP tool table, every CLI command group, the view registry and
  the shortcut registry, and rewrites only the `<!-- GENERATED:… -->` blocks plus the `commit:` stamp
  — the prose between them is hand-written and never touched. `--check` (`pnpm skill:check`) exits 1
  when the committed output differs from what source would produce now.
- **The gate is content-based, not SHA-based** — `bundled-skill-freshness.test.ts` (`@gate:always-run`,
  it spawns the generator over the whole tree) fails only when an enumerable thing actually changed.
  So adding an MCP tool or a CLI command turns it red until you re-run the generator; editing an
  unrelated file does not.
- **Install:** `agentic-kanban install-skill [path]` (project) or `install-skill --user` (every
  `~/.claude*/skills` and `~/.codex/skills` on the machine), MCP `install_skill`. Junction by default,
  `--no-link` to copy. A junction that cannot be created (npx cache, no symlink permission) degrades
  to a copy and SAYS SO rather than failing.
- **`--user` is bundled-only** unless a prompt-only built-in is named with `-n`. The prompt-only
  built-ins are per-project working prompts the board materializes into worktrees itself; installing
  them machine-wide would offer every agent in every repo a review prompt written for one board. Both
  rules (this one, and bundled-beats-same-named-prompt) live in `selectSkillsToInstall` — call it
  rather than re-deriving either at a new install site.
- **Check:** `agentic-kanban skill verify [path] [--user]` — `linked` (cannot go stale), `current`,
  `stale`, or `absent`; exit 1 on stale, so it works from a hook or CI.
- A bundled directory **wins over a same-named DB built-in** in both the CLI and the MCP tool: it is
  the richer form of the same skill, and installing both would leave the loser's `SKILL.md` behind.

## Plugins
**Writing or reviewing one? Read [docs/plugin-development.md](docs/plugin-development.md) first** — the self-contained guide (lifecycle, every field, the four loop rules that fail silently, a copy-pasteable minimal plugin, a test recipe, a checklist, and the known gaps). It is written for an agent with no prior knowledge of this board, so it is also the thing to hand to one.

**Improvement net** = the board plus the plugin family for tool-assisted, ambitious refactoring of large legacy projects (understand & protect → measure → find potential → change safely → track & learn; findings become tickets, and what the tools lack flows back to the toolset as backlog). Pattern + hand-offs: `docs/plugin-development.md` § "Plugins that form an improvement net". The concrete plugins are not part of this repo; an installed plugin's `docs[]` page (Plugins menu) is where their map lives.

A plugin is a repo with a `kanban-plugin.json` manifest (`packages/shared/src/lib/plugin-manifest.ts` is the contract). It declares `skills`, iframe `views` (supervised child servers), one-shot `scripts`, `loops`, a butler `promptFragment`, and a `scaffold` template. Install once (Settings → Plugins), enable per project (`plugin_enabled_<slug>_<projectId>`); the **Plugins board view** is where all four kinds are started. Reference implementations: **refactor-safety-net** (many skills + views) and **reqextract** (four loops, bootstrap unit, state outside the plugin checkout, offline self-test).

**`loops` = board-owned converging analysis.** The plugin contributes only a deterministic `plan` command printing the outstanding work units as JSON; the BOARD does everything that spawns an agent — a ticket per unit carrying the loop's skill, started by the monitor within the project's WIP limit, under the Strategy Bullseye's provider selection and the auth-rotation ring (a quota-exhausted profile rotates mid-loop). Loop state IS the tickets, so it survives a restart with no private run-log.
- **Unit ids are the planner's contract.** Each ticket stores `pluginLoopUnitKey(slug, loop, unitId)` in `external_key`, and an advance skips any unit already ticketed — terminal or not. A planner wanting another pass must mint a FRESH id (`billing:r3`), which is what makes an infinite ticket loop impossible.
- A round is only replanned once its tickets are all terminal, and only for a loop that already has tickets — so `advanceDuePluginLoops` (monitor pass) *continues* loops a human started and never starts one itself.
- **`converged` is a claim about the JOB, not the current ready set.** A loop with nothing to do *right now* because its upstream is unfinished must report `units: [], converged: false` (the board's "blocked, not done"); reporting `true` ends a loop that then needs a human to restart it.
- **`{{repoPath}}` is the OUTPUT repo** (leading repo, or the `<slug>-requirements` sidecar), not the product repo; **`{{leadingRepoPath}}` is always the product repo** regardless of output location (#213), so a plugin that READS the source and WRITES elsewhere expresses that with the two placeholders and works in sidecar mode. What still has no placeholder is a SIBLING repo — one that is neither leading nor the plugin's own output.

## Skill Map
| Need | Skill |
|---|---|
| Start/stop/health-check dev server | `dev-server` |
| DB migration/lock/WAL issues | `db-doctor` |
| Flaky vs real test failure | `flaky-test-triage` |
| New Playwright E2E test | `e2e-author` |
| Visually verify a UI change | `playwright-cli` |
| Scope-creep check before commit | `scope-guard` |
| Board via MCP / reflect progress | `board-navigator`, `kanban-workflow` |
| Per-cycle board health | `board-monitor` |
| Drive a stuck issue to master | `unstuck` |
| Clean up stale worktrees/sessions/artifacts | `cleanup` |
| Publish/release npm package | `publish`, `release` |
| Change directly on master | `direct-master` |
| Tune the board along a dimension (docker/multi-repo, observability, token-efficiency, ticket-sizing) — build fixture → drive → measure → file gaps → fix | `board-tuning-lab` |

## Clean-clone / first-start blockers (Windows)
Full symptom→cause→fix in `docs/install.md` (“Clean-clone / first-start gotchas”). The `dev-server` skill Step 0 handles bootstrap automatically (no DB → `pnpm db:setup`; 0 projects → register). Key facts for triage:
- **`spawn pnpm ENOENT`** — fixed: launcher/preflight scripts re-invoke pnpm via `npm_execpath` (`scripts/pnpm-exec.mjs`), so any pnpm install method works. If it still fires, pnpm is missing from PATH entirely.
- **Client shared resolution** — fixed; `vite.config.ts` uses `development` condition → `src/`. Fallback: `pnpm --filter @agentic-kanban/shared build`.
- **Backend hangs (proxy up, nothing on 13001)** — `tsx watch` + Node 23.x on Windows; use Node LTS 22 (the declared floor since #731; Node 20 is EOL).
- **DB location** — `packages/server/kanban.db`; absent → falls back to `~/.agentic-kanban/kanban.db` (board looks empty).

## Common Commands
- `pnpm dev` — server + client (worktree ports: main 3001/5173, `feature/<N>-…` = `3001+N`/`5173+N`). `pnpm dev:desktop` adds Tauri. Safe headless launch: `dev-server` skill.
- **Inner loop (default while editing) — the impact selection, not the package suite (#953).** `test:mine` with no scope runs WHOLE packages, so the "fast loop" on a server-side ticket is thousands of tests; the test-impact skill picks ~6 files in ~0.4s from the same change. Run from the worktree root, guarded because the copy is best-effort:
  ```sh
  [ -f .claude/skills/test-impact/tools/impact.mjs ] && node .claude/skills/test-impact/tools/impact.mjs select --min-score 1.0 --format vitest
  ```
  Then run what it prints. **`select`, never `build`** — the skill resolves its root via `git rev-parse --show-toplevel`, so a rebuild here writes a worktree-local `docs/tests/impact-map.json` that helps nobody, lands in your diff, and breaks the single-writer property; keeping the map fresh is #952's job on the main checkout. **A green impact selection is NOT a green gate** — it is a ranked guess that narrows the run, so it tells you an edit did not obviously break something, nothing more.
- `pnpm test:mine` — fast loop (green unit suites; skips known-flaky). Takes `-- --changed HEAD` and patterns. **This is the gate**, unchanged: run it (and the full `pnpm --filter agentic-kanban test` for cross-cutting changes) before mark-ready, whatever the impact loop said. `KANBAN_TEST_SELECTOR=impact` swaps its `vitest related` scoping for the same test-impact ranking (opt-in, fail-open, #951) — not the default until #954 has produced a measured miss rate.
- `pnpm test:e2e` — Playwright E2E. `pnpm db:migrate && pnpm db:seed` — init DB. `pnpm cli -- register <path>`/`list`/`cleanup` — project & worktree management.

## Workspace Flow
`POST /api/workspaces` creates DB record + worktree + auto-launches the agent. Then: `/turn` (follow-up; takes `content` not `message`; 409 if busy), `GET /diff` (vs `baseBranch`), `/merge` (into `defaultBranch`), `DELETE` (cascades sessions + messages). Loop: register repo → create issue → new workspace → diff → merge.

## Documentation Map
- `.llm/workflows.md` — clean-start, DB reset, registration, migration diagnosis
- `docs/prd/` — `00` vision, `05` MVP scope/stages, `03` data model, `04` agent integration, `06` testability
- `docs/decisions/` — numbered decision records (`003` Butler, `006` board-monitor, `008` Start Mode, `012` worker fleet)
- `docs/backlog-markdown.md` — Backlog Markdown (`kanban-md 1`): the one-file backlog format, export filters, liberal import + preview, UI/REST/CLI/MCP/skill surfaces
- `docs/state.md` — progress
- `packages/server/CLAUDE.md` — server-package detail (incl. Butler ops)
- `scripts/board-monitor/README.md` — run/stop/observe the loop

# Architecture and environment notes

_Moved verbatim from the root `CLAUDE.md` on 2026-09-25 (token pass). CLAUDE.md keeps the rules; this page keeps the rationale, incidents and detail. Section headings are the originals._

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


### A builder writes ONLY in its own worktree — foreign repos included (#959)
`prevent-cross-worktree-writes.js` guarded other worktrees OF THE SAME REPO. An unrelated
checkout is neither the main checkout nor a linked worktree, so it was uncovered — and a
builder scoped to `ak-954` edited and COMMITTED into `test-impact-skill`, a repo not
registered on the board. The session that owned that repo then pushed the commit to its
origin believing it was its own work; nothing on the board surfaced it, and the diff happened
to be correct, which is what made it dangerous rather than obviously bad.

The guard now HARD BLOCKS a write into any other git repository, through both doors — write
tools and shell commands (`git -C <foreign> commit`, a `cd` into it, a redirect into it) — via
the one script all three providers already delegate to, so Claude/Codex/Pi are covered
together. **If a card needs a change in another repo, ASK for it**: file a ticket against that
repo's project, or hand it to the session that owns the checkout. Do not make the change.

Three things stay allowed, deliberately: READS anywhere (a builder legitimately reads sibling
repos and materialized skills), writes to paths in no repository at all (`%TEMP%`, `~/.claude`,
caches), and writes into a multi-repo project's SIBLING worktrees (peers under the same
`.worktrees/` root). The foreign-repo check only arms when the board declared
`KANBAN_WORKTREE_DIR` — without it the authorized root is derived from cwd and would be
compared against itself, so a hand-run session keeps the old same-repo-only scope.

### Commit messages carry no UTF-8 BOM (#976)
Write the message file for `git commit -F` with the **Bash** tool (a heredoc), never a bare
PowerShell redirect: PS 5.1's `Set-Content`/`Add-Content`/`Out-File` default to UTF-8 **with a
BOM**, `git commit -F` keeps it, and the subject then starts with an invisible `EF BB BF`. It
renders as a stray glyph in `git log --oneline` and breaks anything that pattern-matches a
subject — including this board's own `ak-<N>` matching in the hand-merged-branch reconciler and
`checkAlreadyMerged`. Measured: 77 commits, 1 in 2026-05 rising to 53 in 2026-08 as more work
went through builders. `-Encoding utf8NoBOM` is the PowerShell escape hatch.

Two backstops, because the rule alone was never going to hold: every worktree gets a
`commit-msg` hook that STRIPS the BOM (`installCommitMsgHook`,
`services/workspace-provision.service.ts` — it also carries the optional TDD gate, since git
allows one such hook per repo), and `commit-subject-bom-ratchet.test.ts` fails on any commit
newer than its pinned baseline whose subject begins with one. The existing 77 are NOT rewritten:
a landed commit is not rewritable here once built upon, and the defect is cosmetic-plus-fragile,
not corrupting.

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
- **Nested worktrees (`<main>/.claude/worktrees/*`, Claude Code's EnterWorktree layout) get NO `pnpm install` and NO `pnpm dev` (#1033, mechanism proven by #1037).** On 2026-09-04 the MAIN checkout's `node_modules` links (root + every package) were wiped twice, each time 30-50 s after `pnpm dev` was launched from such a worktree — no junction between the trees existed, and no purge tool on this box follows a junction (measured: node `rmSync`, `robocopy /MIR`, `Remove-Item -Recurse`, `git worktree remove`, `rm -rf`, `rmdir /s`). **#1037 proved the mechanism and it is NOT a nested-cwd install escaping into main** — a direct repro (`pnpm install --force` with cwd inside a nested worktree, junction or not) stays fully contained to that worktree's own `node_modules`. The real path: MAIN's own already-running `pnpm dev` recursively scans for `package.json`/`pnpm-lock.yaml`/`pnpm-workspace.yaml` to detect real dependency changes (`scripts/dev-supervisor.mjs`), and that scan did not exclude `.claude` — so a nested worktree's own manifests (which it always carries, install or not) changed the file SET MAIN sees, with zero commands ever run at a nested cwd. The next time any of MAIN's own dev children had an unrelated fatal exit after running healthily (e.g. the #117 vite ws-proxy crash), MAIN's supervisor concluded "manifests changed" and self-triggered `pnpm install --frozen-lockfile` **on MAIN** while its dev server still held files open — an install that can abort mid-relink (Windows EPERM) between removing the stale top-level links and recreating them, leaving `.pnpm`/`.modules.yaml` intact but the top-level links gone: exactly the observed signature. **Fixed at the root**: `.claude` is now in `dev-supervisor.mjs`'s `IGNORED_DIRS`, so a nested worktree can no longer poison MAIN's own dependency-manifest snapshot; pinned by `packages/server/src/__tests__/dev-script.test.mjs`. `validate-command-safety`'s refusal of installs/dev-launch from a nested cwd (operator override `KANBAN_ALLOW_NESTED_WORKTREE_INSTALL=1`) stays as defense-in-depth but was never the fix. Put checkouts that need deps OUTSIDE the main tree — the board's sibling `.worktrees/` layout — and remove finished directories with `node scripts/safe-rmdir.mjs <dir>` (refuses a tree with an outbound reparse point; `--dry-run` lists them) instead of `robocopy /MIR` / `Remove-Item -Recurse`. If main's links vanish again: `pnpm install -r --offline` in main restores them in seconds; the running server survives because its modules are already loaded.

### Time-dependent tests
Inject optional `now?: string` (`nowOverride`) into any service calling `new Date()` for staleness/expiry; seed timestamps as `new Date(Date.now() - N).toISOString()`, never hardcoded ISO strings that age out.

**Two sanctioned spellings, because there are two jobs (#614)** — the same parameter was spelled nine ways across 178 declarations, so a reader could not tell whether a function was time-injectable without opening it:
- **`now?: string`** — ISO, for code that PERSISTS the value (it lands in a column).
- **`nowMs?: number`** — epoch ms, for pure arithmetic (`ageMs`, TTL comparisons).

Everything else (`nowIso`, `nowOverride`, `now: Date`, `now: () => number`, …) is grandfathered at its current count by `time-injection-spelling-ratchet.test.ts` and may only shrink. Adding a tenth spelling fails that gate — **true since #721**, and it was not true before: the gate was a regex over six hard-coded names, so it could only catch the REUSE of a spelling someone had already used, and `asOf: number` / `currentTimeMs: number` were both verified to pass. It now matches the SHAPE of an injection point on the TS AST (a `now`/`clock`/`instant` word or an `asOf…` prefix; a `time`/`date`/`epoch` word made specific by a currentness marker or by being optional/defaulted; or — name-independently — any time-typed parameter defaulting to or coalesced with a clock read), so a name it has never seen fails it too.

### Merge-train red handling (#1277)
A red train gets ONE fix agent before any control arm or bisect. Per project, through the preference layer: `merge_train_red_strategy_<id>` = `agent-fix-then-bisect` (default) | `agent-fix` (a second red is final) | `bisect` (today's behaviour), plus the caps `merge_train_agent_fix_max_turns` / `_timeout_ms` / `_cost_cap_usd`. Resolved by `resolveMergeTrainRedPolicy` (`shared/lib/merge-train-red-strategy.ts`); nothing else reads the raw keys. The agent runs INSIDE the whole-train staging gate's worktree (`runTrainStagingGate`'s `onRed`, deps already installed), is launched with `KANBAN_WORKTREE_DIR` set to it so the cross-worktree write guard confines it (#959/#369), commits onto the train ref, and the gate is re-run on that tree; green lands the FIXED tip. It is its own `attempts[]` row (`kind: "agent_fix"`, label `<train>f`). Limits to know: the one-shot provider path reports no session id or usage, so the cost cap binds only a runner that reports it; a fixed tree is never re-assembled, so a base move refuses the landing and a train-review siding after a fix turns red (both would drop the fix).

### In-flight workspace recovery
Don't resume many stale workspaces at once — one, then at most two more once healthy. A transcript showing ~1 s with zero tokens = launch-failed/stale; stop it and rebuild the branch.


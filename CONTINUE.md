# Continue

Where to pick this up. Present-tense, current state only — see `BACKLOG.md` (exported from
the board, `pnpm cli -- backlog export`) for candidate future work.

## 2026-09-04 — the profile-roster wave landed; the cut-off merge batch finished by hand

The 2026-09-04 session (0cf4fadb) drove #1025 → #1026 → #1028 → #1027 and hit its usage limit
at 12:22 UTC with two merge subagents mid-flight. This pass finished them. Everything below is
verified against master and the live board unless it says otherwise.

**Landed on master today, in order:** `7639c4b7bd` (#1026 follow-up: `profile-selection-reason`
moved to `server/src/lib`), `955553d3a0` (**#1027** merge, feature commit `eeaa0e5261`),
`06c5512005` (temp-dir fix `76c6d7ddf3` for #1012/#1024), `bbd76da50c` (guard inventory),
`edbc4fabd4` (CONTINUE archive move). Earlier the same day, by the cut-off session: #1025
(`f543bdfe03`), #1026 (`80d2d8380c`), #1028 (`592479ad35`), the scripts-tier git adapter
(`550a82063a`).

**What the cut-off merge agent had left.** `worktree-agent-a4f985c7d4f1a39cb` sat in an
interactive rebase of #1027 onto master with ONE conflicted file, `oauth-quota-provider.ts`
(master's #1023 threads `nowMs` per tick; #1027 extracts the engine to a shared poller). Its
"keep both" resolution was in the working file but the shared poller still owned a clock, so it
would not have typechecked. Resolved: the poller holds no clock, `refreshOne(profiles, nowMs)`.

**Then the branch was red on five more gates, all fixed before it touched master:**
- **`shared-lib-single-consumer-ratchet`** — #1027's three new modules (`local-profile-discovery`,
  `oauth-quota-core`, `worker-profile-attestation`) had one consuming package. Moved into
  `packages/server/src/lib` like #1024/#1016, no grandfather entry. The same ratchet was ALREADY
  RED ON MASTER from #1026's `profile-selection-reason.ts`; fixed first as its own commit.
- **four suites failed to load** — `worker-profiles.ts` still imported `profile-attributes` from
  shared, which master had moved in #1024.
- **`time-injection-spelling-ratchet`** — `nowMs?: () => number` grew 2 → 3. The attestor now
  takes `current(nowMs?)` / `refreshQuota(nowMs?)` instead of a clock option.
- **`function-nloc-ratchet`** — ninth disclosed movement in `function-nloc-baseline.ts`:
  `createRemoteAgentService` 637→638, `createWorkerAgentRunner` 351→358.
- **`temp-dir-namespace-guard`** — #1027's fixture prefix `ak1027-` → `ak-1027-`; the two
  remaining offenders were #1024's and are what the temp-dir branch fixed.

**Verified by what.** On master after both merges: `pnpm typecheck` green (18s),
`check-god-modules` OK, `promote.mjs --dry-run` plans, 4 shared + 18 server suites green
(197 tests, incl. every ratchet above), `/api/health` ok, `GET /api/profile-roster` returns the
13 known profiles. `pnpm lint:arch` still crashes with `chalk.Instance is not a constructor` —
environmental, see #1033 below, NOT a code finding.

**Board.** #1027 Done (its stale `blocked` workspace `0dba7fb7` was CLOSED via
`POST /api/workspaces/:id/close`, not deleted — its branch had been reset to master and held no
unique commits; the ticket could not move to Done while it was open). #1028 Done after the owed
visual verification with playwright-cli against 5173: Settings › Agent shows the per-project
narrowing editor (13 profiles, reserve checkbox, "Pool exhausted at 90 %", "Would launch on
claude:anth") and the global roster table (Profile/Role/5h/7d/Resets/Measured/Cooldown, one
profile with a live 10 %/2 % reading, the rest `unknown`/`never` because the poller measures
one profile per tick); the Monitor view shows no roster warnings, correctly —
`ProfileRosterWarningsSection` returns null unless a reserve start or role conflict exists, and
every profile here is `pool`. Note comments with shas are on #1027, #1028, #1012, #1024.

**Cleanup.** The three landed `.claude/worktrees/agent-*` worktrees and their branches are gone.
Five OTHER `agent-*` directories remain under `.claude/worktrees/` that `git worktree list` does
not know (a0c47…, a27c3…, a49a3…, a6056…, aba96…) — not this session's, left alone.

**Not done, deliberately — the #1033 dependency repair.** Main's `node_modules/.pnpm/*` lost
sibling links (e.g. `.pnpm/dependency-cruiser@17.4.3/node_modules` holds only itself, so
depcruise resolves the hoisted chalk 5 and dies). `pnpm install -r --offline` is a no-op
(lockfile satisfied). The fix is `pnpm install -r --offline --force` in MAIN with the dev
server STOPPED (running vite holds `lightningcss-win32-x64-msvc` open → EPERM), then restart
via the `dev-server` skill. Not run here: it takes down the board that operates every project
while four other sessions sit on the box, and the only thing it currently blocks is
`lint:arch`. Decide, then run it as one deliberate operator step.

**Tried and rejected.** Deleting #1027's stale workspace (would cascade the builder's session
record; `close` keeps it). Grandfathering the three shared modules on a promised worker package
(the fleet worker IS `packages/server/src/worker`, so the count would be 1 forever — the same
reasoning #1024 wrote down).

## Where this stands (2026-09-04)

**Read this section before anything below it.** Everything under a dated heading describes the
state at the time it was written. Standing state lives here and nowhere else.

### Verified now (2026-09-04)

- **Branch `master`, working tree clean, 74 commits ahead of `origin/master`.** `origin` =
  GitHub `p-wegner/agentic-kanban`; there is a second remote `gitlab` — do not confuse them.
- **The profile-roster wave is complete:** #1024 (attributes), #1025 (roster roles), #1026
  (predictive rotation), #1027 (worker attestation, protocol v2), #1028 (roster UI) all Done.
- **Board (agentic-kanban project):** In Review #1013, #1014 (blocked); Todo #1030; Backlog
  incl. #1033.

### Next steps, in order

1. **Operator: the #1033 forced reinstall** (see above) — one deliberate step with the dev server
   stopped; it un-breaks `pnpm lint:arch`.
2. **#1013 / #1014** (In Review) — stable/dev board split and the promote script; #1014 is
   marked blocked.
3. **Operator: decide the push.** 74 commits, clean fast-forward; the Linux CI run is what #923
   needs.
4. **`pnpm --filter agentic-kanban test` on an idle box** — the whole-repo gate remains the
   outstanding verification; only targeted suites ran today.

### Operator flag — RESOLVED, not open (corrected 2026-08-27)

`packages/server/kanban.db` does not exist; CLI and server both open
`C:\Users\pwegner\.agentic-kanban\kanban.db`. The `[db] opening ... (source: home-fallback)`
line is the NORMAL path, not a warning — do not re-file it as a defect.

## Archive

Passes older than 2026-09-04 have been moved **verbatim, newest first** into
[`docs/archive/CONTINUE-archive.md`](docs/archive/CONTINUE-archive.md). Nothing is re-verified or
edited on the way in, so it records what each session believed at the time. Look there for the
2026-09-01/02 wave (#986/#992/#994/#995/#996/#997/#998/#999 and the verification-cadence pass), the
2026-08-25..28 waves (#924, #807, #903, #901, #857, #874, #887, #899/#898/#897, #894, #881, the
26-ticket direct-master batch, #859's root cause, the UI overflow sweep), and before them the #680
gate-hermeticity history, the "batch 1 of N" true-state table (#691), the 2026-08-21/22/23 waves,
the adversarial review, and the hook-cost investigations.

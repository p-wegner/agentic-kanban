# Learning: Autonomous board-monitor + copilot loop kept crashing the server on merge

**Date:** 2026-05-27
**Severity:** High — the live server crashed twice and required manual `git merge --abort` recovery; the autonomous loop repeatedly stalled.
**Short version:** A board-monitor was set up to run copilot agents autonomously (WIP 5, auto-start, auto-merge, 10-min cron). It worked for implementation but the *merge* step kept taking the server down. Root cause is structural: the orchestrating server runs from the very repo the agents are rewriting, under `tsx watch` — so every merge rewrites watched files, hot-reloads the server, and a merge interrupted mid-flight leaves `_journal.json` with conflict markers (invalid JSON) that crash startup. Four bugs were filed (#41–#44); #42 (abort-on-conflict) and #41 (idle+ready merge) landed during the session.

---

## The setup

- App's server-side monitor: `auto_monitor` (10-min), `nudge_auto_start`, `provider=copilot`, WIP limit 5 (`nudge_wip_limit`, hardcoded default — not in the settings whitelist).
- A supplementary CronCreate job (every 10 min) for the parts the app monitor can't do: conflict scan, health checks, Backlog→Todo feeding, and `/ui-explorer` when the backlog runs low.
- `auto_merge` on, so finished work merges to master unattended.

## What went wrong (in the order we hit it)

1. **`auto_monitor` disabled on every boot.** `startup-tasks.ts:91` force-writes `auto_monitor=false` at startup (safety default). Agent-driven hot-reloads kept turning the monitor off, so the cron had to re-enable it every cycle. The server-side monitor is therefore *not* actually durable across restarts.
2. **Cron is session-only.** `durable:true` on CronCreate did **not** write `.claude/scheduled_tasks.json` (only a `.lock`). The whole loop dies when the Claude session ends.
3. **Auto-start only pulls from Todo.** New tickets sit in Backlog forever unless something moves them to Todo. The cron had to feed Backlog→Todo by hand each cycle.
4. **Idle + readyForMerge workspaces never merge.** The monitor only merges `reviewing`+`stopped`; a finished workspace that goes `idle` with `readyForMerge=true` gets *relaunched* instead. Ready work piled up in In Review. (Filed #41 — landed this session.)
5. **Merge conflict in `_journal.json` crashed the server.** Parallel branches each add the next sequential migration (`0045_*`), so they conflict in the migration journal. The real `git merge --no-ff` ran in the **main checkout**, hit the conflict, and left it mid-merge (`MERGE_HEAD` + `<<<<<<<` markers). The conflicted `_journal.json` is invalid JSON → unguarded `JSON.parse` in `manual-migrate.ts` crashed startup. (Filed #42 — landed: abort-on-conflict + startup journal guard.)
6. **#42's in-process abort isn't enough.** A merge rewrites watched files → `tsx watch` hot-reload **kills the server process mid-merge before the catch/abort runs**. Rapid sequential merges (5 at once) guarantee this: merge #1's reload interrupts merge #2. (Filed #44 — urgent, open.)
7. **Agent work leaks into the main checkout.** Issue #40's changes appeared *uncommitted in main* even though #40 had its own worktree and agents launch with `cwd=worktreePath`. A dirty main tree blocks every merge ("local changes would be overwritten"). Mechanism still unknown. (Filed #43 — open.)
8. **Orphaned worktrees** from the 2026-05-26 DB reconstruction (stale branch names like `ak-32-decompose-server` while #32 is now "Graph view") clutter the repo.

## The root cause beneath most of these

**The orchestrator runs the same code the agents are rewriting.** The board server runs from `C:\andrena\agentic-kanban` under `tsx watch`. Agents modify that codebase and merge into the master it runs from. So normal, successful operation (merging finished work) destabilizes the very server doing the orchestrating. Bugs #42/#44 are mitigations; the structural fix is to stop self-hosting the orchestrator on the live working tree.

## Recovery procedure (proven this session)

A merge left mid-flight is recoverable — the feature branch stays intact:
1. The server will be **down** (invalid `_journal.json`). This is the safe window — git in a *live* main checkout is what corrupts the DB; with the server down it's safe.
2. `git merge --abort` in the repo root → clears `MERGE_HEAD`, restores valid `_journal.json`.
3. Verify: `node -e "JSON.parse(require('fs').readFileSync('packages/shared/drizzle/meta/_journal.json','utf-8'))"` and no `<<<<<<<` markers remain.
4. Restart: `nohup pnpm dev > /tmp/kanban-dev.log 2>&1 & disown`; wait ~17s; `GET /health`.
5. Re-enable `auto_monitor` (boot disables it). Keep `auto_merge=false` until #44 lands.

## What worked

- **Single, well-spaced merges always succeeded** (#25, #41, #42). Only rapid/parallel merges crashed. Operating rule until #44: **one careful merge per cycle**, wait ~18s for the reload, verify via git, recover if needed.
- **Rebasing conflicting branches** (`POST /update-base {mode:rebase}`) is worktree-local and never touches main — the safe way to make a conflicting branch mergeable.
- **The empty/500 API error on a successful merge** is just the connection dropping as the server hot-reloads after the merge commits. Always verify the result via `git log`, not the HTTP response.

## Fixes filed

| # | Title | Status |
|---|---|---|
| #42 | Merge conflict in `_journal.json` leaves main mid-merge and crashes server | **Done** (abort-on-conflict in `mergeBranch` + startup journal guard) |
| #41 | Monitor never merges idle + readyForMerge workspaces (relaunches them) | **Done** |
| #44 | Hot-reload kills merge mid-operation — process-killed path #42 misses | Open (urgent) |
| #43 | Agent/review work leaks uncommitted into the MAIN checkout, blocks merges | Open |

## Systemic improvements recommended (beyond the bug tickets)

1. **Decouple the orchestrator from the code under test** — run the board server from a separate, stable checkout (or the published package / a built artifact, not `tsx watch`) so agent merges don't hot-reload the server orchestrating them. *Biggest win; ends the crash class outright.*
2. **Make the server-side monitor self-sufficient** so the loop needs no live Claude session or cron babysitting: stop force-disabling `auto_monitor` on boot; pull auto-start from Backlog (not just Todo); merge idle+ready (#41, done); make WIP limit configurable.
3. **Kill migration-journal conflicts at the source** — timestamp/hash-named migrations instead of sequential `0045_`, and/or a `.gitattributes` `merge=union` for `_journal.json`.
4. **Startup self-recovery (core of #44)** — on boot, if `.git/MERGE_HEAD` exists, auto `git merge --abort` and log it, so a killed merge self-heals instead of crash-looping.
5. **Fast crash detection** — a watchdog / push notification on health-check failure, instead of discovering a downed server only when the next 10-min cron fires.
6. **Branch/worktree hygiene** — run the `cleanup` skill to prune orphaned worktrees from the DB reconstruction.

## Post-mortem: the backup system gave zero protection (board DB wiped)

After #44 landed, the board DB was found **wiped** — 0 projects, 0 issues, 0 workspaces, 0 statuses (only seeded `agent_skills`/`tags`/`preferences` remained). All code was safe on master; the *board metadata* (#1–#44 records) was lost. The backups did not save us. Why:

1. **Backups are purely reactive — there is NO periodic backup.** The only two triggers are (a) a manual `pnpm db:repair`, and (b) the `validate-command-safety` hook auto-backing-up before it blocks a destructive DB command. Confirmed: no `setInterval`/cron backup anywhere in the server. During the ~17-hour autonomous session (last healthy backup 2026-05-26 08:11 → incident 2026-05-27 01:16) where #16–#44 were created and worked, **neither trigger fired, so not a single backup was taken while the data was healthy.** By the time `db:repair` ran (during the incident), the DB was *already* wiped — so it dutifully backed up an empty DB.
2. **The one substantial pre-incident backup is corrupt.** `kanban-2026-05-26T06-12-09-586Z.db` (9.8 MB) fails to open: `SQLITE_CORRUPT: malformed database schema (sqlite_autoindex_agent_skills_new_1) - invalid rootpage`. The reference to `agent_skills_new` (a migration temp table) shows it was copied **mid-migration**. The backup does `copyFileSync` of the raw `.db` + `-wal` + `-shm` with no checkpoint/quiescence guarantee, so a copy taken during writes or a migration is inconsistent and unusable.
3. **No backup is ever verified.** Nothing opens a freshly-written backup to integrity-check it or sanity-check row counts, so a corrupt or empty backup sits there giving false confidence.
4. **Hard `taskkill /F` + crash-restarts corrupt the live DB/WAL.** The merge-crash recovery loop repeatedly force-killed the server mid-write; combined with `deduplicateProjects()`/seed running against a damaged DB on restart, the committed state ended up empty. The 1.5 MB WAL at incident time held no recoverable committed projects.

### Backup-system fixes (recommended)

1. **Periodic, consistent backups.** A scheduled job (every ~30–60 min, and on graceful shutdown) using SQLite's **online backup** / **`VACUUM INTO`** — never a raw `copyFileSync` of a live WAL database. `VACUUM INTO` produces a single, checkpointed, internally-consistent file.
2. **Verify every backup after writing** — open it read-only, run `PRAGMA integrity_check`, and assert key tables are non-empty when the source was non-empty. Reject/alert on failure; never let an empty/corrupt file become the newest "backup".
3. **Keep a rotation of N last-known-good backups** and never treat a 0-project backup as valid when the live DB had projects.
4. **Graceful shutdown** (checkpoint WAL on SIGTERM) instead of `taskkill /F`, and serialize/avoid the hard-kill recovery pattern.
5. The deeper protection is still #1 in the systemic list — **don't run the orchestrator on the live working tree**, which is what forced all the hard kills in the first place.

## One-line takeaway

Don't let an autonomous agent loop modify and merge into the live codebase of the server that's running the loop — isolate the orchestrator, or every successful merge is a self-inflicted restart waiting to corrupt something.

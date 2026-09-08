# Continue

Where to pick this up. Present-tense, current state only — see `BACKLOG.md` (exported from
the board, `pnpm cli -- backlog export`) for candidate future work.

## 2026-09-08 — board restarted after an overnight death; #1056 finished; board empty

**The stable board was DOWN when this session started** — nothing listening on 3001/5173. Its
log ends mid-cycle at 06:30 UTC with no error, no `[fatal]`, and no shutdown line; the process
(pid 24720, started by yesterday's recovery promotion) was simply gone. Restarted headless from
`../agentic-kanban-stable` on the same built artifact (`stable-20260907`), health green.
**Unexplained and NOT diagnosed** — if it recurs, that silent-death-with-no-log-line is the
thing to chase, and `.kanban/board.log` around 06:30 is the evidence.

**#1057/#1058/#1059 were merged but sitting in Todo.** Their fix commits are all in
`stable-20260907`; the tickets were never moved. Closed against git, not against the ticket text.

**#1040 landed** (`36dc67366d`) — the pnpm-workspace YAML bug was already fixed on master, so
the branch only removed the dead duplicate `pnpm.onlyBuiltDependencies` from `package.json`.
Two earlier merge attempts had died: one when the board died mid-gate, one killed by the
no-progress watchdog.

### #1056 is done, in three commits, and the second one was corrected by the third

`f374ac67c4 fix(#1056)` was MIS-NUMBERED — it implemented #1057's host-admission work. #1056's
own content was untouched until today.

1. **`3ee70dff5a` — the `process.env.TEMP` door.** Two suites
   (`leaked-temp-project-cleanup`, `project-dedup-same-git-root`) were still minting a loose
   `.db` per test directly in `%TEMP%`, *on the day this was worked*, with
   `temp-dir-namespace-guard` green: all three of its passes key off a `tmpdir()` CALL and its
   parse filter skips any file that never writes the word. Both suites now use an `ak-` scratch
   dir; the guard gained a fourth pass that forbids the DOOR (the temp root arrives through a
   variable, so the resulting name is unknowable at the call site). That pass can have no count
   floor — the tree now holds zero env reads, which is both the goal and what a dead pass looks
   like — so it is proven on synthesized source in both directions instead.
   The reaper now states its BACKLOG and escalates on total size; its old "more remain for the
   next run" read identically at 10 and at 510,000, which is how it was skimmed past four times.
2. **`710cc1ccf4` — the gate's temp-health preflight** (#1056's third bullet), beside #1057's
   host-saturation check. A hold now NAMES which unfitness held it.
3. **`975ff94304` — and the calibration in (2) was WRONG, caught by running it.** The 50,000
   entry cap was a guess; the next measurement refuted it.

**The measurement, because it is the reusable part:**

| entries | walk | note |
|---|---|---|
| 707,242 | > 120 s | the incident state |
| 100,324 | 12.7 s | cold cache |
| 87,503 | **0.2 s** | warm cache, minutes later, SAME directory |

A 13 % size change moved the walk 60x — the CACHE changed, not the directory. **So elapsed time
cannot be the verdict**: it would hold every merge on a cold box and admit on a warm one for
identical state. Size is the stable signal, time is only a cost bound on the probe. Cap is now
250,000, budget 20 s. Verified against the live directory: 87,503 walked in 176 ms, admits.

**`sweep-loose-test-db-files.mjs` was also not draining the backlog it is now named as the remedy
for.** #843 anchored it to `test-db-<uuid>.db`; five other suites mint the same shape under their
own names. Widened to match the SHAPE (UUID-shaped *suffix*, so the `test-db-template-<hash>`
cache still cannot match), match set enumerated before applying — 13 prefixes, all board
fixtures, zero directories. **Applied: 13,437 files, 7.0 GB, 100,940 -> 87,503 entries.**

**Verified by:** the 31 previously-red gate suites (375 passed), `temp-health` (6),
`gate-host-admission` (8), `env-read-ownership` (14), `barrel-client-safety` (10),
`temp-dir-namespace-guard` (7), the two repaired suites (6), `pnpm typecheck` clean, and the
live probe. NOT verified by a full-suite run at commit time — the promotion sweep is that.

**Board state: 1036 Done, 6 Cancelled, nothing in flight.**

### Left undone, deliberately

- **The `%TEMP%` directory backlog.** 87,503 entries remain, ~11,000 of them fixture DIRECTORIES
  in prefixes no sweeper owns (`defects-` 2342, `impres_` 2039, `smoke-srv-` 1390, `abs2_`,
  `cli-test-`, `router-`, `ktrefs-`, `compounding-setup-`, `preflight-test-`). All are
  historical: the board's current source mints every one of these as `ak-*`, and the newest is
  1.8 days old. `sweep-temp-dirs.mjs` only knows `kanban-`/`ak-`, and widening it was NOT done
  because several of those prefixes plausibly belong to sibling tools (refactor-skill,
  code-metrics), and the board deleting another tool's temp dirs is overreach. Below the gate's
  250,000 floor, so nothing is blocked.
- **#1056's per-run temp namespace** (`%TEMP%/kanban/<runId>/`) — suggested in the ticket, not
  built.

## Where this stands (2026-09-08)

**Read this section before anything below it.** Everything under a dated heading describes the
state at the time it was written. Standing state lives here and nowhere else.

### Verified now (2026-09-08)

- **Branch `master`, working tree clean, `599a1ba507`.** **169 commits ahead of `origin/master`**
  (GitHub `p-wegner/agentic-kanban`). The second remote `gitlab` points at
  `pizza-und-ai-code/agentic-code-review` — a DIFFERENT project, not a mirror; do not confuse them.
- **Master is GREEN by full sweep** — `599a1ba507`, 26.5 min, 8,744 + 195 + 1,769 tests across
  server / mcp-server / client, plus `check:arch`. Recorded in `base_branch_health`, which is what
  `pnpm promote` reads. This supersedes the old "a whole-repo run is the outstanding verification"
  item: it has now been done, by the sweep.
- **Stable is `stable-20260908`, live on 3001, and equals master** (`git rev-list --count
  stable-20260908..master` = 0). Promoted on the green sweep, no `--force-sweep`. Smoke passed.
- **Board (agentic-kanban project): 1036 Done, 6 Cancelled, 1 Todo.** Nothing in progress, no live
  workspaces. The single Todo is #1060, filed today (see below).
- **`%TEMP%` is healthy** — ~92,000 entries, under the gate's 250,000 floor, after today's drain of
  13,437 leaked fixture DBs (7.0 GB).

### Next steps, in order

1. **#1060** (Todo, filed today) — `pnpm promote` has no path forward once you FIX a red master:
   it refuses AND declines to re-probe, leaving `--force-sweep` as the only offered path. A stale
   GREEN verdict triggers a fresh sweep; a stale RED one does not. The fix is one `git rev-parse`
   (gate the red refusal on `verdict.sha === HEAD`). Hit for real twice today.
2. **Operator: decide the push.** 169 commits, clean fast-forward to `origin/master`. The Linux CI
   run is what #923 needs, and it has never happened — every sweep here is Windows-only.
3. **The `%TEMP%` directory backlog** — ~11,000 fixture DIRECTORIES in prefixes no sweeper owns
   (`defects-`, `impres_`, `smoke-srv-`, `abs2_`, `cli-test-`, `router-`, `ktrefs-`,
   `compounding-setup-`, `preflight-test-`). All historical: current source mints every one of
   these as `ak-*`, newest is ~2 days old. `sweep-temp-dirs.mjs` knows only `kanban-`/`ak-`.
   NOT widened, deliberately — several of those prefixes plausibly belong to sibling tools
   (refactor-skill, code-metrics), and the board deleting another tool's temp dirs is overreach.
   Nothing is blocked by them.

### Open, unexplained — chase this if it recurs

**The stable board died overnight on 2026-09-08 at 06:30 UTC.** Nothing listening on 3001/5173
when the session started. `.kanban/board.log` ends mid-cycle with **no error, no `[fatal]`, and no
shutdown line**; pid 24720 (started by the previous evening's recovery promotion) was simply gone.
Restarted headless on the same artifact and it has been healthy since. Not diagnosed — the log
around that timestamp is the evidence, and a silent death with no log line is the signature.

### Operator flag — RESOLVED, not open (corrected 2026-08-27)

`packages/server/kanban.db` does not exist; CLI and server both open
`C:\Users\pwegner\.agentic-kanban\kanban.db`. The `[db] opening ... (source: home-fallback)`
line is the NORMAL path, not a warning — do not re-file it as a defect.

## Archive

Passes older than 2026-09-08 have been moved **verbatim, newest first** into
[`docs/archive/CONTINUE-archive.md`](docs/archive/CONTINUE-archive.md). Nothing is re-verified or
edited on the way in, so it records what each session believed at the time. Look there for the 2026-09-04..09-07 passes
(the profile-roster wave, the two-board split and `pnpm promote`'s first real runs, #1039, and the
three successive WRONG diagnoses of the #1046/#1048/#1049 gate failures — %TEMP%, then log
truncation, then #1059's sweeper, which is the correct one), the
2026-09-01/02 wave (#986/#992/#994/#995/#996/#997/#998/#999 and the verification-cadence pass), the
2026-08-25..28 waves (#924, #807, #903, #901, #857, #874, #887, #899/#898/#897, #894, #881, the
26-ticket direct-master batch, #859's root cause, the UI overflow sweep), and before them the #680
gate-hermeticity history, the "batch 1 of N" true-state table (#691), the 2026-08-21/22/23 waves,
the adversarial review, and the hook-cost investigations.

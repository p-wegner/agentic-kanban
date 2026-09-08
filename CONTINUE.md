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

### Later the same day — archive pass, #1060, and the %TEMP% dir backlog closed

- **Third CONTINUE archive pass** (693 -> 146 lines): ten dated 2026-09-04..09-07 passes moved
  verbatim to `docs/archive/CONTINUE-archive.md`. The standing "Where this stands" section was
  REWRITTEN rather than archived — it was dated 09-04 and every load-bearing line had gone false.
- **#1060 fixed and Done.** A RED sweep verdict now stops refusing a re-probe once master is fixed
  PAST it: `planSweepAcquisition` takes `headSha` and splits the red case. Red-on-the-tip refuses
  exactly as #1044 intended; red-on-a-superseded-commit requests a fresh sweep. Unknown HEAD or a
  sha-less row keeps the refusal — a comparison that cannot be made is not a licence.
- **#1038 verified end-to-end while refreshing `BACKLOG.md`**: `pnpm cli -- backlog export --out
  BACKLOG.md` from the repo root now writes the repo-root file and prints the ABSOLUTE path, which
  is exactly that ticket's acceptance. The backlog is now **0 open issues**.
- **The `%TEMP%` directory backlog is drained** — the item this file listed as deliberately not
  done. Ownership is DERIVED, not listed: for every `ak-<X>-` prefix the repo mints today, a bare
  `<X>-` dir in `%TEMP%` came from an older revision of that same call site. Behind
  `sweep-temp-dirs.mjs --legacy`, with a specificity filter that declines generic bare forms
  (`plan`, `ws`, `fork`) and numeric ticket fragments. **22,704 removed, 0 failed; %TEMP% 91,041
  -> 68,288 entries, walked in 0.18s.**

**Twice today vitest was green while `tsc` was not**, both times on a hand-typed `.d.mts` for a
plain `.mjs` script (`promote-plan.d.mts`, then `legacy-temp-prefixes.d.mts`). For these scripts
the suite alone is not the gate.

### Left undone, deliberately

- **#1056's per-run temp namespace** (`%TEMP%/kanban/<runId>/`) — suggested in the ticket, not
  built.

## Where this stands (2026-09-08)

**Read this section before anything below it.** Everything under a dated heading describes the
state at the time it was written. Standing state lives here and nowhere else.

### Verified now (2026-09-08)

- **Branch `master`, working tree clean, `bcb34bd928`.** **172 commits ahead of `origin/master`**
  (GitHub `p-wegner/agentic-kanban`). The second remote `gitlab` points at
  `pizza-und-ai-code/agentic-code-review` — a DIFFERENT project, not a mirror; do not confuse them.
- **The last full sweep was GREEN** — on `599a1ba507`, 26.5 min, 8,744 + 195 + 1,769 tests across
  server / mcp-server / client, plus `check:arch`. Recorded in `base_branch_health`, which is what
  `pnpm promote` reads. This supersedes the old "a whole-repo run is the outstanding verification"
  item: it has now been done, by the sweep. **Master has since moved 3 commits past that sha** (the
  archive pass, #1060, the legacy drain) — those three are verified by `check:arch` + `typecheck` +
  their own suites, NOT by a full sweep. The next promotion will request one.
- **Stable is `stable-20260908`, live on 3001**, promoted on that green sweep with no
  `--force-sweep`; smoke passed. Master is now **3 commits ahead of it** — see above.
- **Board (agentic-kanban project): 1037 Done, 6 Cancelled, 0 open.** The backlog is genuinely
  empty — nothing in progress, no live workspaces, `BACKLOG.md` re-exported at 0 issues.
- **`%TEMP%` is healthy** — 68,288 entries walked in 0.18s, far under the gate's 250,000 floor,
  after today's two drains: 13,437 loose fixture DBs (7.0 GB) and 22,704 legacy fixture dirs.

### Next steps, in order

1. **Operator: decide the push.** 172 commits, clean fast-forward to `origin/master`. The Linux
   CI run is what #923 needs, and it has never happened — every sweep here is Windows-only. This
   is the only item left that is not ours to decide.
2. **Promote again when convenient.** Master has moved past `stable-20260908` (the archive pass,
   #1060, and the legacy drain). Not urgent: the board is idle and nothing on it is blocked. The
   next `pnpm promote` will request its own sweep, and #1060 means a red one no longer dead-ends.
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

# Continue

Where to pick this up. Present-tense, current state only — see `BACKLOG.md` (exported from
the board, `pnpm cli -- backlog export`) for candidate future work.

## 2026-09-13 — board at ZERO open; `stable-20260913` live at `3d2d681710`

**The board is empty.** 1102 issues: 1092 Done, 10 Cancelled, **0 non-terminal**. The last to
land were #1108, #1110, #1111, #1113, #1116 and #1118. #1117 is Cancelled — it was filed on a
misdiagnosis of mine (below).

**`stable-20260913` is live on 3001** at `3d2d681710` (pid 31664), smoke passed (2 projects,
board status answered), rollback target `stable-20260912`. Master and `origin/master` are IN
SYNC — the 78-commit unpushed backlog the previous standing section described is gone.

**What blocked the promotion for hours.** `pnpm promote` refused repeatedly with `unverified`:
the base-health sweep returned no verdict in ~90s. The chain — `ak-1118`'s worktree had an EMPTY
`node_modules`, so its pre-merge gate died in ~4s (`ERROR: chalk.Instance is not a
constructor`); the monitor retried it; each retry queued a GATE-class waiter, which under #978
preempts the background base-health probe; the probe yielded mid-run and recorded `unverified`.
The empty `node_modules` was **NTFS corruption in the shared pnpm store**:
`~/.pnpm-store/v10/files/80/a0605c37…` lists but cannot be stat'ed, and `rm` refuses it with
"File exists" on a file `ls` can see.

**Second occurrence in two days** — the archived 2026-09-11 pass hit the same damage and
quarantined `files-<xx>-corrupt-2026-09-11`. Same workaround: `files/80` is parked as
`files/80.corrupt-20260913` (renaming the DIRECTORY works where deleting the child does not),
which makes pnpm re-fetch. **`chkdsk C: /f` is still the operator's, and is now overdue.**

**Then master went RED — honestly, which was progress.** With the probe unblocked the sweep
produced a verdict instead of a timeout: **1 failed of 8,907** —
`always-run-guard-runtime-ratchet`. Tonight's `072f643ffb` added the #1113 guard with a BARE
`@gate:always-run` marker, so it joined the unconditional floor at the assumed 3,000 ms and
pushed it to 569,748 ms against a 567,000 baseline. Fixed in `3d2d681710`: the guard declares
`when:packages/server/src/startup/**` (the one tree it walks), and `BASELINE_TOTAL_MS` moves
567,000 -> 570,000 with a **Seventh disclosed movement**.

**`when:` ALONE does not clear that ratchet** — it measures the WORST case (an unknown change
set forces every guard, preconditions ignored). The fifth and sixth movements say so about
themselves; I re-derived it the hard way after a "fix" that moved the number by zero.

**Tried and rejected:**
- **`--force-sweep`.** There WAS a verdict (red), so forcing would have promoted known-broken
  code and poisoned the next honest promotion. Never needed: #1044's logic recognised that the
  red verdict described a sha which was no longer the tip, and requested a fresh sweep itself.
- **Re-running `pnpm promote` after the harness killed its wrapper for low memory.**
  `promote.mjs` survives as an ORPHAN and keeps working (measured twice). A second concurrent
  run would tag, fast-forward and restart the operated board underneath the first. Read
  `promote.log`; do not relaunch.
- **Editing `auto_merge_disabled_<id>` to quiet the failing gate.** Prepared, then unnecessary
  once the store was repaired. No preference was changed this session.

**#1117 is Cancelled as a misdiagnosis**, with a correction comment on the ticket. "Merge POST
hangs forever" was my own `curl --max-time` being shorter than a ~759s gate; `http=000` was the
client, not the board. A real merge POST measured **369,583 ms**.

**The livelock worth never repeating:** 34 gate verdicts were DISCARDED under #243 (branch or
base moved during the run), including one 4,380s run that PASSED. The cause was my own rebases
and agent turns moving branches while their gates ran. Stopping all of it let #1108, #1110 and
#1111 land unaided.

## Where this stands (2026-09-13)

**Read this section before the dated passes above.** Each dated pass describes the state at the
time it was written. Standing state lives here.

### Verified now (2026-09-13, ~04:25 local)

- **`master` = `3d2d681710`, working tree clean, IN SYNC with `origin/master`.**
- **Stable is `stable-20260913` = `3d2d681710`, live on 3001** (pid 31664); `/health` ok with
  all three checks green. Rollback target: `stable-20260912`.
- **Last full base sweep: GREEN at `3d2d681710`** (2026-09-13 02:23 UTC) — the sweep that
  authorized this promotion. It ran ~28 min.
- **Board: ZERO non-terminal tickets.** #1097, #1098, #1102, #1103, #1105, #1113 and #1118 are
  Done; #1117 Cancelled.
- **Auto-merge kill switch** `auto_merge_disabled_d1c5d9c1-…` = `"false"`, untouched all session.

### Next steps, in order

1. **Operator: `chkdsk C: /f`** (admin, reboot). Two pnpm-store corruptions in two days, plus
   `ak-1117-2` unreadable at the NTFS level. Quarantined, never repaired:
   `files-<xx>-corrupt-2026-09-11` and `files/80.corrupt-20260913` — both safe to delete after.
2. **`%TEMP%` holds ~82,000 entries**, reaper capped at 500/run. Far under the gate's 250,000
   floor (`DEFAULT_TEMP_ENTRY_CAP`), so it blocks nothing — but #1056 is what the far end looks
   like. `node scripts/sweep-temp-dirs.mjs` + `scripts/sweep-loose-test-db-files.mjs`.
3. **The Seventh movement should SHRINK at the next `pnpm test:durations` capture** — the #1113
   guard costs 4 ms of test time against its 3,000 ms placeholder.
4. **The Linux CI run is still unrun**; every sweep here is Windows-only.

### Unfiled findings from this session

Nothing was filed after the #1117 misfire, so these are recorded here rather than dropped:
- Three fix-and-merge sessions launched for ONE workspace within two seconds (00:34:48/:49/:50).
- A base sweep whose only failed suite is package-relative records NO test-impact outcome at all
  ("an incomplete failed set would understate the miss rate"), so a red sweep can leave the #954
  corpus with a hole. Seen live on the red sweep at `89aa325fd8`.
- `[test-impact] record args too long (~59,380 chars for 961 suites)` still silently drops
  outcomes. #1098 is Done for the ENAMETOOLONG spawn; verify whether it covers this path too.

### Which `[db] opening` line is normal

The stable board logs `[db] opening C:\Users\pwegner\.agentic-kanban\kanban.db (source: DB_URL)`;
that is expected. A **worktree** server logging the same file with `(source: home-fallback)` has
reached the operated DB — the #1095 hazard, not a normal path.

## Archive

Passes older than 2026-09-13 have been moved **verbatim, newest first** into
[`docs/archive/CONTINUE-archive.md`](docs/archive/CONTINUE-archive.md). Nothing is re-verified or
edited on the way in, so each pass records what that session believed at the time. The archive
holds:
- **2026-09-11..09-12:** the #1102 Autopilot-chip pass, `stable-20260911`, the timeline
  reconciliation (#1090 → #1093), the first pnpm-store corruption (#1092), and the stale
  `## Where this stands (2026-09-11)` standing section.
- **2026-09-08..09-10:** the overnight board death and #1056, the target-only drive scope fix
  (#1071-#1073), the NTFS pnpm store corruption behind `verify_infra_missing`, the Jira-epic
  passes, #1085 and the monitor race, and the stale 2026-09-08 standing section.
- **2026-09-04..09-07:** the profile-roster wave, the two-board split and `pnpm promote`'s first
  real runs, #1039, and the three successive WRONG diagnoses of the #1046/#1048/#1049 gate
  failures (%TEMP%, then log truncation, then #1059's sweeper, which is the correct one).
- **2026-09-01/02:** #986/#992/#994/#995/#996/#997/#998/#999 and the verification-cadence pass.
- **2026-08-25..28:** #924, #807, #903, #901, #857, #874, #887, #899/#898/#897, #894, #881, the
  26-ticket direct-master batch, #859's root cause, and the UI overflow sweep.
- **Earlier:** the #680 gate-hermeticity history, the "batch 1 of N" true-state table (#691), the
  2026-08-21/22/23 waves, the adversarial review, and the hook-cost investigations.

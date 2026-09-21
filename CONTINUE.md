# Continue

Where to pick this up. Present-tense, current state only — see `BACKLOG.md` (exported from
the board, `pnpm cli -- backlog export`) for candidate future work.

## 2026-09-21 — the overnight train sweep: master red under the trains, 7 landed, stable-20260921 in flight

**What was true, and why nothing landed for six hours.** Train `qmua102wb` (14 members, assembled
2026-09-20 ~19:00) bisected every leaf red until 00:30. The cause was master, not the members:
`startup/commit-msg-hook-backfill.ts` (#1214, `ff08b83984`) value-imported drizzle-orm and the
`db` singleton, the 31st offender of the #715 startup persistence boundary, so
`startup-persistence-boundary-ratchet` failed on every tree built from master. The stable build
(`stable-20260917-2`) has no #1204 control arm and logs no gate output for a train leaf, so the
only way to see it was to run the ratchets by hand against a leaf worktree. Fixed forward:
`2cd02afc33` (query moved into `repositories/commit-msg-hook-backfill.repository.ts`) and
`adba07ec52` (stale attestation assertion after `61e2327697`).

**Landed today** (train `qmuaj7n7p` leaves `a` and `babb`, plus one #797 synchronous merge):
#1128 #1129 #1141 #1175 #1184 #1209 #1186. Master = `0f4da028e5`.

**Member defects the reviews had never caught, fixed by turns:** #1129 needed three rounds
(`now: number` spelling → `nowMs`; `herdr-exec.ts` single-consumer in shared/lib → moved to
server/lib + `pnpm openapi:generate`; `HerdrExecOptions` duplicated `DockerExecOptions`); #1141
`now?: Date` → `nowMs`; #1188 a BOM commit subject plus `merge-queue-train.ts` reaching 1036
lines together with #1203 (shrunk to 725); #1187 rebased onto a stale `origin/master` first, then
onto local master with its BOM subject rewritten. Rule of thumb from the night: a train leaf red
with no visible reason = run `check:arch` + the `ratchet|guard|parity` suites on the leaf worktree.

**Filed today:** #1215 — a #797 synchronous merge (#1186) during the last leaf's gate tripped the
train's ancestry invariant (`ak-1186 not reachable from the train`), `runMergeTrain` threw past
`finishMergeTrain`, and the row stayed `gating` with the registry marking it live — no train can
assemble until the board restarts. #1203 had a green leaf and did not land because of it.

**Promoted:** `stable-20260921` = `0f4da028e5` is live on 3001 (pid 32944, smoke passed, sweep green at 04:54 UTC; rollback
`stable-20260917-2`). It had to request a fresh sweep first (last verdict was the stale red on
`f5f6268bd2`). `auto_merge_disabled_d1c5d9c1-…` = `"true"` for its duration so master does not
move under the sweep, and was set back to `"false"` right after.

### Next steps, in order
1. When promote finishes: check `<stable>/.kanban/promote.log`, `/health`, then set
   `auto_merge_disabled_d1c5d9c1-…` back to `"false"`. The restart also clears the zombie train.
2. The next train should carry #1203 #1187 #1188 #1205 (all ready, all rebased on ≥ `a959a53364`).
3. #1189 conflicts with #1187 in `MergeQueuePanel.tsx`: send it a rebase turn once #1187 lands.
4. Stranded set still untouched: #1120 #1150 #1151 #1152 #1164 #1206 #1208 (need the #1205/#1206/
   #1209 paths, now live after promotion).
5. Implement #1215 (board workspace), and re-enable auto-merge on the three fixture projects
   (`c94e30c4…`, `c6355fcd…`, `bc221c46…`) that were paused 2026-09-20 for CPU.

### Verified by
`startup-persistence-boundary-ratchet`, `worker-profile-attestation-protocol`, `check:arch` green
on master `adba07ec52`; the seven landings are merge commits on master; #1186/#1187/#1188/#1205
tips report `git merge-tree --write-tree master <branch>` conflict-free and zero BOM subjects.
`legacy-temp-prefixes` timed out (300 s) only under a concurrent train gate and passes alone —
not fixed, noted.

## Archive

Passes older than today have been moved **verbatim, newest first** into
[`docs/archive/CONTINUE-archive.md`](docs/archive/CONTINUE-archive.md). Nothing is re-verified or
edited on the way in, so each pass records what that session believed at the time. The archive
holds:
- **2026-09-18/19 (moved 2026-09-21):** the sentinel-lab fold, #1199's identity finding (resolved
  2026-09-20 by unsetting the repo-local `[user]`), #1196-#1198 and the six train branches landing,
  and the stale `## Where this stands (2026-09-13)` standing section.
- **2026-09-17/18 (moved 2026-09-18):** the per-branch passes for #1191, the #1194+#1192
  integration proof, #1194, #1192 and #1193 — written while each was a branch, superseded by
  the landing pass above.
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

# Continue

Where to pick this up. Present-tense, current state only — see `BACKLOG.md` (exported from
the board, `pnpm cli -- backlog export`) for candidate future work.


## 2026-09-26 — context token pass, plugin skill listings (#1251), safety-net plugin re-pointed

**Context cost.** The root `CLAUDE.md` went from ~18.5k to ~4.5k tokens (o200k estimate; `cea9b26aed`):
rules stay inline, the moved detail sits verbatim in `docs/agent-guide/*.md`, and the private-index
commit recipe became the `shared-checkout-commit` skill. Verified by the two `claude-md-*-invariants`
suites (10/10). 26 tracked project skills are now user-invoked (`disable-model-invocation`) and the
stray `--help` skill is gone (`d2045372dd`); `test-impact` got the same flag in its own repo
(`382e37a`, pushed to GitHub and GitLab).

**#1251 (this commit, In Progress on the board until promoted).** Plugin skills no longer load their
descriptions into every session: the board writes Claude Code `skillOverrides` (confirmed present in
Claude Code 2.1.282) into `.claude/settings.local.json` at enable/disable and into every worktree at
provisioning, default `name-only`, overridable per project (`plugin_skill_listing_<slug>_<projectId>`,
a JSON map) and hinted per skill in the manifest (`skills[].listing`). A TRACKED settings file is
never written; this repo's is tracked, so it carries a hand-set `name-only` block for its 23 plugin
skills. Pi omits `user-invocable-only`/`off` skills from `--skill`. Verified by
`plugin-skill-listing.test.ts` (shared, 11) and `plugin-skill-overrides.test.ts` (server, 6) plus the
provisioning/plugin-service/agent.service suites (95 total), `check-god-modules` OK, `lint:arch` 0
errors. Left out on purpose and filed as #1252: the Plugins-view selector, and Codex. **Not live**:
the stable board still runs `stable-20260925`.

**Operational change on the stable board.** The `refactor-safety-net` plugin row now points at
`C:\projects\andrena\ki-team\software-modernization\refactor-safety-net` (v0.4.0, was the papershift
client copy at v0.3.0). Both projects that enable it (agentic-kanban, comet/documentation) had their 10
papershift junctions removed (links only) and re-linked to 11 skills, incl. the new
`safety-net-bootstrap`. That checkout is 21 commits behind origin: `git pull` got HTTP 500 from
code.andrena.de on 2026-09-26. The `reqextract` plugin still points at `C:\projects\papershift\reqextract`.

**Carried forward from 2026-09-24 (archived):** settings that matter: posture `iterate`,
`verify_gate_strategy` `impact`, `merge_strategy` `merge_queue`, Start Mode `monitor`, WIP 2.
`.sentinel-issues.json` (untracked, 3.6 MB, from a sentinel run) is not ours to delete. A full sweep
is owed on the promoted board (`<stable>/.kanban/promote-recovery.json`).

### Next steps, in order
1. `pnpm promote --dry-run` — carries #1250 and #1251; the rc lane should cut `rc/<date>` and ask
   the promoted board for its sweep.
2. When GitLab answers: `git pull --ff-only` in the ki-team `refactor-safety-net`, then Update the
   plugin (`POST /api/plugins/d9eae2ad-…/update`) so the board re-reads its manifest.
3. Decide whether `reqextract` also moves to `ki-team/software-modernization/reqextract`.
4. #1252 (listing selector, Codex). Carried: the dev board's posture (`flow` needs
   `promote_cadence_<id>`), #1246–#1249, #1244, #1245, the `tsz-*` missing-path projects.

### Verified by
`git log --oneline 00e098a0e5..HEAD`; the test files named above; on the stable board,
`GET /api/plugins` shows `refactor-safety-net` at the ki-team path, and
`Get-ChildItem .claude\skills -Attributes ReparsePoint` in both projects shows no papershift target.

## Archive

Passes older than today have been moved **verbatim, newest first** into
[`docs/archive/CONTINUE-archive.md`](docs/archive/CONTINUE-archive.md). Nothing is re-verified or
edited on the way in, so each pass records what that session believed at the time. The archive
holds:
- **2026-09-24/25 (moved 2026-09-26):** the #1228 gate loop and the rebase-onto-stale-origin incident,
  #1230-#1236, master's red sweep fix, and the `stable-20260925` bootstrap promotion via `--recover`.
- **2026-09-21 evening + 2026-09-22 (moved 2026-09-24):** the stranded set landing (#1146, #1183,
  #1120/#1150/#1152), the six overnight monitor landings, #1219-#1221, `stable-20260922-2`, and the
  `promote.mjs` unknown-flag incident (fixed by #1222).
- **2026-09-21 morning (moved 2026-09-22):** the overnight train sweep — master red under the
  trains (#1214's boundary violation), seven landings, `stable-20260921` promoted.
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

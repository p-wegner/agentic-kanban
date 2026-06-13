# Board run — budget-pilot (larger toy project, post-fix validation)

**Date:** 2026-06-14
**Project:** `budget-pilot` (`bfa9147b-d72a-4014-9a43-f136eaa3a2dd`), repo `C:\projects\budget-pilot`
**Stack:** Vite + React + TypeScript + Tailwind v4 + Zustand (persist) + react-router v6 + recharts + papaparse
**Goal context:** the rung **above** `timetracker` in the "drive agents through increasingly larger toy projects" goal — a bigger, deeper React SPA (16 tickets: shell + 12 disjoint feature modules + integration + retro, vs timetracker's ~11). Its explicit purpose: **validate that the board self-repair (#772–781) cuts the hand-holding** the timetracker run needed. The orchestrator changes only board settings/tickets; the board's agents do all implementation + build + verify + merge.

## What the fixes bought (measured against the timetracker run)

| Obstacle (timetracker) | Manual step it forced then | budget-pilot (after fix) |
|---|---|---|
| **#772** registration leaves project undriveable | hand-seed 7 statuses + PATCH defaultBranch | **Gone.** `POST /api/projects` returned `defaultBranch=master`; `GET /statuses` returned all 7 columns immediately. Zero hand-seeding. |
| **#773** feature-type tickets invisible to auto-start | convert every ticket to `task` | **Gone.** Seeded all 16 as `feature`; the monitor auto-started the eligible ones (shell #2) unprompted. |
| provider defaults to codex (credit-exhausted) | force per-ticket POST with claudeProfile | **Gone.** `board_strategy` providerPolicy `claude:anth` (`mode:fill`) → both auto-started workspaces came up `provider=claude`. |
| auto-start didn't fire without a manual cycle | `POST /internal/monitor-run` to kick | **Gone.** Autodrive monitor fired on its own timer — shell was In Progress before any manual cycle. |
| **#777** scaffold esbuild-approval placeholder → verify-gate false-pass | hand-fix `pnpm-workspace.yaml` | scaffold ran clean on register (verify at first merge). |

Net setup effort this run: **register → set 3 prefs → seed epic.** No hand-seeding of statuses/branch, no type conversions, no manual provider POSTs, no start-next kicks.

**#774 (the keystone) CONFIRMED FIXED.** The timetracker run's single biggest manual cost was that dep-bearing tickets never auto-started — the driver had to `POST /dependency-waves/start-next` on a loop. Here, the instant the shell (#2) merged to master, the monitor's `runAutoStart` auto-cascaded and launched **3 feature builders** (#3/#4/#5, all `provider=claude`) up to the WIP=3 cap, **with no manual kick**. The unordered-`.limit()` truncation that hid the startable ticket is gone (drop limit + `orderBy issueNumber`). This is the result the rung existed to prove: the board now drives a dependency wave hands-off.

## Epic shape (fan-out)
Shell (#2) pre-wired EVERY shared/hot file so the 12 features touch disjoint files:
- `src/types.ts` (all domain types), `src/store/index.ts` + 7 slice stubs (full interfaces), `src/router.tsx` (all 12 routes), `src/components/{Layout,Sidebar,ui/*}`, `src/lib/*`, all deps installed.
- Each feature owns `src/features/<x>/*` (+ its own slice for the 7 data features) + its own test file. Read-only features (dashboard, reports, networth, import, filters) read the slice interfaces; no slice ownership → no slice conflicts.
- Integration (#15) owns ONLY `src/app.smoke.test.tsx`; retro (#16) owns ONLY `README.md`. Neither re-edits feature files (the #778 integration-conflict trap avoided by design).

Verify gate: `verify_script` = `pnpm install && pnpm build` — ports the dev-board's verify-before-merge to this stack.

## Timeline / observations
- Shell builder produced the complete scaffold (35+ files, all 12 stub pages, 7 slices, exact dep set) within minutes of auto-start → verify-gate passed → auto-merged (`bf1b326`).
- **Feature wave fully auto-cascaded**: all 12 features built 3-wide (WIP cap), each verify-gated and auto-merged, with **zero manual `start-next` kicks** — the #774 fix holding across the whole wave. ~13 merges landed on master autonomously.
- One ticket fix mid-flight: csv-import ticket said `src/features/csvImport/` but the shell stubbed `src/features/import/` (router-authoritative) → corrected the ticket's owned-files path before it started. (Scaffold should make feature-folder names match the router; minor.)
- **Integration tier needed one manual kick** (#782): when the 12th feature merged, integration #15 (fan-in of 12 deps) did NOT auto-start across a forced monitor cycle (`isBlocked` stale); one `dependency-waves/start-next` started it. The retro #16 (single dep) auto-started fine — so the miss is specific to the many-deps fan-in.
- **Close-out caught a clean-build failure the verify gate false-passed** (#783): a truly clean clone failed `pnpm install` (`ERR_PNPM_IGNORED_BUILDS: esbuild`) under global pnpm 11.0.8, with a bogus scaffold `pnpm-workspace.yaml` placeholder. Fixed budget-pilot master directly (commit `aaa02a3`: pin `pnpm@10.12.1` + `pnpm.onlyBuiltDependencies=[esbuild]`). master now builds green from a fresh checkout (`pnpm install && pnpm build` → exit 0, `✓ built in 5.12s`).

## Obstacles filed this run (all `[drive-autonomy]` in agentic-kanban)
- **#782** — monitor `runAutoStart` skips a fan-in dependent (#15, 12 deps) whose last dependency just merged (stale `isBlocked`); `start-next` starts it. Single-dep dependents (retro) cascade fine.
- **#783** — the #777 build-approval fix was INEFFECTIVE for from-scratch projects (ran at registration before the builder creates package.json; never re-applied), no `packageManager` pin so the toy ran under global pnpm 11.0.8 (which ignores the approval config everywhere), and the per-worktree verify gate FALSE-PASSED because the shared pnpm store already approved esbuild. **FIXED (commit `6f1346bc`):** `ensurePnpmBuildApproval` now also pins `packageManager: pnpm@10.12.1` (guarded to pnpm projects) and the verify gate runs it on the worktree post-build and **commits** the repaired manifest onto the branch before verifying — so it merges to master and clones build clean. Validated end-to-end (fresh Vite project → `pnpm install && pnpm build` green). The next drive won't need the manual close-out build fix.

## Net
The board drove a **16-ticket, 12-feature React SPA from a bare repo to a working, build-verified app almost entirely hands-off** — a clear step up from timetracker in size and depth. The self-repair (#772–781) delivered: registration was driveable with zero hand-seeding, all-`feature`-type tickets and the dependency wave auto-cascaded without manual kicks, and provider stayed claude/anth. **Residual manual effort this run: ONE `start-next` for the fan-in integration ticket (#782) and ONE close-out build-config fix (#783)** — both now filed, vs timetracker's hand-seeding + type-conversions + provider POSTs + a continuous start-next loop + the same build fix. The two surviving obstacles are concentrated at the very end of the pipeline (integration tier + clean-room build), exactly where a hands-off drive should still finish cleanly; closing them gets the next rung to fully unattended.

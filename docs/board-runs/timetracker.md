# Board run — timetracker (larger toy project)

**Date:** 2026-06-13
**Project:** `timetracker` (`24906823-8949-451e-957e-d807d7fc4887`), repo `C:\projects\timetracker`
**Stack:** Vite + React + TypeScript + Tailwind v4 + shadcn/ui + Zustand + react-router + recharts
**Goal context:** the "drive agents through increasingly larger toy projects" goal — the rung above the single-file HTML5 games (a multi-page, stateful React SPA). Orchestrator changed only board settings/tickets; the board's agents did all implementation + build + verify + merge.

## Outcome
- **9/11 Done**: shell (#2) + all 8 feature tickets (#3–#10) built in parallel and merged to `master`, each gated by `pnpm install && pnpm build`.
- **#11 (integration) Cancelled** — superseded: navigation was already integrated by the shell's pre-wired router/Sidebar; #11's agent reimplemented #7/#10's files (built against pre-merge stubs), conflicting with the authoritative features and adding no net value.
- **#12 (retro) Done** — this doc.
- **`master` builds clean**: `tsc -b && vite build` → ✓ 2489 modules, dist produced. (After fixing the scaffold's esbuild-approval placeholder, commit `b55c94a`.)

## Epic shape (fan-out, worked well)
Shell pre-wired every hot file (types, persisted Zustand store + per-feature slice stubs, `router.tsx`, `Sidebar`, theme provider, vitest). 8 feature tickets each owned `src/features/<x>/` + their own slice + own test → **near-zero file conflicts across the 8-wide wave**. Parallelism achieved: 5 concurrent builders (start-next's effective cap).

## The feedback harness (the point of the run)
- **`verify_script_<projectId>` = `pnpm install && pnpm build`** ported the dev-board's verify-before-merge gate to the toy stack. It **worked**: the log shows multiple `verify_script failed (exit 1) — withholding readyForMerge`, i.e. broken builds were blocked and re-fixed before merging. This is the key transferable result.

## Friction / obstacles (filed as `[drive-autonomy]` tickets in agentic-kanban)
1. **#772** registration left the project undriveable — no status columns, no defaultBranch (both 400 silently). Had to seed both by hand.
2. **#773** monitor auto-start silently skips `feature`/`enhancement` issue types — seed epics as `task`.
3. **#774** monitor `runAutoStart` won't launch *dependency-bearing* tickets even when resolved (no-dep tickets start fine); `POST /dependency-waves/start-next` does. Used start-next on a loop as the bridge. (start-next also ignores the WIP target.)
4. **#775** `runAutoStart` swallows workspace-create failures silently — stalls invisible.
5. **#776** a cancelled issue's stale workspace causes a monitor relaunch loop.
6. **esbuild approval placeholder** (new): the scaffold left `allowBuilds: esbuild: "set this to true or false"` in `pnpm-workspace.yaml`, so the merged app fails `pnpm install`/`build` on a clean checkout (`ERR_PNPM_IGNORED_BUILDS`) — yet the per-worktree verify gate passed (false-pass). Scaffolder should set `esbuild: true`.
7. **integration-ticket base/timing** (new): #11 (depends on all features) built against pre-merge stubs and reimplemented #7/#10. Integration/last-in-chain tickets need their worktree cut from a base that already contains all merged dependencies (or shouldn't re-edit feature-owned files).
8. **claude:anth rate-limit after ~10 agents** (new): late-run launches (fix-and-merge, #12) exited code 1 / 0-token. Preflight passes (config OK) but live quota is exhausted → need quota-aware throttling or provider fallback for sustained drives.

## Net
The board **can** drive a larger multi-feature app to a working, build-verified state largely hands-off. Residual manual effort this run: seed the missing statuses/defaultBranch (#772), use `task` type (#773), kick `start-next` on a loop (#774), one build-config fix (#6), and close out #11/#12 once claude throttled. All are filed; the `drive-new-project` skill preflight was hardened to cover #772/#773/#774 + provider policy so the next project needs less.

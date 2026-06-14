# Board run — PulseCRM (20-ticket, 3-tier — most complex drive yet)

**Date:** 2026-06-14
**Project:** `pulse-crm` (`5e10429c-c3a5-4e41-8869-4d86d267d2a5`), repo `C:\projects\pulse-crm`
**Stack:** Vite + React + TypeScript + Tailwind v4 + Zustand (persist) + react-router v6 + recharts + papaparse
**Goal context:** the rung above budget-pilot (16 tickets, flat fan-out) — a bigger app with a genuine **3-tier dependency graph**: shell → 13 tier-1 feature modules → 4 cross-entity tier-2 features (dashboard/reports/search/timeline, each fanning in from 2–4 tier-1 deps) → integration → retro. 43 dependency edges.

## Outcome
- **20/20 Done.** All 17 feature modules on master (contacts, companies, deals pipeline, activities, notes, tags, stages, settings, CSV import, calendar, templates, saved views, contact-detail, dashboard, reports, global search, timeline), 20 merge commits, integration smoke + README.
- **master builds clean from a true `git clone`**: pnpm 10.12.1 (via the committed pin), `pnpm install` exit 0, `pnpm build` ✓ 5.18s. The #783 verify-gate fix held — master carries the `packageManager` pin + `pnpm.onlyBuiltDependencies` (commit auto-injected by the gate).
- The 3-tier dependency graph was respected: tier-2 features started only after their specific tier-1 deps merged; integration only after all 17 features.

## What worked hands-off
- Registration driveable (no hand-seeding), shell auto-started as claude, provider pinned claude/anth, merges drained via the 30s merge-queue orchestrator, verify gate kept master build-clean.
- A watcher (monitor-cycle + 1× `start-next` per cycle, self-capping at wipLimit=5) bridged the #782 fan-in so tier-2 and integration started without per-step babysitting (a couple of manual `start-next` nudges at the integration/retro fan-in to avoid the 90s watcher lag).

## The serious obstacle — #784 (premature cascade), and the recovery
The single biggest problem: **dependents auto-start the instant their blocker hits "Done", but the branch→master merge is asynchronous (merge-queue, 30s interval)** — so "Done" ≠ "on master". When the **shell** went Done, the #774 cascade immediately cut all 5 tier-1 worktrees from the **pre-merge** master (no `package.json`, no `src/types.ts`, no slices). Tier-1 builders began re-scaffolding the app from scratch (→ guaranteed conflicts), and the shell itself sat **Done-but-unmerged** (silent merge loss). This is #778 generalized to every dependency edge, and **fatal** when the dependency provides foundational code (the scaffold) rather than an interface the shell already exposes.

**Recovery (manual):** force-merge the shell (`POST /workspaces/<id>/merge`) → master got the scaffold + the #783 build-approval commit; then **delete the 5 contaminated tier-1 workspaces** so the monitor re-cut them from the now-merged master (verified: re-launched worktrees had `types.ts` + all 11 slices). After that the drive self-sustained — tier-2/integration only read the shell's already-merged slice *interfaces*, so the cascade timing no longer mattered.

Filed **#784** (high priority): gate the cascade (and the Done transition) on *merged-to-base*, not just terminal status — or cut a dependent's worktree from a base that includes its merged deps.

## Obstacles confirmed/filed this run
- **#784** (new, high) — premature cascade: dependents cut from a pre-merge base; fatal for the foundational shell. Recovery = force-merge + delete/re-cascade.
- **#782** (re-confirmed) — `runAutoStart` doesn't launch fan-in dependents (tier-2, integration) even with free slots; `start-next` does. The watcher's per-cycle start-next bridges it.
- **#783** (validated again) — the verify-gate auto-commit of the pnpm pin + build-approval landed on master; cold clone builds clean.

## Net
The board drove a **20-ticket, 3-tier app to a clean-building master**. The flat-fan-out tiers (budget-pilot-style) are now effectively hands-off; the new friction at this complexity is the **premature-cascade across a foundational dependency** (#784) — currently needs a one-time force-merge + rebuild of the first dependent batch. Closing #784 (gate cascade on merged-not-Done) would make even a deep multi-tier drive fully unattended.

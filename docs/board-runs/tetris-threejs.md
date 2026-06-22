# Board run: tetris-threejs (3D Tetris)

**Date:** 2026-06-22
**Goal:** Smoke-test the board end-to-end by driving a small Vite + Three.js Tetris game to completion, builders pinned to **claude / anth**.
**Project id:** `c43fc2fe-5fd0-4f25-ba90-37660702c71d` · repo `C:\andrena\tetris-threejs`

## Outcome
Epic meta #9 → **Done**. All children merged to `master`; fresh `npm install && npm run build && npm test` green (**68 tests / 6 files**). Bundle grew 58 KB → 470 KB once `scene.js`/`render.js` landed, confirming Three.js is actually wired in (real 3D rendering, not stubs).

## What was seeded
Scaffold (committed to master before registration to avoid the dirty-`.gitignore` first-merge hazard): Vite + Three skeleton with **documented module contracts** per file and a shell-owned `src/main.js` game loop, so every wave ticket owned exactly one disjoint `src/*.js` + its own `test/*.test.js` (no shared hot file).

The board's own autodrive ran a backlog-refill (#1) and generated the wave itself:
- #2 board model, #3 pieces/rotation, #4 input, #5 score/HUD — mapped cleanly onto the scaffold's disjoint modules.
- #6/#7/#8 (hold-piece, pause/restart, ghost) — **cancelled**: all touched the shell-owned `main.js` (conflict thrash) and exceeded "small".
- Added #10 scene + #11 render (the actual Three.js work the refill missed) as disjoint-file children of meta #9.

## Parallelism achieved
WIP target 3 (`board_strategy_*` with `activeAgentsTarget:3`, `maxNewStartsPerCycle:3`, `backlogFloor:0`). Up to 3 builders ran concurrently; full epic (6 modules) merged in ~17 min wall-clock. Disjoint-file ownership meant zero append conflicts on the implemented set.

## Provider
Pinned per-project via `board_strategy_*.providerPolicies = [{provider:"claude", profileName:"anth", mode:"fill"}]` — every auto-started/relaunched workspace verified `provider=claude` (avoided the codex-default pitfall).

## Escalations / friction
- **A builder auto-launched on the meta ticket #9** despite the `no-auto-start` tag (created in Backlog because single-create ignores `statusName`; the monitor started it before it was held In Progress). Its fix-and-merge zombie also blocked the close-out terminal-move guard. Recovery: delete the stray workspace (took the full-UUID DELETE; a short-id DELETE during active fix-and-merge didn't stick), keep #9 In Progress, then move to Done. → The `no-auto-start` tag did not prevent the initial auto-start; worth confirming the tag check, or create meta tickets directly in a non-Backlog column.

## Mechanism notes
- No first-class Drive record (used CLI `create-batch` for transactional inline deps + `--parent` over REST's parent+driveTarget), so the engine's `reconcileDriveCompletion` contract enforcement did not apply; the resident self-paced `/loop` watch held the completion contract instead (pulled #9 back to In Progress when it drifted to In Review).

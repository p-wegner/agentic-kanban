/**
 * #993 — keep the committed test-impact map fresh on projects the MONITOR CYCLE never visits.
 *
 * The refresh already existed (#952) as a PHASE INSIDE `runMonitorCycle`
 * (`monitor-test-impact-map.ts`). That is the right place for it when a cycle runs: it lands
 * BEFORE `runAutoStart`, so a builder launched this cycle forks from the branch the pass just
 * committed. But it is the ONLY place, and a cycle is not something every project gets —
 * `start_mode = manual` is a true kill-switch (decision 008), so `monitorShouldRun` is false and
 * the phase never executes.
 *
 * Measured on this board 2026-09-01: `docs/tests/impact-map.json` was stamped `2e04e24667`,
 * **46 commits behind HEAD**, because this board is Conductor-driven and therefore `manual`. The
 * consequence was silent rather than loud — a stale inventory does not fail, it WIDENS:
 *
 *     tier: package, 4 changed file(s), 1 test file(s) selected  [inventory STALE]
 *       escalation: inventory 46 commits stale -> widened
 *
 * `impact` is the tier the board claimed to run; `package` is what it ran. Both consumers
 * degraded together — the merge gate (`risk_posture = iterate` -> `gateTier: impact`) and every
 * BUILDER's inner loop (`test_impact_budget` -> `KANBAN_TEST_SELECTOR=impact` in the launch env)
 * — and `test_impact_map_refresh` was set to `true` the whole time. An operator had turned the
 * feature on and it was off.
 *
 * ## Why a sweep, and why the cycle phase STAYS
 *
 * This is the **background sweep** kind (see `packages/server/CLAUDE.md`): a periodic pass over
 * state, registered in `BACKGROUND_SERVICES`, running regardless of what any project's start
 * mode says. Keeping a generated artifact fresh is not an auto-start concern and should never
 * have been coupled to one.
 *
 * The monitor phase is deliberately NOT removed. It buys something this sweep cannot — the
 * fork-freshness coupling above — and running both is safe because the pass is idempotent: it
 * short-circuits on a freshness check before taking any lock, so on a monitor-driven project
 * this sweep is a few `stat` calls and nothing else. Two callers of an idempotent pass is the
 * cheap way to keep that ordering guarantee while removing the single point of failure.
 *
 * ## What this does NOT fix
 *
 * The rot is still INVISIBLE when it happens: the skill reports staleness on its own `select`
 * line, and the board never lifts it into the gate verdict, so a gate can still print
 * `tier: impact` for a run that escalated to `package`. That is the other half of #993 and it
 * belongs on #988's `[gate:step]` marker-parsing machinery rather than in a second parser here.
 */
import { toPrefMap } from "@agentic-kanban/shared/lib/preference-map";

import type { Database } from "../db/index.js";
import { getAllPreferencesCached } from "../repositories/preferences.repository.js";
import { startPeriodicSweep, type PeriodicSweepHandle } from "../lib/periodic-sweep.js";
import { runTestImpactMapRefresh } from "./monitor-test-impact-map.js";

/**
 * How often the sweep checks.
 *
 * Far less aggressive than the monitor phase, which effectively ran it every cycle (~30s), and
 * that is fine: the cost of a slightly-old map is a WIDER test selection, never a wrong one. The
 * check itself is cheap by construction — `runTestImpactMapPass` compares the map's stamped
 * commit against HEAD and returns `fresh` without taking the repo lock — so the steady-state
 * cost of this sweep on a quiet board is a handful of `git rev-parse` calls per project.
 */
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;

/**
 * One pass: refresh every project whose map is stale and whose gate allows it.
 *
 * `allowProject` is `() => true` on purpose. The monitor passes a predicate restricting the
 * cycle to projects it may ACT on (start work, merge); this sweep writes no board state and
 * launches nothing, so that predicate is not the right filter for it. The per-project opt-out
 * that IS right — `resolveTestImpactMapGate`, i.e. `test_impact_map_<projectId>` over the
 * board-wide `test_impact_map_refresh` — is applied inside the shared pass, so deferring to it
 * here keeps ONE answer to "may this project's map be rebuilt" rather than two.
 *
 * A project that tracks no map is a documented no-op (`resolveImpactMapPaths`), so sweeping
 * every registered project costs nothing on the ~25 that never had one.
 */
export async function reconcileTestImpactMaps(database?: Database): Promise<number> {
  const prefMap = toPrefMap(await getAllPreferencesCached(database));
  return runTestImpactMapRefresh(prefMap, { allowProject: () => true, database });
}

let sweep: PeriodicSweepHandle | null = null;

export function startTestImpactMapReconciler(opts: { intervalMs?: number; database?: Database } = {}): void {
  stopTestImpactMapReconciler();
  sweep = startPeriodicSweep({
    name: "test-impact-map",
    intervalMs: opts.intervalMs ?? SWEEP_INTERVAL_MS,
    tick: () => reconcileTestImpactMaps(opts.database),
  });
}

export function stopTestImpactMapReconciler(): void {
  sweep?.stop();
  sweep = null;
}

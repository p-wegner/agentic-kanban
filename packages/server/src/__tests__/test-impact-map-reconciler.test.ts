/**
 * #993 — the test-impact map refresh must not depend on the monitor cycle.
 *
 * It was a PHASE INSIDE `runMonitorCycle`, so a project whose `start_mode` is `manual` (a true
 * kill-switch, decision 008) never refreshed it. Measured on this board: the map sat 46 commits
 * stale, and every selection silently escalated `tier: impact` -> `tier: package` — in the merge
 * gate AND in every builder's inner loop — while `test_impact_map_refresh` was `true`.
 *
 * The subject here is the SWEEP's contract, not the pass: that it reaches projects the cycle
 * never visits, and that it defers the "may this project's map be rebuilt" question to the one
 * gate that already answers it rather than inventing a second.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { runTestImpactMapRefresh } = vi.hoisted(() => ({ runTestImpactMapRefresh: vi.fn() }));
vi.mock("../startup/monitor-test-impact-map.js", () => ({ runTestImpactMapRefresh }));

const { getAllPreferencesCached } = vi.hoisted(() => ({ getAllPreferencesCached: vi.fn() }));
vi.mock("../repositories/preferences.repository.js", () => ({ getAllPreferencesCached }));

import { reconcileTestImpactMaps } from "../startup/test-impact-map-reconciler.js";
import { BACKGROUND_SERVICES } from "../startup/background-services.js";

beforeEach(() => {
  runTestImpactMapRefresh.mockReset().mockResolvedValue(0);
  getAllPreferencesCached.mockReset().mockResolvedValue([
    { key: "test_impact_map_refresh", value: "true" },
  ]);
});

describe("#993: the map refresh runs off the monitor cycle", () => {
  it("is registered as a background sweep, so start_mode cannot switch it off", () => {
    // The whole defect: the only caller was a monitor phase, and `manual` means no cycle. A
    // BACKGROUND_SERVICES entry starts at boot regardless of any project's start mode.
    expect(BACKGROUND_SERVICES.map((s) => s.name)).toContain("test-impact-map-reconciler");
  });

  it("sweeps EVERY project, deferring the per-project opt-out to the shared gate", () => {
    // `allowProject` restricts the monitor to projects it may ACT on (start work, merge). This
    // sweep writes no board state and launches nothing, so that predicate is the wrong filter —
    // and using it would resurrect the bug for exactly the projects the cycle skips. The real
    // opt-out (`test_impact_map_<projectId>` over the board-wide default) lives inside the pass.
    return reconcileTestImpactMaps().then(() => {
      expect(runTestImpactMapRefresh).toHaveBeenCalledOnce();
      const [, opts] = runTestImpactMapRefresh.mock.calls[0];
      expect(opts.allowProject("any-project-id-at-all")).toBe(true);
    });
  });

  it("passes the loaded preferences through, so the board-wide gate is actually read", async () => {
    await reconcileTestImpactMaps();
    const [prefMap] = runTestImpactMapRefresh.mock.calls[0];
    // A prefMap the pass can read `test_impact_map_refresh` out of — an empty map would make the
    // gate answer "disabled" for every project and the sweep a silent no-op, which is the same
    // observable behaviour as the bug it fixes.
    expect(prefMap.get("test_impact_map_refresh")).toBe("true");
  });

  it("does not swallow the pass's rebuild count — a caller can tell a no-op from work", async () => {
    runTestImpactMapRefresh.mockResolvedValue(3);
    await expect(reconcileTestImpactMaps()).resolves.toBe(3);
  });
});

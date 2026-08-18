/**
 * #654 — the board reported two contradictory WIP limits, both authoritatively.
 *
 * The Backlog's Dependency Waves panel showed "0/5 WIP, 5 slots open" and offered
 * "Start Next Wave (5)" on `comet`, whose `wip_limit_<id>`, Strategy Bullseye
 * `activeAgentsTarget` and `maxNewStartsPerCycle` were all 2 — while the Board Monitor
 * popover, two clicks away, correctly said "Agents target 2".
 *
 * Cause: `getWipInfo` read only the GLOBAL `nudge_wip_limit`, which is unset in most installs,
 * so it fell through to a hardcoded 5. The fix is not another parse — it is routing the panel
 * through `resolveMonitorTunables`, the same function the monitor popover reads, so the two
 * surfaces cannot disagree again.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getWipLimitPrefMapMock = vi.fn();
const getInProgressStatusIdsMock = vi.fn();
const getActiveWipCountMock = vi.fn();

vi.mock("../repositories/dependency-wave.repository.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../repositories/dependency-wave.repository.js")>()),
  getWipLimitPrefMap: (...a: unknown[]) => getWipLimitPrefMapMock(...a),
  getInProgressStatusIds: (...a: unknown[]) => getInProgressStatusIdsMock(...a),
  getActiveWipCount: (...a: unknown[]) => getActiveWipCountMock(...a),
  getProjectIssuesForWave: async () => [],
  getOpenWorkspaceIssueIds: async () => [],
  getWaveDependencyRows: async () => [],
  getUpstreamWorkspaceLandingRows: async () => [],
}));

const { buildDependencyWavePlan } = await import("../services/dependency-wave.service.js");

const db = {} as never;
const PROJECT = "p-comet";

/** A Strategy Bullseye whose derived `activeAgentsTarget` is `n`. */
function bullseye(n: number): string {
  return JSON.stringify({ activeAgentsTarget: n, maxNewStartsPerCycle: n, backlogFloor: 3, refillFocus: "balanced", weights: {} });
}

async function limitFor(prefs: Record<string, string>, override?: number): Promise<number> {
  getWipLimitPrefMapMock.mockResolvedValue(new Map(Object.entries(prefs)));
  const plan = await buildDependencyWavePlan(db, PROJECT, override === undefined ? {} : { wipLimit: override });
  return plan.wip.limit;
}

beforeEach(() => {
  vi.clearAllMocks();
  getInProgressStatusIdsMock.mockResolvedValue(["s1"]);
  getActiveWipCountMock.mockResolvedValue(0);
});

describe("dependency-wave WIP limit (#654)", () => {
  it("honours the per-project `wip_limit_<id>` — the pref the onboarding wizard writes", async () => {
    expect(await limitFor({ [`wip_limit_${PROJECT}`]: "2" })).toBe(2);
  });

  it("falls back to the Strategy Bullseye, the same source the monitor popover reports", async () => {
    expect(await limitFor({ [`board_strategy_${PROJECT}`]: bullseye(2) })).toBe(2);
  });

  it("prefers the per-project pref over the Bullseye when both exist", async () => {
    expect(await limitFor({ [`wip_limit_${PROJECT}`]: "3", [`board_strategy_${PROJECT}`]: bullseye(7) })).toBe(3);
  });

  it("still honours the legacy global `nudge_wip_limit` when nothing more specific is set", async () => {
    expect(await limitFor({ nudge_wip_limit: "4" })).toBe(4);
  });

  it("an explicit caller override beats every preference", async () => {
    expect(await limitFor({ [`wip_limit_${PROJECT}`]: "2", nudge_wip_limit: "4" }, 9)).toBe(9);
  });

  it("does NOT read another project's per-project limit", async () => {
    // The map is fetched by key, but a wrong-key read would silently look correct on a
    // single-project install — this pins the scoping.
    expect(await limitFor({ "wip_limit_someone-else": "11", nudge_wip_limit: "4" })).toBe(4);
  });

  it("keeps the hardcoded 5 only as a LAST resort, with nothing configured at all", async () => {
    expect(await limitFor({})).toBe(5);
  });

  it("ignores nonsense rather than letting it become the limit", async () => {
    expect(await limitFor({ [`wip_limit_${PROJECT}`]: "0", nudge_wip_limit: "4" })).toBe(4);
    expect(await limitFor({ [`wip_limit_${PROJECT}`]: "soon", nudge_wip_limit: "4" })).toBe(4);
    expect(await limitFor({ [`wip_limit_${PROJECT}`]: "-3" })).toBe(5);
  });

  it("reports available slots against the real limit, which is what the button offers", async () => {
    getActiveWipCountMock.mockResolvedValue(1);
    getWipLimitPrefMapMock.mockResolvedValue(new Map([[`wip_limit_${PROJECT}`, "2"]]));
    const plan = await buildDependencyWavePlan(db, PROJECT, {});
    expect(plan.wip).toMatchObject({ current: 1, limit: 2, available: 1 });
  });
});

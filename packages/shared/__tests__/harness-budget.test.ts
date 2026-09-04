import { describe, expect, it } from "vitest";
import {
  DEFAULT_HARNESS_SHARE_PCT,
  HARNESS_TAG,
  clampHarnessSharePct,
  harnessSharePct,
  harnessSlots,
  looksLikeHarnessTicket,
} from "../src/lib/harness-budget.js";
import {
  deriveMonitorTunables,
  parseStrategyBullseyeConfig,
  renderGeneratedStrategyBlock,
  resolveMonitorTunables,
} from "../src/lib/strategy-objective-file.js";

/**
 * #1021 — the harness budget's pure half: the arithmetic that turns a share into a slot
 * count, and the Strategy Bullseye plumbing that carries the share to every monitor.
 */
describe("harness budget arithmetic", () => {
  it("the DEFAULT share is one builder of three — the acceptance criterion, in slots", () => {
    // Stated in the ticket as "at most one of three", so the percent is only a spelling of it.
    expect(harnessSlots(3, DEFAULT_HARNESS_SHARE_PCT)).toBe(1);
  });

  it("100 % hands back the whole WIP, i.e. the budget never bites", () => {
    expect(harnessSlots(3, 100)).toBe(3);
    expect(harnessSlots(7, 100)).toBe(7);
  });

  it("never rounds down to zero — a tiny share still leaves one harness slot", () => {
    // Zero would mean "never start harness work", which is the `no-auto-start` tag's job.
    expect(harnessSlots(3, 1)).toBe(1);
    expect(harnessSlots(10, 5)).toBe(1);
  });

  it("scales with the WIP limit", () => {
    expect(harnessSlots(6, DEFAULT_HARNESS_SHARE_PCT)).toBe(2);
    expect(harnessSlots(9, DEFAULT_HARNESS_SHARE_PCT)).toBe(3);
    expect(harnessSlots(4, 50)).toBe(2);
  });

  it("a zero or nonsensical WIP limit yields no slots at all", () => {
    expect(harnessSlots(0, DEFAULT_HARNESS_SHARE_PCT)).toBe(0);
    expect(harnessSlots(Number.NaN, DEFAULT_HARNESS_SHARE_PCT)).toBe(0);
  });

  it("clamps a share out of range instead of trusting it", () => {
    expect(clampHarnessSharePct(0)).toBe(1);
    expect(clampHarnessSharePct(500)).toBe(100);
    expect(clampHarnessSharePct("not a number")).toBe(DEFAULT_HARNESS_SHARE_PCT);
    expect(clampHarnessSharePct(undefined)).toBe(DEFAULT_HARNESS_SHARE_PCT);
  });

  it("reports an empty week as null, not as 0 % — they are different answers", () => {
    expect(harnessSharePct(0, 0)).toBeNull();
    expect(harnessSharePct(10, 6)).toBe(60);
    expect(harnessSharePct(3, 0)).toBe(0);
  });
});

describe("harness keyword classifier", () => {
  it("recognises the work the proposal measured as harness", () => {
    expect(looksLikeHarnessTicket("Add a ratchet for the wire DTOs")).toBe(true);
    expect(looksLikeHarnessTicket("Speed up the pre-merge gate", null)).toBe(true);
    expect(looksLikeHarnessTicket("Refresh the impact map nightly")).toBe(true);
    expect(looksLikeHarnessTicket("Board view", "the monitor cycle skips it")).toBe(true);
  });

  it("leaves product work alone", () => {
    expect(looksLikeHarnessTicket("Show the issue's tags on the card")).toBe(false);
    expect(looksLikeHarnessTicket("Fix the crash when merging an empty branch")).toBe(false);
    expect(looksLikeHarnessTicket("", null, undefined)).toBe(false);
  });

  it("the tag it proposes is the one the monitor reads", () => {
    expect(HARNESS_TAG).toBe("harness");
  });
});

describe("harness share as a Strategy Bullseye tunable", () => {
  it("round-trips through parse → derive like every other tunable", () => {
    const config = parseStrategyBullseyeConfig(JSON.stringify({ activeAgentsTarget: 3, harnessSharePct: 50 }));
    expect(config.harnessSharePct).toBe(50);
    expect(deriveMonitorTunables(config).harnessSharePct).toBe(50);
  });

  it("defaults when the Bullseye never named it", () => {
    const config = parseStrategyBullseyeConfig(JSON.stringify({ activeAgentsTarget: 3 }));
    expect(deriveMonitorTunables(config).harnessSharePct).toBe(DEFAULT_HARNESS_SHARE_PCT);
  });

  it("clamps a hand-edited out-of-range value", () => {
    expect(deriveMonitorTunables(parseStrategyBullseyeConfig(JSON.stringify({ harnessSharePct: 0 }))).harnessSharePct).toBe(1);
    expect(deriveMonitorTunables(parseStrategyBullseyeConfig(JSON.stringify({ harnessSharePct: 900 }))).harnessSharePct).toBe(100);
  });

  it("reaches the deterministic monitor through resolveMonitorTunables", () => {
    const prefMap = new Map<string, string>([
      ["board_strategy_proj-1", JSON.stringify({ activeAgentsTarget: 3, harnessSharePct: 100 })],
    ]);
    const resolved = resolveMonitorTunables(prefMap, "proj-1");
    expect(resolved.source).toBe("strategy");
    expect(resolved.tunables.harnessSharePct).toBe(100);
  });

  it("applies on the LEGACY pref path too — a project that never opened the Bullseye is the one most likely to drift", () => {
    const resolved = resolveMonitorTunables(new Map([["nudge_wip_limit", "5"]]), "proj-1");
    expect(resolved.source).toBe("prefs");
    expect(resolved.tunables.harnessSharePct).toBe(DEFAULT_HARNESS_SHARE_PCT);
  });

  it("is rendered into the generated objective block, so the Conductor reads the same number", () => {
    const block = renderGeneratedStrategyBlock(parseStrategyBullseyeConfig(JSON.stringify({ harnessSharePct: 25 })));
    expect(block).toContain("HARNESS_SHARE = 25%");
    // The block is what an agent steers by, so the tag it gates on has to be named in it.
    expect(block).toContain("`harness`-tagged");
  });
});

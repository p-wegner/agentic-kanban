import { describe, expect, it } from "vitest";
import {
  parseProviderPoliciesFromStrategy,
  normalizeProviderPolicies,
  selectPolicyByPriority,
  resolveProviderProfileFromPrefs,
  strategyPrefKey,
  type ProviderProfilePolicy,
} from "../src/lib/strategy-policy.js";
import { parseStrategyBullseyeConfig } from "../src/lib/strategy-objective-file.js";

/**
 * Regression lock for arch-review §3.3: the SAME `board_strategy_<id>` blob must
 * select the SAME provider whichever door reads it.
 *
 * Before the fix there were TWO parsers with divergent semantics:
 *   - the server door (`parseStrategyBullseyeConfig` → `selectProviderFromStrategy`)
 *     FILTERED OUT any policy entry lacking a string `id`/`provider`.
 *   - the shared/MCP door (`parseProviderPoliciesFromStrategy` → `resolveProviderProfileFromPrefs`)
 *     KEPT the entry and SYNTHESIZED the missing fields.
 * So a blob with an entry missing `id` (or `provider`) selected a provider through
 * one door and NOTHING (or a different provider) through the other. Both doors now
 * funnel through the shared `normalizeProviderPolicies` — keep + synthesize.
 */

// Mirror the two selection doors on top of the (now unified) parser. `allowFallback:false`
// is the shared default both real doors use (server `selectProviderFromStrategy` and shared
// `resolveProviderProfileFromPrefs`).
function serverDoorSelect(rawBlob: string): { provider: string; profileName: string } | null {
  const config = parseStrategyBullseyeConfig(rawBlob);
  const chosen = selectPolicyByPriority(config.providerPolicies ?? [], { allowFallback: false });
  return chosen ? { provider: chosen.provider, profileName: chosen.profileName } : null;
}

function sharedDoorSelect(rawBlob: string): { provider: string; profileName: string } | null {
  const prefMap = new Map<string, string>([[strategyPrefKey("proj-1"), rawBlob]]);
  const sel = resolveProviderProfileFromPrefs(prefMap, "proj-1");
  return sel.source === "strategy" ? { provider: sel.provider, profileName: sel.profileName ?? "" } : null;
}

function normKey(p: ProviderProfilePolicy) {
  return { id: p.id, provider: p.provider, profileName: p.profileName, mode: p.mode, headroomPct: p.headroomPct };
}

describe("strategy-policy parser parity (arch-review §3.3)", () => {
  it("both doors normalize a well-formed blob to the identical policy set", () => {
    const blob = JSON.stringify({
      providerPolicies: [
        { id: "p1", provider: "claude", profileName: "work", label: "Claude Work", mode: "throttle", headroomPct: 20, notes: "" },
        { id: "p2", provider: "codex", profileName: "default", label: "Codex", mode: "fill", headroomPct: 0, notes: "" },
      ],
    });
    const serverPolicies = (parseStrategyBullseyeConfig(blob).providerPolicies ?? []).map(normKey);
    const sharedPolicies = parseProviderPoliciesFromStrategy(blob).map(normKey);
    expect(serverPolicies).toEqual(sharedPolicies);
  });

  it("KEEPS + synthesizes an entry missing `id` — both doors, identically (the §3.3 divergence)", () => {
    // No `id`. The old server filter DROPPED this (isRawProviderPolicy required a string id);
    // the shared normalizer synthesized one. That gap made the doors pick different providers.
    const blob = JSON.stringify({
      providerPolicies: [
        { provider: "codex", profileName: "work", label: "Codex", mode: "fill", headroomPct: 0, notes: "" },
      ],
    });
    const serverPolicies = parseStrategyBullseyeConfig(blob).providerPolicies ?? [];
    const sharedPolicies = parseProviderPoliciesFromStrategy(blob);

    // Neither door drops the entry.
    expect(serverPolicies).toHaveLength(1);
    expect(sharedPolicies).toHaveLength(1);
    // Both synthesize the same id + keep provider/mode.
    expect(serverPolicies.map(normKey)).toEqual(sharedPolicies.map(normKey));
    expect(serverPolicies[0].provider).toBe("codex");
    expect(serverPolicies[0].id).toBeTruthy();

    // ...and therefore select the SAME provider through both doors.
    expect(serverDoorSelect(blob)).toEqual(sharedDoorSelect(blob));
    expect(serverDoorSelect(blob)).toEqual({ provider: "codex", profileName: "work" });
  });

  it("KEEPS + defaults an entry missing `provider` to claude — both doors, identically", () => {
    const blob = JSON.stringify({
      providerPolicies: [
        { id: "x", profileName: "anth", label: "x", mode: "fill", headroomPct: 0, notes: "" },
      ],
    });
    const serverPolicies = parseStrategyBullseyeConfig(blob).providerPolicies ?? [];
    const sharedPolicies = parseProviderPoliciesFromStrategy(blob);
    expect(serverPolicies).toHaveLength(1);
    expect(sharedPolicies).toHaveLength(1);
    expect(serverPolicies.map(normKey)).toEqual(sharedPolicies.map(normKey));
    expect(serverDoorSelect(blob)).toEqual(sharedDoorSelect(blob));
    expect(serverDoorSelect(blob)?.provider).toBe("claude");
  });

  it("selects the same provider through both doors across the priority ladder", () => {
    // fill wins over throttle over fallback-only — identically on both doors.
    const blob = JSON.stringify({
      providerPolicies: [
        { id: "t", provider: "claude", profileName: "work", label: "c", mode: "throttle", headroomPct: 20, notes: "" },
        { id: "f", provider: "codex", profileName: "default", label: "x", mode: "fill", headroomPct: 0, notes: "" },
        { id: "fb", provider: "copilot", profileName: "gw", label: "y", mode: "fallback-only", headroomPct: 0, notes: "" },
      ],
    });
    expect(serverDoorSelect(blob)).toEqual(sharedDoorSelect(blob));
    expect(serverDoorSelect(blob)).toEqual({ provider: "codex", profileName: "default" });
  });

  it("normalizeProviderPolicies is the single normalizer both public parsers delegate to", () => {
    const raw = [
      { provider: "codex", profileName: "work", mode: "fill" },
      { id: "y", provider: "claude", profileName: "anth", mode: "throttle", headroomPct: 30 },
    ];
    const viaHelper = normalizeProviderPolicies(raw).map(normKey);
    const viaStrategyParser = parseProviderPoliciesFromStrategy(JSON.stringify({ providerPolicies: raw })).map(normKey);
    const viaBullseyeParser = (parseStrategyBullseyeConfig(JSON.stringify({ providerPolicies: raw })).providerPolicies ?? []).map(normKey);
    expect(viaStrategyParser).toEqual(viaHelper);
    expect(viaBullseyeParser).toEqual(viaHelper);
  });

  it("empty / policy-less blob yields no selection through either door", () => {
    const blob = JSON.stringify({ version: 1, segments: [], providerPolicies: [] });
    expect(parseStrategyBullseyeConfig(blob).providerPolicies).toEqual([]);
    expect(parseProviderPoliciesFromStrategy(blob)).toEqual([]);
    expect(serverDoorSelect(blob)).toBeNull();
    expect(sharedDoorSelect(blob)).toBeNull();
  });

  describe("quota gating is a server-only additive layer, NOT part of the shared parser (documented §3.3 boundary)", () => {
    // The shared parser + `selectPolicyByPriority` are quota-FREE and client-safe. Live-quota
    // gating (`isPolicyBlockedByQuota`, which needs the server-only quota-usage service) is
    // layered ON TOP via the optional `isBlocked` hook, applied only by the server launch door
    // (`resolveStrategyProviderSelection`). The MCP `start_workspace` (bare worktree, no launch)
    // and the butler (one warm assistant) deliberately select PRE-quota using the same parser.
    // This test asserts the boundary: `isBlocked` is what changes the selection — the parser and
    // priority core never consult quota.
    const blob = JSON.stringify({
      providerPolicies: [
        { id: "f", provider: "codex", profileName: "default", label: "x", mode: "fill", headroomPct: 0, notes: "", quotaProviderId: "codex-q" },
        { id: "t", provider: "claude", profileName: "work", label: "c", mode: "throttle", headroomPct: 20, notes: "" },
      ],
    });

    it("pre-quota (no isBlocked): both doors pick the fill policy", () => {
      const policies = parseProviderPoliciesFromStrategy(blob);
      const preQuota = selectPolicyByPriority(policies, { allowFallback: false });
      expect(preQuota?.provider).toBe("codex");
      expect(serverDoorSelect(blob)?.provider).toBe("codex");
      expect(sharedDoorSelect(blob)?.provider).toBe("codex");
    });

    it("with a caller-supplied isBlocked (the server quota layer): selection falls through to throttle", () => {
      const policies = parseProviderPoliciesFromStrategy(blob);
      const withQuota = selectPolicyByPriority(policies, {
        allowFallback: false,
        isBlocked: (p) => p.id === "f",
      });
      expect(withQuota?.provider).toBe("claude");
      // Crucially, the parser output was identical — only the additive isBlocked hook changed
      // the outcome, proving quota is a server-only layer over the shared parser, not a parser fork.
    });
  });
});

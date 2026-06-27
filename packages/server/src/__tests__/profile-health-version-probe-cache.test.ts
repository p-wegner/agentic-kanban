// @covers agent-providers.preflight.profileHealth [state-transition]
//
// Gap (PARTIAL): the exemplar agent-profile-health.service.test.ts asserts the
// failure-override-to-error and missing-config-error cases. UNASSERTED and covered
// here:
//   1. the `<cli> --version` probe is CACHED once per distinct (provider, command)
//      pair — probing N profiles of ONE provider must invoke the probe exactly once,
//      not once per profile. Mutation: drop the dedup map -> probe runs N times -> RED.
//   2. the ok -> warning -> error verdict FOLD (foldVersionIntoPreflight) and that it
//      composes correctly over BOTH auth-validation inputs (codex config-file path and
//      codex license-ring path), with `error` dominating a folded version verdict.

import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted spy so vi.mock (which is hoisted above imports) can close over it.
const { detectSpy } = vi.hoisted(() => ({ detectSpy: vi.fn() }));

vi.mock("../services/agent-cli-version.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/agent-cli-version.service.js")>();
  return { ...actual, detectCliVersion: detectSpy };
});

import { createTestDb } from "./helpers/test-db.js";
import {
  listAgentProfileHealth,
  preflightAgentProfile,
  foldVersionIntoPreflight,
  type AgentProfilePreflightResult,
} from "../services/agent-profile-health.service.js";
import type { CliVersionResult } from "../services/agent-cli-version.service.js";

const okVersion: CliVersionResult = { detected: true, raw: "9.9.9", version: "9.9.9", status: "ok", message: null };

function verdict(status: CliVersionResult["status"], message: string): CliVersionResult {
  return {
    detected: status === "below-min" || status === "above-known",
    raw: "raw",
    version: status === "below-min" || status === "above-known" ? "0.0.1" : null,
    status,
    message,
  };
}

describe("profile health version-probe cache + verdict fold", () => {
  beforeEach(() => {
    detectSpy.mockReset();
    detectSpy.mockResolvedValue(okVersion);
  });

  it("probes the version ONCE per provider command even with many profiles of that provider", async () => {
    const { db } = createTestDb();

    // Four Claude profiles (default + three named) all resolve to the SAME `claude`
    // command, so the cache must collapse them to a single `--version` probe.
    const rows = await listAgentProfileHealth(db, {
      claudeProfiles: ["alpha", "beta", "gamma"],
      codexProfiles: [],
      copilotProfiles: [],
      piProfiles: [],
    });

    // All four Claude profiles produced rows.
    const claudeRows = rows.filter((r) => r.provider === "claude");
    expect(claudeRows.map((r) => r.profileName).sort()).toEqual(["alpha", "beta", "default", "gamma"]);

    // The probe was invoked exactly once for the (claude, <command>) pair, despite
    // four Claude candidates. Removing the dedup map -> 4 claude probes -> RED.
    const claudeProbeCalls = detectSpy.mock.calls.filter(([provider]) => provider === "claude");
    expect(claudeProbeCalls.length).toBe(1);

    // The single cached verdict was folded into every Claude profile row.
    for (const row of claudeRows) {
      expect(row.preflight.version).toEqual(okVersion);
    }
  });

  it("invokes the probe once per DISTINCT provider command (one per provider here)", async () => {
    const { db } = createTestDb();

    await listAgentProfileHealth(db, {
      claudeProfiles: ["a", "b"],
      codexProfiles: [],
      copilotProfiles: [],
      piProfiles: [],
    });

    // claude/codex/copilot/pi defaults each resolve to a distinct command -> one
    // probe per provider; the two extra claude profiles add no extra probe.
    const byProvider = new Map<string, number>();
    for (const [provider] of detectSpy.mock.calls) {
      byProvider.set(provider as string, (byProvider.get(provider as string) ?? 0) + 1);
    }
    expect(byProvider.get("claude")).toBe(1);
    // Distinct provider commands => distinct probes; no provider probed twice.
    for (const count of byProvider.values()) {
      expect(count).toBe(1);
    }
  });

  it("folds version verdicts ok -> warning -> error onto a clean preflight", () => {
    const okBase: AgentProfilePreflightResult = {
      ok: true,
      status: "ok",
      errors: [],
      warnings: [],
      command: "claude",
      profileName: "default",
      provider: "claude",
      flags: [],
      version: null,
    };

    // ok verdict keeps it ok.
    expect(foldVersionIntoPreflight(okBase, okVersion).status).toBe("ok");

    // A newer-than-known (above-known) verdict downgrades ok -> warning.
    const warned = foldVersionIntoPreflight(okBase, verdict("above-known", "newer than verified"));
    expect(warned.status).toBe("warning");
    expect(warned.ok).toBe(true);
    expect(warned.warnings).toContain("newer than verified");

    // A below-min verdict escalates ok -> error.
    const errored = foldVersionIntoPreflight(okBase, verdict("below-min", "too old"));
    expect(errored.status).toBe("error");
    expect(errored.ok).toBe(false);
    expect(errored.errors).toContain("too old");
  });

  it("error from auth validation DOMINATES the folded version verdict (config-file vs license-ring paths agree)", () => {
    // Config-file auth path: a named codex profile with no settings file on disk.
    const configFileBase = preflightAgentProfile(new Map(), "codex", "nonexistent-xyz");
    expect(configFileBase.status).toBe("error");
    expect(configFileBase.errors.some((e) => e.includes("Profile config not found"))).toBe(true);

    // License-ring auth path: a codex license whose CODEX_HOME has no auth.json.
    const ring = JSON.stringify([{ profile: "lic-xyz", codexHome: "C:/nonexistent-codex-home-xyz" }]);
    const licenseRingBase = preflightAgentProfile(new Map([["codex_license_ring", ring]]), "codex", "lic-xyz");
    expect(licenseRingBase.status).toBe("error");
    expect(licenseRingBase.errors.some((e) => e.includes("not logged in"))).toBe(true);

    // Folding even an OK version verdict must NOT clear a pre-existing auth error:
    // error dominates the fold on BOTH paths identically.
    for (const base of [configFileBase, licenseRingBase]) {
      const folded = foldVersionIntoPreflight(base, okVersion);
      expect(folded.status).toBe("error");
      expect(folded.ok).toBe(false);
      // The version verdict is still recorded even though it didn't change the verdict.
      expect(folded.version).toEqual(okVersion);
    }

    // And a warning-grade version verdict likewise cannot soften an auth error.
    const stillError = foldVersionIntoPreflight(configFileBase, verdict("above-known", "newer"));
    expect(stillError.status).toBe("error");
  });
});

import { describe, it, expect } from "vitest";
import { resolveMergeGateConfig } from "../services/pre-merge-gate.service.js";
import type { StackProfile } from "@agentic-kanban/shared";

/**
 * #546: "does this project have a pre-merge gate" was derived three ways, and the two
 * cheap ones (`projectHasMergeGate`, the merge-queue orchestrator) said `isWeb` alone.
 * That is WIDER than the gate: `buildSmokeCheck` also needs a dev command and a
 * resolvable health URL. The gap is not cosmetic — a project caught by it has
 * `auto_merge_in_review` suppressed while waiting for a check that never runs.
 */
const webProfile = (over: Partial<StackProfile> = {}): StackProfile => ({
  language: "typescript",
  packageManager: "pnpm",
  isWeb: true,
  devCommand: "pnpm dev",
  devPort: 5173,
  ...over,
} as StackProfile);

describe("#546: resolveMergeGateConfig", () => {
  it("is gated by a verify script alone", () => {
    const cfg = resolveMergeGateConfig({ verifyScript: "pnpm test", profile: null });
    expect(cfg.hasGate).toBe(true);
    expect(cfg.verifyScript).toBe("pnpm test");
    expect(cfg.smoke).toBeNull();
  });

  it("treats a blank verify script as no verify half", () => {
    expect(resolveMergeGateConfig({ verifyScript: "   ", profile: null }).hasGate).toBe(false);
    expect(resolveMergeGateConfig({ verifyScript: undefined, profile: null }).verifyScript).toBeNull();
  });

  it("is gated by a web project that can actually be booted and probed", () => {
    const cfg = resolveMergeGateConfig({ verifyScript: null, profile: webProfile() });
    expect(cfg.hasGate).toBe(true);
    expect(cfg.smoke?.devCommand).toBe("pnpm dev");
  });

  it("is NOT gated by isWeb when nothing can boot it — the old over-approximation", () => {
    const cfg = resolveMergeGateConfig({ verifyScript: null, profile: webProfile({ devCommand: null }) });
    expect(cfg.hasGate).toBe(false);
    expect(cfg.smoke).toBeNull();
  });

  it("is NOT gated by isWeb when there is no health URL to probe", () => {
    const cfg = resolveMergeGateConfig({
      verifyScript: null,
      profile: webProfile({ devPort: null, devHealthUrl: null }),
    });
    expect(cfg.hasGate).toBe(false);
  });

  it("counts the per-project dev_command / health_url overrides", () => {
    // A profile the board could not boot on its own, plus the overrides an operator set:
    // the gate DOES apply, and the isWeb-only derivations could not see either override.
    const cfg = resolveMergeGateConfig({
      verifyScript: null,
      profile: webProfile({ devCommand: null, devPort: null, devHealthUrl: null }),
      devCommandOverride: "make serve",
      healthUrlOverride: "http://127.0.0.1:8080/healthz",
    });
    expect(cfg.hasGate).toBe(true);
    expect(cfg.smoke?.devCommand).toBe("make serve");
    expect(cfg.smoke?.healthUrl).toBe("http://127.0.0.1:8080/healthz");
  });

  it("is not gated at all for a non-web project with no verify script", () => {
    expect(resolveMergeGateConfig({ verifyScript: null, profile: webProfile({ isWeb: false }) }).hasGate).toBe(false);
    expect(resolveMergeGateConfig({ verifyScript: null, profile: null }).hasGate).toBe(false);
  });
});

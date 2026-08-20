import { beforeEach, describe, expect, it } from "vitest";
import {
  CLI_VERSION_CONFIG,
  classifyCliVersion,
  compareSemver,
  detectCliVersion,
  detectCliVersionCached,
  parseSemver,
  resetCliVersionCache,
  warnIfCliVersionRisky,
  type CliVersionResult,
} from "../services/agent-cli-version.service.js";

describe("agent CLI version detection", () => {
  describe("parseSemver", () => {
    it("extracts a plain semver", () => {
      expect(parseSemver("1.2.3")).toBe("1.2.3");
    });
    it("extracts a semver embedded in noisy --version output", () => {
      expect(parseSemver("codex-cli 0.42.1 (build abc123)")).toBe("0.42.1");
      expect(parseSemver("claude version 2.10.0\n")).toBe("2.10.0");
    });
    it("returns null when there is no version", () => {
      expect(parseSemver("no version here")).toBeNull();
    });
  });

  describe("compareSemver", () => {
    it("orders by major, then minor, then patch", () => {
      expect(compareSemver("1.0.0", "2.0.0")).toBeLessThan(0);
      expect(compareSemver("1.2.0", "1.1.9")).toBeGreaterThan(0);
      expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
      expect(compareSemver("0.73.1", "0.70.0")).toBeGreaterThan(0);
    });
  });

  describe("detectCliVersion", () => {
    // A runner that returns a fixed version string without resolving a real binary.
    // resolveExecutable would fail for a fake path, so we pass an absolute existing
    // path is not needed — instead we point at a command guaranteed resolvable by
    // monkeypatching via the runner AND an existing path. To keep the test hermetic
    // we use a path that exists (process.execPath / node).

    it("reports below-min when the CLI is older than the supported floor", async () => {
      const result = await detectCliVersion(
        "codex",
        process.execPath,
        async () => "codex 0.1.0",
      );
      expect(result.status).toBe("below-min");
      expect(result.version).toBe("0.1.0");
      expect(result.message).toContain("below the supported minimum");
    });

    it("reports ok when the CLI is within range", async () => {
      const min = CLI_VERSION_CONFIG.codex.minSupported;
      const result = await detectCliVersion(
        "codex",
        process.execPath,
        async () => `codex ${min}`,
      );
      expect(result.status).toBe("ok");
      expect(result.version).toBe(min);
      expect(result.message).toBeNull();
    });

    it("reports unparseable when --version output has no semver", async () => {
      const result = await detectCliVersion(
        "claude",
        process.execPath,
        async () => "some banner without a version",
      );
      expect(result.status).toBe("unparseable");
      expect(result.detected).toBe(false);
    });

    it("reports unavailable when the runner throws", async () => {
      const result = await detectCliVersion(
        "claude",
        process.execPath,
        async () => { throw new Error("ENOENT spawn"); },
      );
      expect(result.status).toBe("unavailable");
      expect(result.message).toContain("Could not run");
    });

    it("reports unavailable when the command cannot be resolved on PATH", async () => {
      const result = await detectCliVersion(
        "claude",
        "definitely-not-a-real-binary-xyz",
        async () => "1.0.0",
      );
      expect(result.status).toBe("unavailable");
      expect(result.message).toContain("Could not resolve");
    });

    it("every provider ships a maxKnown ceiling, so above-known is reachable (#956)", () => {
      // Before #956 all four maxKnown values were null, which made the
      // "above-known — flags may have changed" branch dead code.
      for (const [provider, config] of Object.entries(CLI_VERSION_CONFIG)) {
        expect(config.maxKnown, `${provider} must ship a maxKnown ceiling`).not.toBeNull();
      }
    });

    it("reports above-known with the SHIPPED config when the CLI is newer than last verified", async () => {
      const result = await detectCliVersion(
        "pi",
        process.execPath,
        async () => "pi 999.0.0",
      );
      expect(result.status).toBe("above-known");
      expect(result.message).toContain("newer than the last verified version");
      expect(result.message).toContain("bump maxKnown");
    });

    it("reports ok when the version EQUALS maxKnown (inclusive last-known-good)", async () => {
      const maxKnown = CLI_VERSION_CONFIG.claude.maxKnown;
      expect(maxKnown).not.toBeNull();
      const result = await detectCliVersion(
        "claude",
        process.execPath,
        async () => `${maxKnown} (Claude Code)`,
      );
      expect(result.status).toBe("ok");
    });

    it("reports above-known when a maxKnown ceiling is set and exceeded", async () => {
      const original = CLI_VERSION_CONFIG.copilot.maxKnown;
      CLI_VERSION_CONFIG.copilot.maxKnown = "2.0.0";
      try {
        const result = await detectCliVersion(
          "copilot",
          process.execPath,
          async () => "copilot 2.5.0",
        );
        expect(result.status).toBe("above-known");
        expect(result.message).toContain("newer than the last verified version");
      } finally {
        CLI_VERSION_CONFIG.copilot.maxKnown = original;
      }
    });
  });

  describe("detectCliVersionCached (launch-path TTL cache, #956)", () => {
    beforeEach(() => resetCliVersionCache());

    it("probes once and serves subsequent calls from the cache within the TTL", async () => {
      let calls = 0;
      const runner = async () => { calls += 1; return "codex-cli 0.142.0"; };
      let now = 1_000;
      const opts = { runner, nowFn: () => now, ttlMs: 60_000 };
      const first = await detectCliVersionCached("codex", process.execPath, opts);
      now = 30_000;
      const second = await detectCliVersionCached("codex", process.execPath, opts);
      expect(calls).toBe(1);
      expect(second).toBe(first);
    });

    it("re-probes after the TTL expires", async () => {
      let calls = 0;
      const runner = async () => { calls += 1; return "codex-cli 0.142.0"; };
      let now = 1_000;
      const opts = { runner, nowFn: () => now, ttlMs: 60_000 };
      await detectCliVersionCached("codex", process.execPath, opts);
      now = 62_000;
      await detectCliVersionCached("codex", process.execPath, opts);
      expect(calls).toBe(2);
    });

    it("caches per provider:command key", async () => {
      let calls = 0;
      const runner = async () => { calls += 1; return "1.5.0"; };
      const opts = { runner, nowFn: () => 0, ttlMs: 60_000 };
      await detectCliVersionCached("claude", process.execPath, opts);
      await detectCliVersionCached("copilot", process.execPath, opts);
      expect(calls).toBe(2);
    });
  });

  describe("warnIfCliVersionRisky (launch-path warn, #956)", () => {
    beforeEach(() => resetCliVersionCache());

    it("routes an above-known CLI to the ADVISORY warn channel (not the actionable one)", async () => {
      const warnings: string[] = [];
      const errors: string[] = [];
      const actionables: string[] = [];
      const result = await warnIfCliVersionRisky("claude", process.execPath, {
        runner: async () => "999.0.0 (Claude Code)",
        warn: (message) => warnings.push(message),
        error: (message) => errors.push(message),
        onActionable: (_r, a) => actionables.push(a.level),
      });
      expect(result?.status).toBe("above-known");
      // Advisory: warn only — NOT the actionable/error path.
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("[agent-cli-version]");
      expect(warnings[0]).toContain("newer than the last verified version");
      expect(errors).toHaveLength(0);
      expect(actionables).toHaveLength(0);
    });

    it("routes a below-min CLI to the ACTIONABLE error channel + onActionable hook (ticket #20)", async () => {
      const warnings: string[] = [];
      const errors: string[] = [];
      const actionable: Array<{ result: CliVersionResult; level: string }> = [];
      const result = await warnIfCliVersionRisky("codex", process.execPath, {
        runner: async () => "codex-cli 0.1.0",
        warn: (message) => warnings.push(message),
        error: (message) => errors.push(message),
        onActionable: (r, a) => actionable.push({ result: r, level: a.level }),
      });
      expect(result?.status).toBe("below-min");
      // Distinct from the advisory case: prominent error channel, and the hook fires
      // so a caller with launch context can surface it further.
      expect(warnings).toHaveLength(0);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("ACTIONABLE");
      expect(errors[0]).toContain("below the supported minimum");
      expect(actionable).toHaveLength(1);
      expect(actionable[0].level).toBe("below-min");
      expect(actionable[0].result.status).toBe("below-min");
    });

    it("a failing onActionable hook never breaks the guard (returns the result)", async () => {
      const result = await warnIfCliVersionRisky("codex", process.execPath, {
        runner: async () => "codex-cli 0.1.0",
        error: () => {},
        onActionable: () => { throw new Error("surfacing blew up"); },
      });
      expect(result?.status).toBe("below-min");
    });

    it("stays silent (no warn/error/onActionable) for ok, unparseable, and unavailable results", async () => {
      const warnings: string[] = [];
      const errors: string[] = [];
      const actionables: string[] = [];
      const opts = {
        warn: (m: string) => warnings.push(m),
        error: (m: string) => errors.push(m),
        onActionable: (_r: CliVersionResult, a: { level: string }) => actionables.push(a.level),
      };
      const ok = await warnIfCliVersionRisky("codex", process.execPath, { ...opts, runner: async () => "codex-cli 0.142.0" });
      expect(ok?.status).toBe("ok");
      resetCliVersionCache();
      const unparseable = await warnIfCliVersionRisky("codex", process.execPath, { ...opts, runner: async () => "no semver here" });
      expect(unparseable?.status).toBe("unparseable");
      const unavailable = await warnIfCliVersionRisky("codex", "definitely-not-a-real-binary-xyz", opts);
      expect(unavailable?.status).toBe("unavailable");
      expect(warnings).toHaveLength(0);
      expect(errors).toHaveLength(0);
      expect(actionables).toHaveLength(0);
    });

    it("uses the cache — repeated launches do not re-probe", async () => {
      let calls = 0;
      const runner = async () => { calls += 1; return "codex-cli 0.142.0"; };
      await warnIfCliVersionRisky("codex", process.execPath, { runner, nowFn: () => 0 });
      await warnIfCliVersionRisky("codex", process.execPath, { runner, nowFn: () => 1 });
      expect(calls).toBe(1);
    });
  });

  describe("classifyCliVersion (actionable decision shape, ticket #20)", () => {
    const make = (status: CliVersionResult["status"], message: string | null): CliVersionResult => ({
      detected: status !== "unavailable" && status !== "unparseable",
      raw: message,
      version: status === "ok" || status === "below-min" || status === "above-known" ? "1.2.3" : null,
      status,
      message,
    });

    it("flags ONLY below-min as actionable (upgrade required)", () => {
      const a = classifyCliVersion(make("below-min", "below the supported minimum 0.20.0"));
      expect(a.level).toBe("below-min");
      expect(a.actionable).toBe(true);
      expect(a.message).toContain("below the supported minimum");
    });

    it("treats a newer-than-maxKnown CLI as its own non-actionable 'unknown-newer' state (not a failure)", () => {
      const a = classifyCliVersion(make("above-known", "newer than the last verified version"));
      expect(a.level).toBe("unknown-newer");
      expect(a.actionable).toBe(false);
    });

    it("treats an in-range CLI as ok and non-actionable", () => {
      const a = classifyCliVersion(make("ok", null));
      expect(a.level).toBe("ok");
      expect(a.actionable).toBe(false);
      expect(a.message).toBeNull();
    });

    it("maps unparseable/unavailable to a neutral advisory (no action implied)", () => {
      for (const status of ["unparseable", "unavailable"] as const) {
        const a = classifyCliVersion(make(status, "some diagnostic"));
        expect(a.level).toBe("advisory");
        expect(a.actionable).toBe(false);
      }
    });
  });

  // Maintainer audit (#956): opt-in check that the CLIs INSTALLED ON THIS MACHINE
  // are within the verified range — run with CLI_VERSION_AUDIT=1 after a CLI
  // update to know whether maxKnown needs a bump. Skipped by default (spawns
  // real binaries; not all are installed in CI).
  describe.runIf(process.env.CLI_VERSION_AUDIT === "1")("installed CLI audit (CLI_VERSION_AUDIT=1)", () => {
    for (const provider of ["claude", "codex", "copilot", "pi"] as const) {
      it(`${provider} installed version is within the verified range (else bump maxKnown)`, async () => {
        const result = await detectCliVersion(provider, provider);
        if (result.status === "unavailable") return; // not installed here
        expect(result.status, `${provider}: ${result.message ?? ""}`).toBe("ok");
      });
    }
  });
});

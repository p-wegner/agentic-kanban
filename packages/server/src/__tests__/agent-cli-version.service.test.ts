import { describe, expect, it } from "vitest";
import {
  CLI_VERSION_CONFIG,
  compareSemver,
  detectCliVersion,
  parseSemver,
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

    it("reports ok (not above-known) when the provider has no maxKnown ceiling", async () => {
      // All providers ship with maxKnown=null by default, so an arbitrarily high
      // version is in range — the check only fires on a wholesale rename/major bump.
      const result = await detectCliVersion(
        "pi",
        process.execPath,
        async () => "pi 999.0.0",
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
});

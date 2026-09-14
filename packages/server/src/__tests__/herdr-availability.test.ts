import { describe, it, expect, vi } from "vitest";
import { detectHerdrAvailability, detectHerdrAvailabilityLive } from "../services/agent-provider/herdr-availability.js";
import * as cliVersion from "../services/agent-cli-version.service.js";

/**
 * The gate that decides whether `herdr` is ever OFFERED as a selectable provider
 * (#1144). Both halves — binary on PATH, and HERDR_ENV set / a server reachable —
 * must hold; this suite covers the present and absent cases the ticket asks for.
 */
describe("detectHerdrAvailability", () => {
  it("is unavailable when the binary is not on PATH, even with HERDR_ENV set", () => {
    vi.spyOn(cliVersion, "resolveExecutable").mockReturnValue(null);
    const result = detectHerdrAvailability({ HERDR_ENV: "1" });
    expect(result.available).toBe(false);
    expect(result.binaryFound).toBe(false);
    expect(result.reason).toMatch(/not found on PATH/);
    vi.restoreAllMocks();
  });

  it("is unavailable when the binary is found but HERDR_ENV is not set", () => {
    vi.spyOn(cliVersion, "resolveExecutable").mockReturnValue("C:\\tools\\herdr.exe");
    const result = detectHerdrAvailability({});
    expect(result.available).toBe(false);
    expect(result.binaryFound).toBe(true);
    expect(result.envFlagSet).toBe(false);
    expect(result.reason).toMatch(/HERDR_ENV is not set/);
    vi.restoreAllMocks();
  });

  it("is available when the binary is found and HERDR_ENV=1", () => {
    vi.spyOn(cliVersion, "resolveExecutable").mockReturnValue("C:\\tools\\herdr.exe");
    const result = detectHerdrAvailability({ HERDR_ENV: "1" });
    expect(result.available).toBe(true);
    expect(result.binaryPath).toBe("C:\\tools\\herdr.exe");
    vi.restoreAllMocks();
  });

  it("also accepts HERDR_ENV=true", () => {
    vi.spyOn(cliVersion, "resolveExecutable").mockReturnValue("herdr");
    const result = detectHerdrAvailability({ HERDR_ENV: "true" });
    expect(result.available).toBe(true);
    vi.restoreAllMocks();
  });
});

describe("detectHerdrAvailabilityLive", () => {
  it("is unavailable when the binary is missing, and never even probes the server", async () => {
    vi.spyOn(cliVersion, "resolveExecutable").mockReturnValue(null);
    const probe = vi.fn().mockResolvedValue(true);
    const result = await detectHerdrAvailabilityLive(probe, {});
    expect(result.available).toBe(false);
    expect(probe).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("skips the probe and is available when HERDR_ENV is already set", async () => {
    vi.spyOn(cliVersion, "resolveExecutable").mockReturnValue("herdr");
    const probe = vi.fn().mockResolvedValue(false);
    const result = await detectHerdrAvailabilityLive(probe, { HERDR_ENV: "1" });
    expect(result.available).toBe(true);
    expect(probe).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("falls back to a server-reachability probe when HERDR_ENV is unset", async () => {
    vi.spyOn(cliVersion, "resolveExecutable").mockReturnValue("herdr");
    const probe = vi.fn().mockResolvedValue(true);
    const result = await detectHerdrAvailabilityLive(probe, {});
    expect(result.available).toBe(true);
    expect(result.serverReachable).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it("is unavailable when the probe resolves false", async () => {
    vi.spyOn(cliVersion, "resolveExecutable").mockReturnValue("herdr");
    const probe = vi.fn().mockResolvedValue(false);
    const result = await detectHerdrAvailabilityLive(probe, {});
    expect(result.available).toBe(false);
    vi.restoreAllMocks();
  });

  it("treats a throwing probe as unreachable rather than propagating", async () => {
    vi.spyOn(cliVersion, "resolveExecutable").mockReturnValue("herdr");
    const probe = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await detectHerdrAvailabilityLive(probe, {});
    expect(result.available).toBe(false);
    expect(result.serverReachable).toBe(false);
    vi.restoreAllMocks();
  });

  it("defaults to unreachable (env-only) when no probe is supplied", async () => {
    vi.spyOn(cliVersion, "resolveExecutable").mockReturnValue("herdr");
    const result = await detectHerdrAvailabilityLive(undefined, {});
    expect(result.available).toBe(false);
    vi.restoreAllMocks();
  });
});

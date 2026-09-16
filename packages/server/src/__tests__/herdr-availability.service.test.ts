import { describe, expect, it } from "vitest";
import { getHerdrAvailability, isForkVersion, resetHerdrAvailabilityCache } from "../services/herdr-availability.service.js";

describe("isForkVersion", () => {
  it("recognizes a fork build marker", () => {
    expect(isForkVersion("0.9.1-fork.5")).toBe(true);
  });

  it("is false for a plain upstream version", () => {
    expect(isForkVersion("0.9.0")).toBe(false);
  });

  it("is false for undefined", () => {
    expect(isForkVersion(undefined)).toBe(false);
  });
});

describe("getHerdrAvailability", () => {
  it("reports unavailable when the probe finds no herdr binary", async () => {
    resetHerdrAvailabilityCache();
    const result = await getHerdrAvailability(1000, async () => ({ available: false }));
    expect(result).toEqual({ available: false, version: undefined, isFork: false, checkedAt: 1000 });
  });

  it("reports available + version + isFork from a successful probe", async () => {
    resetHerdrAvailabilityCache();
    const result = await getHerdrAvailability(2000, async () => ({ available: true, version: "0.9.1-fork.5" }));
    expect(result).toEqual({ available: true, version: "0.9.1-fork.5", isFork: true, checkedAt: 2000 });
  });

  it("caches within the TTL window instead of re-probing", async () => {
    resetHerdrAvailabilityCache();
    let calls = 0;
    const probe = async () => {
      calls++;
      return { available: true, version: "0.9.0" };
    };
    await getHerdrAvailability(0, probe);
    const second = await getHerdrAvailability(1000, probe);
    expect(calls).toBe(1);
    expect(second.checkedAt).toBe(0);
  });

  it("re-probes once the TTL has elapsed", async () => {
    resetHerdrAvailabilityCache();
    let calls = 0;
    const probe = async () => {
      calls++;
      return { available: true, version: "0.9.0" };
    };
    await getHerdrAvailability(0, probe);
    await getHerdrAvailability(31_000, probe);
    expect(calls).toBe(2);
  });
});

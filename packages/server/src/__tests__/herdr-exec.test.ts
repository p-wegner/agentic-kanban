import { describe, expect, it } from "vitest";
import { parseHerdrVersion } from "../lib/herdr-exec.js";

describe("parseHerdrVersion", () => {
  it("extracts a plain version", () => {
    expect(parseHerdrVersion("herdr 0.9.0")).toBe("0.9.0");
  });

  it("extracts a fork version with build suffix", () => {
    expect(parseHerdrVersion("herdr 0.9.1-fork.5")).toBe("0.9.1-fork.5");
  });

  it("returns undefined for output with no version", () => {
    expect(parseHerdrVersion("not found")).toBeUndefined();
  });

  it("trims surrounding whitespace/newlines", () => {
    expect(parseHerdrVersion("  herdr 1.2.3\n")).toBe("1.2.3");
  });
});

import { describe, it, expect } from "vitest";
import { formatWindow, formatRelativeTs, toolHint, backendLabel, modelLabel } from "./butler-format.js";

describe("formatWindow", () => {
  it("formats millions and thousands", () => {
    expect(formatWindow(1_000_000)).toBe("1M");
    expect(formatWindow(1_500_000)).toBe("1.5M");
    expect(formatWindow(200_000)).toBe("200k");
    expect(formatWindow(8_000)).toBe("8k");
  });
});

describe("formatRelativeTs", () => {
  const now = 10_000_000;
  it("buckets into just now / minutes / hours", () => {
    expect(formatRelativeTs(now - 30_000, now)).toBe("just now");
    expect(formatRelativeTs(now - 5 * 60_000, now)).toBe("5m ago");
    expect(formatRelativeTs(now - 3 * 3_600_000, now)).toBe("3h ago");
  });
});

describe("toolHint", () => {
  it("returns the basename for file tools and salient args for others", () => {
    expect(toolHint("Read", { file_path: "a/b/c.ts" })).toBe("c.ts");
    expect(toolHint("Edit", { file_path: "C:\\x\\y.tsx" })).toBe("y.tsx");
    expect(toolHint("Bash", { command: "ls -la" })).toBe("ls -la");
    expect(toolHint("Grep", { pattern: "foo" })).toBe("foo");
    expect(toolHint("WebFetch", { url: "https://x" })).toBe("https://x");
  });
  it("falls back to the first short string arg, else empty", () => {
    expect(toolHint("Unknown", { note: "hi" })).toBe("hi");
    expect(toolHint("Unknown", { big: "x".repeat(200) })).toBe("");
    expect(toolHint("Read")).toBe("");
  });
});

describe("backendLabel", () => {
  it("labels known backends, defaulting to Claude", () => {
    expect(backendLabel("codex")).toBe("Codex");
    expect(backendLabel("mock")).toBe("Mock");
    expect(backendLabel(undefined)).toBe("Claude");
    expect(backendLabel("claude")).toBe("Claude");
  });
});

describe("modelLabel", () => {
  it("falls back to the raw value when unknown", () => {
    expect(modelLabel("totally-unknown-model")).toBe("totally-unknown-model");
  });
});

import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { pathKey, samePath, isPathInside, normalizeSlashes } from "../src/lib/path-key.js";

const WIN = process.platform === "win32";

describe("pathKey (#532)", () => {
  it("is stable across separator direction and trailing separators", () => {
    const base = resolve("a/b/c");
    expect(pathKey(base)).toBe(pathKey(base + "/"));
    expect(pathKey(base)).toBe(pathKey(base.replace(/\//g, "\\")));
    expect(pathKey(base)).toBe(pathKey(base + "//"));
  });

  it("resolves relative paths, so an unresolved recipe cannot disagree with a resolved one", () => {
    expect(pathKey("a/b")).toBe(pathKey(resolve("a/b")));
  });

  it("emits forward slashes only", () => {
    expect(pathKey(resolve("a\\b"))).not.toContain("\\");
  });

  it("case-folds ONLY on win32 — the bug every hand-rolled recipe shared", () => {
    const lower = resolve("srv/repo");
    const upper = resolve("srv/Repo");
    if (WIN) {
      expect(samePath(lower, upper)).toBe(true);
    } else {
      // On POSIX these are genuinely different directories; folding them is a
      // silent false positive, which is exactly what the 8 copies all did.
      expect(samePath(lower, upper)).toBe(false);
    }
  });

  it("does not collapse a root to the empty string", () => {
    expect(pathKey(resolve("/"))).not.toBe("");
  });
});

describe("isPathInside", () => {
  it("treats a path as inside itself", () => {
    expect(isPathInside(resolve("a/b"), resolve("a/b"))).toBe(true);
  });

  it("matches a real descendant", () => {
    expect(isPathInside(resolve("a/b/c/d"), resolve("a/b"))).toBe(true);
  });

  it("requires a separator at the boundary — a sibling prefix is NOT inside", () => {
    // The classic bug: "repo-2".startsWith("repo") is true.
    expect(isPathInside(resolve("srv/repo-2"), resolve("srv/repo"))).toBe(false);
  });

  it("is not fooled by a trailing separator on the parent", () => {
    expect(isPathInside(resolve("a/b/c"), resolve("a/b") + "/")).toBe(true);
  });
});

describe("normalizeSlashes", () => {
  it("is platform-free: no resolve, no case-folding", () => {
    expect(normalizeSlashes("a\\b\\c")).toBe("a/b/c");
    expect(normalizeSlashes("A/B")).toBe("A/B");
  });
});

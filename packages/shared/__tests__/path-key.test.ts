import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { pathKey, samePath, isPathInside, normalizeSlashes, rewritePathPrefix } from "../src/lib/path-key.js";

const WIN = process.platform === "win32";

describe("pathKey (#532)", () => {
  it("is stable across trailing separators", () => {
    const base = resolve("a/b/c");
    expect(pathKey(base)).toBe(pathKey(base + "/"));
    expect(pathKey(base)).toBe(pathKey(base + "//"));
  });

  // Separator direction is a WINDOWS equivalence. Off Windows a backslash is an ordinary
  // filename character, so `resolve()` reads `\a\b\c` as a single RELATIVE segment and
  // folding it onto `/a/b/c` would be a silent false positive (#828: this assertion had
  // never run off Windows, where it fails).
  it.runIf(WIN)("is stable across separator direction (win32)", () => {
    const base = resolve("a/b/c");
    expect(pathKey(base)).toBe(pathKey(base.replace(/\//g, "\\")));
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

describe("rewritePathPrefix (#964)", () => {
  it("re-roots a path from one prefix to another", () => {
    expect(rewritePathPrefix(resolve("old/app/src"), resolve("old"), resolve("new")))
      .toBe(resolve("new/app/src"));
  });

  it("re-roots the prefix itself, not only its descendants", () => {
    expect(rewritePathPrefix(resolve("old/app"), resolve("old/app"), resolve("new/app")))
      .toBe(resolve("new/app"));
  });

  it("returns null for a path outside the prefix, so callers can tell 'unaffected' from 'unchanged'", () => {
    expect(rewritePathPrefix(resolve("elsewhere/app"), resolve("old"), resolve("new"))).toBeNull();
  });

  it("does not re-root a sibling whose name merely starts the same", () => {
    // The bug a LIKE 'C:\old%' rewrite would have: old-baseline is not under old.
    expect(rewritePathPrefix(resolve("srv/repo-2/x"), resolve("srv/repo"), resolve("srv/moved"))).toBeNull();
  });

  it("preserves the separator style of the input", () => {
    // repoPath / workingDir rows hold backslash paths; forward-slashing them on rewrite
    // would still compare equal under pathKey but no longer match a raw string read.
    const out = rewritePathPrefix(String.raw`C:\old\app\src`, String.raw`C:\old`, String.raw`C:\new`);
    expect(out).toBe(WIN ? String.raw`C:\new\app\src` : null);
  });

  it("is unfazed by a trailing separator on either prefix", () => {
    expect(rewritePathPrefix(resolve("old/app"), resolve("old") + "/", resolve("new") + "/"))
      .toBe(resolve("new/app"));
  });
});

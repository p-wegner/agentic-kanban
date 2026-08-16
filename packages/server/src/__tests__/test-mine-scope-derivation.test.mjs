import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import {
  ownedChangedFiles,
  upstreamChangedFiles,
  UPSTREAM_DEPENDENCIES,
  scanAlwaysRunTests,
} from "../../../../scripts/test-mine.mjs";

/**
 * #537 leak A: a `packages/shared`-only diff expanded to server/mcp-server as downstream
 * dependents (`changed-packages.ts`), but those packages own no changed files of their own —
 * so they fell back to their full suites instead of `vitest related` against the shared file
 * that actually changed. These tests exercise the pure derivation directly (injected `files`/
 * `exists`/`root`), never spawning real vitest or touching the real filesystem.
 */
describe("ownedChangedFiles", () => {
  const exists = () => true;

  it("returns changed files under a package, relative to that package's own directory", () => {
    const files = ["packages/shared/src/lib/git-service.ts", "packages/server/src/index.ts"];
    expect(ownedChangedFiles("packages/shared", files, exists)).toEqual(["src/lib/git-service.ts"]);
  });

  it("returns an empty list when the package owns nothing in the diff", () => {
    const files = ["packages/shared/src/lib/git-service.ts"];
    expect(ownedChangedFiles("packages/server", files, exists)).toEqual([]);
  });

  it("drops a changed file that no longer exists (deleted — cannot be related)", () => {
    const files = ["packages/shared/src/lib/gone.ts", "packages/shared/src/lib/still-here.ts"];
    const selectiveExists = (p) => p.endsWith("still-here.ts");
    expect(ownedChangedFiles("packages/shared", files, selectiveExists)).toEqual(["src/lib/still-here.ts"]);
  });
});

describe("upstreamChangedFiles", () => {
  const exists = () => true;
  const root = "/repo";

  it("resolves a shared-owned change to an absolute path for server (which depends on shared)", () => {
    const files = ["packages/shared/src/lib/git-service.ts"];
    expect(upstreamChangedFiles("server", files, exists, root)).toEqual([
      resolve(root, "packages/shared", "src/lib/git-service.ts"),
    ]);
  });

  it("resolves a shared-owned change for mcp-server too — both alias @agentic-kanban/shared to shared/src", () => {
    const files = ["packages/shared/src/lib/settings-registry.ts"];
    const result = upstreamChangedFiles("mcp-server", files, exists, root);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatch(/settings-registry\.ts$/);
  });

  it("returns empty for a package with no declared upstream dependency (shared itself)", () => {
    const files = ["packages/server/src/index.ts"];
    expect(upstreamChangedFiles("shared", files, exists, root)).toEqual([]);
  });

  it("returns empty when the diff touches shared but the target package isn't a known dependent", () => {
    const files = ["packages/shared/src/lib/foo.ts"];
    expect(upstreamChangedFiles("client", files, exists, root)).toEqual([]);
  });

  it("returns empty when the diff owns no upstream files at all", () => {
    const files = ["packages/server/src/other.ts"];
    expect(upstreamChangedFiles("server", files, exists, root)).toEqual([]);
  });

  it("declares shared as the upstream dependency for both server and mcp-server", () => {
    expect(UPSTREAM_DEPENDENCIES).toEqual({
      server: ["packages/shared"],
      "mcp-server": ["packages/shared"],
    });
  });
});

/**
 * #538 — ALWAYS_RUN_TESTS used to be a hand-maintained list; it is now derived by scanning
 * each package's __tests__ dir for a `// @gate:always-run` marker. These tests exercise the
 * pure scan function directly (injected `listDir`/`readText`), never touching the real
 * filesystem.
 */
describe("scanAlwaysRunTests", () => {
  it("returns only .test.ts files whose content carries the @gate:always-run marker", () => {
    const files = {
      "src/__tests__/marked-guard.test.ts": "// @gate:always-run — scans the tree.\nimport {} from \"vitest\";",
      "src/__tests__/ordinary.test.ts": "import {} from \"vitest\";",
      "src/__tests__/helpers.ts": "// @gate:always-run — not a test file, must be ignored",
    };
    const listDir = () => Object.keys(files).map((p) => p.split("/").pop());
    const readText = (p) => files[Object.keys(files).find((k) => p.endsWith(k.split("/").pop()))];
    expect(scanAlwaysRunTests("/repo/packages/server", "src/__tests__", listDir, readText)).toEqual([
      "src/__tests__/marked-guard.test.ts",
    ]);
  });

  it("returns an empty list when the __tests__ dir doesn't exist (listDir returns nothing)", () => {
    const listDir = () => [];
    const readText = () => {
      throw new Error("must not be called when listDir is empty");
    };
    expect(scanAlwaysRunTests("/repo/packages/server", "src/__tests__", listDir, readText)).toEqual([]);
  });

  it("returns paths relative to pkgDir, prefixed with the given testsDir", () => {
    const listDir = () => ["a.test.ts"];
    const readText = () => "// @gate:always-run";
    expect(scanAlwaysRunTests("/repo/packages/shared", "__tests__", listDir, readText)).toEqual([
      "__tests__/a.test.ts",
    ]);
  });
});

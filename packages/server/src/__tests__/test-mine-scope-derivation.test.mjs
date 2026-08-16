import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { ownedChangedFiles, upstreamChangedFiles, UPSTREAM_DEPENDENCIES } from "../../../../scripts/test-mine.mjs";

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

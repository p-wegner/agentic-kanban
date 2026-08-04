import { describe, expect, it } from "vitest";
import { scopedTestPackages, testPackagesEnvValue } from "../src/lib/changed-packages.js";

/**
 * These tests are all about the FAIL-OPEN direction. Narrowing a merge gate decides which
 * tests are allowed not to run, so the dangerous bug is scoping too narrowly, never too
 * widely — every "I don't understand this path" case must come back as `null` (= run all).
 */
describe("scopedTestPackages", () => {
  it("scopes a client-only diff to client + the always-run shared suites", () => {
    // `shared` is forced in because its suites scan the whole tree (max-file-size,
    // barrel-client-safety) — a client-only diff can absolutely break those.
    expect(scopedTestPackages(["packages/client/src/lib/viewRegistry.tsx"])).toEqual(["shared", "client"]);
  });

  it("scopes a server-only diff to server + shared", () => {
    expect(scopedTestPackages(["packages/server/src/services/foo.ts"])).toEqual(["shared", "server"]);
  });

  it("unions across packages when a diff spans several", () => {
    expect(
      scopedTestPackages([
        "packages/client/src/App.tsx",
        "packages/mcp-server/src/index.ts",
      ]),
    ).toEqual(["shared", "mcp-server", "client"]);
  });

  it("refuses to scope an EMPTY diff — that is ignorance, not a small change", () => {
    expect(scopedTestPackages([])).toBeNull();
  });

  it.each([
    ["package.json"],
    ["pnpm-lock.yaml"],
    ["pnpm-workspace.yaml"],
    ["tsconfig.base.json"],
    ["vitest.workspace.ts"],
    [".dependency-cruiser.cjs"],
    ["scripts/test-mine.mjs"],
    [".github/workflows/arch-gate.yml"],
  ])("refuses to scope when the diff touches the global config %s", (file) => {
    expect(scopedTestPackages([file, "packages/client/src/App.tsx"])).toBeNull();
  });

  it("refuses to scope a path owned by no known package", () => {
    // A new top-level directory is something the map does not model.
    expect(scopedTestPackages(["docs/state.md"])).toBeNull();
    expect(scopedTestPackages(["packages/desktop/src/main.rs"])).toBeNull();
  });

  it("normalises Windows separators and ./ prefixes", () => {
    expect(scopedTestPackages(["packages\\server\\src\\index.ts"])).toEqual(["shared", "server"]);
    expect(scopedTestPackages(["./packages/server/src/index.ts"])).toEqual(["shared", "server"]);
  });

  it("returns a stable order regardless of input order", () => {
    const a = scopedTestPackages(["packages/mcp-server/x.ts", "packages/server/y.ts"]);
    const b = scopedTestPackages(["packages/server/y.ts", "packages/mcp-server/x.ts"]);
    expect(a).toEqual(b);
    expect(a).toEqual(["shared", "server", "mcp-server"]);
  });
});

describe("testPackagesEnvValue", () => {
  it("drops `client` (test:mine does not run it) but keeps the rest", () => {
    expect(testPackagesEnvValue(["packages/client/src/App.tsx"])).toBe("shared");
  });

  it("emits a comma-separated list for a multi-package diff", () => {
    expect(testPackagesEnvValue(["packages/server/a.ts", "packages/mcp-server/b.ts"])).toBe("shared,server,mcp-server");
  });

  it("returns null (run everything) when no scoping is safe", () => {
    expect(testPackagesEnvValue([])).toBeNull();
    expect(testPackagesEnvValue(["package.json"])).toBeNull();
  });
});

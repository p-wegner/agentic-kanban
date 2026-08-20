import { describe, expect, it } from "vitest";
import { scopedTestPackages, testPackagesEnvValue } from "../src/lib/changed-packages.js";

/**
 * These tests are all about the FAIL-OPEN direction. Narrowing a merge gate decides which
 * tests are allowed not to run, so the dangerous bug is scoping too narrowly, never too
 * widely — every "I don't understand this path" case must come back as `null` (= run all).
 */
describe("scopedTestPackages", () => {
  it("scopes a client-only diff to client + the always-run tree-scanning suites", () => {
    // `shared` and `server` are forced in because their suites scan the whole tree
    // (max-file-size, barrel-client-safety in shared; time-injection, windows-hide-spawn,
    // start-policy-single-source and the marker ratchet in server) — a client-only diff can
    // absolutely break those, and #647 found it was skipping every server-side one.
    expect(scopedTestPackages(["packages/client/src/lib/viewRegistry.tsx"])).toEqual(["shared", "server", "client"]);
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
    ).toEqual(["shared", "server", "mcp-server", "client"]);
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
    ["scripts/check-god-modules.mjs"],
    ["scripts/build-server.mjs"],
    ["scripts/copy-assets.mjs"],
  ])("refuses to scope when the diff touches the global config %s", (file) => {
    expect(scopedTestPackages([file, "packages/client/src/App.tsx"])).toBeNull();
  });

  /**
   * #537 leak B: `.github/**` never runs through the gate's own commands
   * (`pnpm test:mine && pnpm build`), so it must not void scoping — and most of
   * `scripts/**` (e.g. the board-monitor loop) has nothing to do with the gate either.
   */
  it("does NOT treat .github/** or an unrelated scripts/ file as a global scope breaker", () => {
    expect(scopedTestPackages([".github/workflows/arch-gate.yml", "packages/client/src/App.tsx"])).toEqual([
      "shared",
      "server",
      "client",
    ]);
    expect(scopedTestPackages(["scripts/board-monitor/loop.sh", "packages/client/src/App.tsx"])).toEqual([
      "shared",
      "server",
      "client",
    ]);
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

  /**
   * #241: scoping was OWNERSHIP-based, so a shared-only diff ran only shared's own suites —
   * dropping exactly the packages a shared change affects most. The dangerous concrete case
   * was a migration-only diff skipping the server-side migration-drift gate.
   */
  it("expands a shared-only diff DOWNSTREAM to every package that depends on shared", () => {
    expect(scopedTestPackages(["packages/shared/src/lib/git-service/merge.ts"])).toEqual([
      "shared",
      "server",
      "mcp-server",
      "client",
    ]);
  });

  it("keeps the server-side migration-drift gate in scope for a migration-only diff (#241)", () => {
    const scope = scopedTestPackages([
      "packages/shared/drizzle/0110_add_thing.sql",
      "packages/shared/drizzle/meta/_journal.json",
    ]);
    expect(scope).toContain("server");
    expect(testPackagesEnvValue([
      "packages/shared/drizzle/0110_add_thing.sql",
      "packages/shared/drizzle/meta/_journal.json",
    ])).toBe("shared,server,mcp-server,client");
  });

  it("does NOT let the ALWAYS_RUN entries expand a narrow diff to everything", () => {
    // `shared` is forced in for every diff; if downstream expansion ran after that, scoping
    // would degenerate to "run all packages" and the whole module would be pointless. The
    // #647 addition of `server` must not reintroduce that: mcp-server and client stay out.
    expect(scopedTestPackages(["packages/client/src/App.tsx"])).toEqual(["shared", "server", "client"]);
    expect(scopedTestPackages(["packages/server/src/index.ts"])).toEqual(["shared", "server"]);
    expect(scopedTestPackages(["packages/mcp-server/src/x.ts"])).toEqual(["shared", "server", "mcp-server"]);
  });

  it("returns a stable order regardless of input order", () => {
    const a = scopedTestPackages(["packages/mcp-server/x.ts", "packages/server/y.ts"]);
    const b = scopedTestPackages(["packages/server/y.ts", "packages/mcp-server/x.ts"]);
    expect(a).toEqual(b);
    expect(a).toEqual(["shared", "server", "mcp-server"]);
  });
  /**
   * #643 — the global scope-breakers were ROOT-anchored, so a PER-PACKAGE package.json or
   * vitest.config.ts scoped like an ordinary source file. A dependency bump or a vitest-config
   * change (environment, setup files, pool, timeouts) can alter how every suite behaves,
   * including suites in other packages, so it must forfeit scoping like its root equivalents.
   */
  it.each([
    ["packages/client/package.json"],
    ["packages/server/package.json"],
    ["packages/shared/vitest.config.ts"],
    ["packages/server/vitest.workspace.mts"],
    ["packages/client/tsconfig.app.json"],
  ])("refuses to scope a per-package config change: %s (#643)", (file) => {
    expect(scopedTestPackages([file])).toBeNull();
    // …and it breaks scope for the whole diff, not just its own package.
    expect(scopedTestPackages(["packages/server/src/index.ts", file])).toBeNull();
  });

  it("still scopes an ordinary source file next to those names", () => {
    expect(scopedTestPackages(["packages/client/src/package.json.ts"])).toEqual(["shared", "server", "client"]);
    expect(scopedTestPackages(["packages/server/src/config/vitest.config.helper.ts"])).toEqual(["shared", "server"]);
  });
});

describe("testPackagesEnvValue", () => {
  it("KEEPS `client` — dropping it was #639, and it nullified #601", () => {
    // The old assertion here pinned the bug: it expected "shared", i.e. a client-only diff
    // running zero client tests. Inverted deliberately, because the pin is what would have
    // made an agent "fix" the test instead of the filter.
    expect(testPackagesEnvValue(["packages/client/src/App.tsx"])).toBe("shared,server,client");
  });

  it("emits a comma-separated list for a multi-package diff", () => {
    expect(testPackagesEnvValue(["packages/server/a.ts", "packages/mcp-server/b.ts"])).toBe("shared,server,mcp-server");
  });

  it("returns null (run everything) when no scoping is safe", () => {
    expect(testPackagesEnvValue([])).toBeNull();
    expect(testPackagesEnvValue(["package.json"])).toBeNull();
  });
});

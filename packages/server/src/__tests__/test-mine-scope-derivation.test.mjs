import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import {
  ownedChangedFiles,
  upstreamChangedFiles,
  UPSTREAM_DEPENDENCIES,
  scanAlwaysRunTests,
  relatedCoverageByFile,
  uncoveredSourceFiles,
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


/**
 * #762 — the file-scoped tier's emptiness check used to be per RUN, not per FILE.
 *
 * Measured on this repo 2026-08-23: `packages/shared/src/types/api.ts` (59/59 rework, the
 * worst file in the worst module on that metric) is selected by ZERO suites in `shared` and
 * ZERO in `server`, because `vitest related` walks the TRANSFORMED module graph and a
 * type-only module is erased before that graph exists. A two-file diff of `types/api.ts` +
 * `lib/changed-packages.ts` selects exactly one suite, so #643's whole-run fallback never
 * fired and the gate passed having asserted nothing about `types/api.ts`.
 *
 * These tests pin the rule that replaced it: ANY changed source file that no suite imports
 * forces the package's full suite. They inject a fake vitest loader, so no vitest boots.
 */
const SHARED_PKG = resolve(import.meta.dirname, "../../../shared");
const abs = (rel) => resolve(SHARED_PKG, rel).split(String.fromCharCode(92)).join("/");

/** A stand-in for vitest's node API: `specs` is [testFile, [imported source files]] pairs. */
function fakeVitestLoader(specs, onDeps = () => {}) {
  return () => ({
    createVitest: async () => ({
      specifications: {
        globTestSpecifications: async () => specs.map(([moduleId]) => ({ moduleId })),
        getTestDependencies: async (spec) => {
          onDeps(spec.moduleId);
          return new Set((specs.find(([id]) => id === spec.moduleId) ?? [null, []])[1]);
        },
      },
      close: async () => {},
    }),
  });
}

describe("relatedCoverageByFile (#762)", () => {
  it("reports a changed file that no suite imports as uncovered, even when others are covered", async () => {
    const loader = fakeVitestLoader([
      [abs("__tests__/changed-packages.test.ts"), [abs("src/lib/changed-packages.ts")]],
    ]);
    const coverage = await relatedCoverageByFile(
      SHARED_PKG,
      ["src/types/api.ts", "src/lib/changed-packages.ts"],
      loader,
    );
    expect(coverage).toEqual({
      [abs("src/types/api.ts")]: false,
      [abs("src/lib/changed-packages.ts")]: true,
    });
  });

  it("counts a changed file that IS a test file as covered by itself", async () => {
    const loader = fakeVitestLoader([[abs("__tests__/a.test.ts"), []]]);
    const coverage = await relatedCoverageByFile(SHARED_PKG, ["__tests__/a.test.ts"], loader);
    expect(coverage).toEqual({ [abs("__tests__/a.test.ts")]: true });
  });

  it("stops walking dependency graphs once every changed file is accounted for", async () => {
    const walked = [];
    const loader = fakeVitestLoader(
      [
        [abs("__tests__/one.test.ts"), [abs("src/lib/a.ts")]],
        [abs("__tests__/two.test.ts"), [abs("src/lib/a.ts")]],
        [abs("__tests__/three.test.ts"), [abs("src/lib/a.ts")]],
      ],
      (id) => walked.push(id),
    );
    await relatedCoverageByFile(SHARED_PKG, ["src/lib/a.ts"], loader);
    expect(walked).toEqual([abs("__tests__/one.test.ts")]);
  });

  it("fails OPEN — a probe that throws returns null, never a narrower gate", async () => {
    const loader = () => {
      throw new Error("vitest is not installed here");
    };
    expect(await relatedCoverageByFile(SHARED_PKG, ["src/lib/a.ts"], loader)).toBeNull();
  });

  it("returns an empty map (not null) when there is nothing to check", async () => {
    const loader = () => {
      throw new Error("must not boot vitest for an empty file list");
    };
    expect(await relatedCoverageByFile(SHARED_PKG, [], loader)).toEqual({});
  });
});

describe("uncoveredSourceFiles (#762)", () => {
  it("names the uncovered SOURCE files — those are what a file-scoped green would not assert", () => {
    expect(
      uncoveredSourceFiles({
        "/repo/packages/shared/src/types/api.ts": false,
        "/repo/packages/shared/src/lib/git-service.ts": true,
      }),
    ).toEqual(["/repo/packages/shared/src/types/api.ts"]);
  });

  it("ignores a non-source file — a .sql or .json selecting nothing is expected, not a hole", () => {
    expect(
      uncoveredSourceFiles({
        "/repo/packages/shared/drizzle/0123_thing.sql": false,
        "/repo/packages/shared/package-lock.json": false,
      }),
    ).toEqual([]);
  });

  it("propagates an undetermined probe as undetermined — null in, null out", () => {
    expect(uncoveredSourceFiles(null)).toBeNull();
  });

  it("returns an empty list when every changed source file is covered", () => {
    expect(uncoveredSourceFiles({ "/repo/a.ts": true, "/repo/b.tsx": true })).toEqual([]);
  });
});

// @gate:always-run when:scripts/test-mine.mjs,scripts/machine-verify-lock.mjs - exercises the scope derivation in `scripts/test-mine.mjs`, a repo script
// outside this suite's own import graph. Before #891 it was force-run only because its
// FIXTURE TEXT quotes the marker - text whose whole purpose is to assert the scanner ignores
// a non-test file that carries it.
import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  ownedChangedFiles,
  upstreamChangedFiles,
  UPSTREAM_DEPENDENCIES,
  scanAlwaysRunTests,
  relatedCoverageByFile,
  uncoveredSourceFiles,
  planPackageScope,
  PACKAGES,
  ALWAYS_RUN_TESTS_DIR,
} from "../../../../scripts/test-mine.mjs";

// Exercise the real command entrypoint and its spawned argv in an isolated miniature repo.
// Vitest alone is replaced with a recorder; no package suite or machine-wide lock is started.
function recordedRunner(changedFiles, guardsOnly = false) {
  const root = mkdtempSync(resolve(tmpdir(), "kanban-test-mine-plan-"));
  try {
    mkdirSync(resolve(root, "scripts"));
    copyFileSync(resolve(import.meta.dirname, "../../../../scripts/test-mine.mjs"), resolve(root, "scripts/test-mine.mjs"));
    writeFileSync(resolve(root, "scripts/machine-verify-lock.mjs"),
      "export const MACHINE_LOCK_HEARTBEAT_INTERVAL_MS=1000; export async function acquireForBuilderTest(){return {handle:null};}\n");
    const log = resolve(root, "argv.jsonl");
    for (const pkg of PACKAGES) {
      const dir = resolve(root, pkg.dir, ALWAYS_RUN_TESTS_DIR[pkg.label]);
      mkdirSync(dir, { recursive: true });
      writeFileSync(resolve(dir, "bare.test.ts"), "// @gate:always-run\n");
      writeFileSync(resolve(dir, "conditional.test.ts"), `// @gate:always-run when:${pkg.dir}/src/**\n`);
      const vitest = resolve(root, pkg.dir, "node_modules/vitest");
      mkdirSync(vitest, { recursive: true });
      writeFileSync(resolve(vitest, "vitest.mjs"),
        "import {appendFileSync} from 'node:fs'; appendFileSync(process.env.TEST_MINE_ARGV_LOG, JSON.stringify({cwd:process.cwd(),argv:process.argv.slice(2)})+'\\n');\n");
    }
    mkdirSync(resolve(root, "packages/client/src"), { recursive: true });
    writeFileSync(resolve(root, "packages/client/src/App.tsx"), "export {};\n");
    const result = spawnSync(process.execPath, [resolve(root, "scripts/test-mine.mjs")], {
      cwd: root, encoding: "utf8", windowsHide: true, timeout: 30_000,
      env: { ...process.env, TEST_MINE_ARGV_LOG: log, KANBAN_TEST_PACKAGES: "shared,server,client",
        KANBAN_TEST_FILES: changedFiles.join(","), KANBAN_TEST_GUARDS_ONLY: guardsOnly ? "1" : "",
        KANBAN_RETRY_TEST_FILES: "", KANBAN_TEST_SELECTOR: "", KANBAN_TEST_GUARDS: "", KANBAN_TEST_MAX_WORKERS: "1",
        KANBAN_TEST_NO_COVERAGE_PROBE: "1", KANBAN_TEST_HERMETIC: "", KANBAN_MACHINE_VERIFY_LOCK: "" },
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    return readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("runner execution argv", () => {
  it("a client diff executes only applicable guards in shared/server, never their full suites", () => {
    const calls = recordedRunner(["packages/client/src/App.tsx"]);
    for (const label of ["shared", "server"]) {
      const own = calls.filter((c) => c.cwd.endsWith(label));
      expect(own).toHaveLength(1);
      expect(own[0].argv[0]).toBe("run");
      expect(own[0].argv[1]).toMatch(/bare\.test\.ts$/);
      expect(own[0].argv.some((a) => a.includes("conditional.test"))).toBe(false);
    }
    expect(calls.some((c) => c.cwd.endsWith("client") && c.argv[0] === "related")).toBe(true);
  });
  it("a known docs diff narrows the guards-only entrypoint in every package", () => {
    const calls = recordedRunner(["docs/a.md"], true);
    expect(calls).toHaveLength(PACKAGES.length);
    expect(calls.every((c) => c.argv[1].endsWith("bare.test.ts"))).toBe(true);
    expect(calls.some((c) => c.argv.some((a) => a.includes("conditional.test")))).toBe(false);
  });
  it("a deleted affected input still spawns the affected package's full suite", () => {
    const calls = recordedRunner(["packages/server/src/deleted.ts"]);
    const server = calls.filter((c) => c.cwd.endsWith("server"));
    expect(server).toHaveLength(1);
    expect(server[0].argv.slice(0, 2)).toEqual(["run", "--exclude"]);
  });
});

describe("package execution scope", () => {
  const server = { label: "server", dir: "packages/server" };
  const shared = { label: "shared", dir: "packages/shared" };
  const exists = () => true;
  it("runs only guards in unrelated packages included for their tree checks", () => {
    expect(planPackageScope(shared, ["packages/server/src/a.ts"], exists).kind).toBe("guards");
    expect(planPackageScope(server, ["packages/client/src/App.tsx"], exists).kind).toBe("guards");
  });
  it("keeps deleted affected input visible, even beside another surviving change", () => {
    const files = ["packages/server/src/gone.ts", "packages/server/src/a.ts"];
    expect(planPackageScope(server, files, (f) => !f.endsWith("gone.ts")).kind).toBe("full");
    expect(planPackageScope(server, ["packages/shared/src/gone.ts"], () => false).kind).toBe("full");
  });
  it.each([[], ["tsconfig.base.json"], ["scripts/test-mine.mjs"], ["packages/client/vitest.config.ts"]])(
    "fails open for unknown scope or global configuration: %j", (...files) => {
      // Each table entry is a complete change list.
      expect(planPackageScope(server, files, exists).kind).toBe("full");
    },
  );
  it("relates both own and upstream input in a mixed diff", () => {
    const plan = planPackageScope(server, ["packages/server/src/a.ts", "packages/shared/src/b.ts"], exists);
    expect(plan.kind).toBe("related");
    expect(plan.files).toHaveLength(2);
    expect(plan.files[0]).toBe("src/a.ts");
    expect(plan.files[1]).toMatch(/shared[/\\]src[/\\]b.ts$/);
  });
  it("keeps the full fallback for shared input the client cannot relate", () => {
    expect(planPackageScope({ label: "client", dir: "packages/client" }, ["packages/shared/src/a.ts"], exists).kind).toBe("full");
  });
});

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

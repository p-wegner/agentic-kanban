// @gate:always-run when:scripts/test-mine.mjs,scripts/machine-verify-lock.mjs — exercises the
// `KANBAN_TEST_GUARDS=intersecting` guard filtering in `scripts/test-mine.mjs`, a repo script
// outside this suite's own import graph (the same shape as `test-mine-scope-derivation` beside it).
/**
 * #1232 — under the `iterate` posture a merge paid the whole unconditional `@gate:always-run`
 * floor (measured 2026-09-24: ~118s of tests for a 3-file client change whose impact selection was
 * ~2 files). `KANBAN_TEST_GUARDS=intersecting` runs only the guards whose declared `when:`
 * territory the diff intersects and defers every bare / `always` marker to the base sweep, which
 * sets nothing and so still runs everything. This holds the three rules that make that honest:
 *
 *   1. `all` (the default) is byte-for-byte today's behaviour.
 *   2. An UNKNOWN change set still forces every guard under `intersecting`.
 *   3. What was deferred is SAID, in the runner's own log line.
 */
import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  parseGuardsMode,
  guardForcedForRun,
  parseAlwaysRunMarker,
  scanAlwaysRunGuards,
  alwaysRunFloor,
  PACKAGES,
  ALWAYS_RUN_TESTS_DIR,
} from "../../../../scripts/test-mine.mjs";

describe("parseGuardsMode", () => {
  it("defaults to `all` and accepts the two spellings case-insensitively", () => {
    expect(parseGuardsMode(undefined, () => {})).toBe("all");
    expect(parseGuardsMode("", () => {})).toBe("all");
    expect(parseGuardsMode("all", () => {})).toBe("all");
    expect(parseGuardsMode("intersecting", () => {})).toBe("intersecting");
    expect(parseGuardsMode(" Intersecting ", () => {})).toBe("intersecting");
  });

  it("falls back to `all` on an unknown value, loudly — the fail-open direction", () => {
    const warnings = [];
    expect(parseGuardsMode("some", (m) => warnings.push(m))).toBe("all");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/KANBAN_TEST_GUARDS="some"/);
  });
});

describe("the explicit `always` spelling (#1232)", () => {
  it("parses as unconditional AND as reviewed", () => {
    expect(parseAlwaysRunMarker("// @gate:always-run always — walks every package's src tree\n")).toEqual({ when: [], always: true });
    expect(parseAlwaysRunMarker("// @gate:always-run always\n")).toEqual({ when: [], always: true });
  });

  it("a bare marker is unconditional but NOT reviewed; a `when:` marker is neither", () => {
    expect(parseAlwaysRunMarker("// @gate:always-run — reads the tree\n")).toEqual({ when: [] });
    expect(parseAlwaysRunMarker("// @gate:always-run when:docs/** — always the docs\n")).toEqual({ when: ["docs/**"] });
  });

  it("the token must sit right after the marker — a rationale mentioning `always` is not the spelling", () => {
    expect(parseAlwaysRunMarker("// @gate:always-run — this always reads the tree\n")).toEqual({ when: [] });
    expect(parseAlwaysRunMarker("// @gate:always-run always-ish\n")).toEqual({ when: [] });
  });

  it("scanAlwaysRunGuards reports the spelling per guard", () => {
    const files = {
      "src/__tests__/bare.test.ts": "// @gate:always-run\n",
      "src/__tests__/always.test.ts": "// @gate:always-run always — tree scanner\n",
      "src/__tests__/scoped.test.ts": "// @gate:always-run when:packages/x/src/**\n",
    };
    const listDir = (d) => Object.keys(files)
      .filter((f) => resolve("/pkg", f.replace(/\/[^/]+$/, "")) === resolve(d))
      .map((f) => ({ name: f.split("/").pop(), isDirectory: () => false }));
    const readText = (p) => files[p.replace(/\\/g, "/").replace(/^.*\/pkg\//, "")];
    const guards = scanAlwaysRunGuards("/pkg", "src/__tests__", listDir, readText);
    expect(guards.map((g) => [g.file.replace(/^.*\//, ""), g.when, g.always])).toEqual([
      ["bare.test.ts", [], false],
      ["always.test.ts", [], true],
      ["scoped.test.ts", ["packages/x/src/**"], false],
    ]);
  });
});

describe("guardForcedForRun", () => {
  const bare = { when: [], always: false };
  const always = { when: [], always: true };
  const scoped = { when: ["packages/server/src/routes/**"], always: false };
  const inTerritory = ["packages/server/src/routes/issues.ts"];
  const outside = ["packages/client/src/App.tsx"];

  it("`all` is exactly today's rule: bare/always always, `when:` by intersection, unknown forces everything", () => {
    for (const changed of [[], inTerritory, outside]) {
      expect(guardForcedForRun(bare, changed, "all")).toBe(true);
      expect(guardForcedForRun(always, changed, "all")).toBe(true);
    }
    expect(guardForcedForRun(scoped, inTerritory, "all")).toBe(true);
    expect(guardForcedForRun(scoped, outside, "all")).toBe(false);
    expect(guardForcedForRun(scoped, [], "all")).toBe(true);
  });

  it("`intersecting` defers bare and `always` markers and keeps only an intersecting `when:`", () => {
    expect(guardForcedForRun(bare, inTerritory, "intersecting")).toBe(false);
    expect(guardForcedForRun(always, inTerritory, "intersecting")).toBe(false);
    expect(guardForcedForRun(scoped, inTerritory, "intersecting")).toBe(true);
    expect(guardForcedForRun(scoped, outside, "intersecting")).toBe(false);
  });

  it("`intersecting` on an UNKNOWN change set forces every guard — never narrows on a diff it cannot see", () => {
    expect(guardForcedForRun(bare, [], "intersecting")).toBe(true);
    expect(guardForcedForRun(always, [], "intersecting")).toBe(true);
    expect(guardForcedForRun(scoped, [], "intersecting")).toBe(true);
  });
});

describe("alwaysRunFloor under `guards: intersecting`", () => {
  it("counts only the intersecting `when:` guards for a change set, and everything for none", () => {
    const root = mkdtempSync(resolve(tmpdir(), "kanban-guards-floor-"));
    try {
      const dir = resolve(root, "packages/server/src/__tests__");
      mkdirSync(dir, { recursive: true });
      writeFileSync(resolve(dir, "bare.test.ts"), "// @gate:always-run\n");
      writeFileSync(resolve(dir, "always.test.ts"), "// @gate:always-run always — tree\n");
      writeFileSync(resolve(dir, "routes.test.ts"), "// @gate:always-run when:packages/server/src/routes/**\n");
      writeFileSync(resolve(dir, "docs.test.ts"), "// @gate:always-run when:docs/**\n");
      const pkgs = [{ dir: "packages/server", label: "server" }];
      const files = (opts) => alwaysRunFloor({ root, packages: pkgs, ...opts }).files.map((f) => f.file.split("/").pop()).sort();
      expect(files({ changedFiles: ["packages/server/src/routes/a.ts"], guards: "intersecting" })).toEqual(["routes.test.ts"]);
      expect(files({ changedFiles: ["packages/server/src/routes/a.ts"], guards: "all" })).toEqual(["always.test.ts", "bare.test.ts", "routes.test.ts"]);
      expect(files({ changedFiles: [], guards: "intersecting" })).toEqual(["always.test.ts", "bare.test.ts", "docs.test.ts", "routes.test.ts"]);
      expect(files({ changedFiles: ["README.md"], guards: "intersecting" })).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * The real command entrypoint in an isolated miniature repo, vitest replaced by an argv recorder —
 * the harness `test-mine-scope-derivation.test.mjs` uses, with the guards mode as a parameter and
 * the runner's stdout returned so the disclosure line can be asserted.
 */
function recordedRunner({ changedFiles, guards, guardsOnly = false }) {
  const root = mkdtempSync(resolve(tmpdir(), "kanban-test-mine-guards-"));
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
      writeFileSync(resolve(dir, "always.test.ts"), "// @gate:always-run always — tree scanner\n");
      writeFileSync(resolve(dir, "conditional.test.ts"), `// @gate:always-run when:${pkg.dir}/src/**\n`);
      writeFileSync(resolve(dir, "docs.test.ts"), "// @gate:always-run when:docs/**\n");
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
        KANBAN_TEST_GUARDS: guards ?? "", KANBAN_RETRY_TEST_FILES: "", KANBAN_TEST_SELECTOR: "",
        KANBAN_TEST_MAX_WORKERS: "1", KANBAN_TEST_NO_COVERAGE_PROBE: "1", KANBAN_TEST_HERMETIC: "",
        KANBAN_MACHINE_VERIFY_LOCK: "" },
    });
    const calls = existsSync(log)
      ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
      : [];
    return { calls, status: result.status, stdout: result.stdout, stderr: result.stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** The suite basenames a package's `vitest run` was handed, flags (and `--exclude`'s value) dropped. */
const guardArgs = (calls, label) =>
  // Basename match: `endsWith("server")` would also take `mcp-server`'s calls.
  calls.filter((c) => c.cwd.split(/[\\/]/).pop() === label && c.argv[0] === "run").flatMap((c) => {
    const out = [];
    for (let i = 1; i < c.argv.length; i++) {
      if (c.argv[i] === "--exclude") { i++; continue; }
      if (c.argv[i].startsWith("--")) continue;
      out.push(c.argv[i].split(/[\\/]/).pop());
    }
    return out;
  });

describe("runner execution under KANBAN_TEST_GUARDS", () => {
  it("`all` (unset) forces the bare and `always` markers in every package for a client diff", () => {
    const { calls, status, stdout, stderr } = recordedRunner({ changedFiles: ["packages/client/src/App.tsx"] });
    expect(status, `${stdout}\n${stderr}`).toBe(0);
    for (const label of ["shared", "server"]) {
      expect(guardArgs(calls, label).sort()).toEqual(["always.test.ts", "bare.test.ts"]);
    }
    expect(stdout).not.toMatch(/deferred to the base sweep/);
  });

  it("`intersecting` runs only the client's own territory guard, defers the rest, and says so", () => {
    const { calls, status, stdout, stderr } = recordedRunner({ changedFiles: ["packages/client/src/App.tsx"], guards: "intersecting" });
    expect(status, `${stdout}\n${stderr}`).toBe(0);
    // shared/server: no guard forced at all — bare + always are deferred, conditional/docs miss.
    expect(guardArgs(calls, "shared")).toEqual([]);
    expect(guardArgs(calls, "server")).toEqual([]);
    // client: the related selection still runs, plus the one guard whose territory the diff hit.
    expect(calls.some((c) => c.cwd.endsWith("client") && c.argv[0] === "related")).toBe(true);
    expect(guardArgs(calls, "client")).toEqual(["conditional.test.ts"]);
    // 3 packages x 4 markers = 12; 1 intersecting; 3 x 2 bare/always = 6 deferred.
    expect(stdout).toMatch(/\[test:mine\] guards: 1 intersecting of 12 \(6 bare markers deferred to the base sweep\)/);
  });

  it("`intersecting` with an UNKNOWN change set forces every guard and says nothing was deferred", () => {
    const { calls, status, stdout, stderr } = recordedRunner({ changedFiles: [], guards: "intersecting" });
    expect(status, `${stdout}\n${stderr}`).toBe(0);
    expect(stdout).toMatch(/change set is UNKNOWN/);
    expect(stdout).not.toMatch(/deferred to the base sweep\)/);
    // With no file scope every package falls through to its full suite, which already contains
    // every guard — so no separate `run <guard>` spawn is expected, and none must be dropped.
    for (const label of ["shared", "server", "client"]) {
      expect(calls.some((c) => c.cwd.endsWith(label))).toBe(true);
    }
  });

  it("a guards-only docs diff under `intersecting` runs the docs-territory guards only, exit 0", () => {
    const { calls, status, stdout, stderr } = recordedRunner({ changedFiles: ["docs/a.md"], guards: "intersecting", guardsOnly: true });
    expect(status, `${stdout}\n${stderr}`).toBe(0);
    // Guards-only ignores KANBAN_TEST_PACKAGES (it runs every package's guards), so the
    // denominator is all four packages x 4 markers here, not the three-package 12 above.
    for (const pkg of PACKAGES) {
      expect(guardArgs(calls, pkg.label)).toEqual(["docs.test.ts"]);
    }
    expect(stdout).toMatch(/guards: 4 intersecting of 16 \(8 bare markers deferred to the base sweep\)/);
  });

  it("a guards-only diff under `intersecting` that intersects NO territory exits 0 and names what it left", () => {
    const { calls, status, stdout, stderr } = recordedRunner({ changedFiles: ["README.md"], guards: "intersecting", guardsOnly: true });
    expect(status, `${stdout}\n${stderr}`).toBe(0);
    expect(calls).toEqual([]);
    // 4 packages x (conditional + docs) = 8 `when:` guards outside a README diff's territory.
    expect(stdout).toMatch(/forces no suite for this diff — 8 deferred to the base sweep, 8 outside their territory/);
  });

  it("an unknown value warns and runs as `all`", () => {
    const { calls, status, stderr } = recordedRunner({ changedFiles: ["packages/client/src/App.tsx"], guards: "some" });
    expect(status).toBe(0);
    expect(stderr).toMatch(/unknown KANBAN_TEST_GUARDS="some"/);
    expect(guardArgs(calls, "server").sort()).toEqual(["always.test.ts", "bare.test.ts"]);
  });
});

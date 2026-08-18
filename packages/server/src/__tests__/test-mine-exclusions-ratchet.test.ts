// @gate:always-run
/**
 * #641 — the flaky-exclusion list had no counter-pressure, and #640 — nothing ran what it hid.
 *
 * The `test:mine` exclusion list went 0 → 12 → 17 globs between 2026-07-02 and 2026-08-03 and
 * never shrank. Every addition was a one-line commit by the agent whose gate it unblocked; no
 * test asserted anything about the list, the purpose-built `flaky_tests` registry was empty,
 * and the doc it told readers to sync with (CLAUDE.md's "Known Flaky Test Suites" table) had
 * been deleted. The exclusion even leaked INTO the guard mechanism —
 * `always-run-marker-ratchet.test.ts` grandfathers `cli*.test.ts` BECAUSE they are excluded,
 * which is circular.
 *
 * This is the counter-pressure. It does not forbid exclusions; it makes each one an explicit,
 * reviewed edit to a baseline that a reader can diff, and it fails when an exclusion outlives
 * the file it excludes. A shrinking list needs an edit too — that is the point: someone has to
 * notice.
 *
 * Reads the repo tree (a script and its target files, outside this suite's import graph),
 * hence the marker.
 */
import { describe, it, expect } from "vitest";
import { resolve, join } from "node:path";
import { readdirSync } from "node:fs";
import { PACKAGES } from "../../../../scripts/test-mine.mjs";

const REPO_ROOT = resolve(__dirname, "../../../..");

/**
 * The exclusions as of the #641 ratchet, per package. Changing `test:mine`'s list REQUIRES
 * changing this — that is the whole mechanism. When you add one, say here why and name a real
 * ticket; when a flake is fixed, delete it from both.
 */
const BASELINE: Record<string, string[]> = {
  shared: [
    "**/git-service.integration.test.ts",
    "**/append-only-hotfile-merge.integration.test.ts",
    "**/migration-renumber-conflict-guard.test.ts",
  ],
  server: [
    "**/cli.test.ts",
    "**/cli-butler.test.ts",
    "**/git.service.test.ts",
    "**/done-unmerged-invariant-scanner.test.ts",
    "**/workspace-merge-service.test.ts",
    "**/workspace-already-merged.test.ts",
    "**/api-workspace.test.ts",
    "**/workspace-lifecycle-transitions.test.ts",
    "**/merge-endpoint-reconcile-noop.test.ts",
    "**/merge-service-edge-cases.test.ts",
    "**/preferences.test.ts",
    "**/auto-review-pref.test.ts",
    "**/worker-git-transport-e2e.test.ts",
    "**/compose-lifecycle-real-docker.test.ts",
  ],
  "mcp-server": ["**/mcp-tools.test.ts"],
  client: [],
};

/** Total at the moment the ratchet landed — the number an unreviewed growth would move. */
const BASELINE_TOTAL = Object.values(BASELINE).reduce((n, list) => n + list.length, 0);

type Pkg = { dir: string; label: string; exclude: string[] };
const packages = PACKAGES as Pkg[];

/** `**\/foo.test.ts` → `foo.test.ts`. Every exclusion in this repo is that one shape. */
function basenameOf(glob: string): string | null {
  const m = glob.match(/^\*\*\/([^/*]+)$/);
  return m ? m[1] : null;
}

/** Every `*.test.ts` filename anywhere under a package dir. */
function testFileNames(pkgDir: string): Set<string> {
  const found = new Set<string>();
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
      if (e.isDirectory()) walk(join(dir, e.name));
      else if (e.name.endsWith(".test.ts")) found.add(e.name);
    }
  };
  walk(pkgDir);
  return found;
}

describe("test:mine flaky-exclusion ratchet (#641)", () => {
  it("matches the reviewed baseline exactly — growth is an explicit edit, not a side effect", () => {
    const actual = Object.fromEntries(packages.map((p) => [p.label, [...p.exclude]]));
    expect(actual).toEqual(BASELINE);
  });

  it("never grows past the baseline count without this number moving too", () => {
    const total = packages.reduce((n, p) => n + p.exclude.length, 0);
    expect(total).toBeLessThanOrEqual(BASELINE_TOTAL);
  });

  it("has no exclusion that outlived its file — a stale glob hides nothing and misleads", () => {
    for (const pkg of packages) {
      const names = testFileNames(resolve(REPO_ROOT, pkg.dir));
      for (const glob of pkg.exclude) {
        const base = basenameOf(glob);
        expect(base, `${pkg.label}: unexpected exclusion shape "${glob}" — expected "**/<file>.test.ts"`).toBeTruthy();
        expect(names.has(base!), `${pkg.label}: excludes "${base}" but no such test file exists any more`).toBe(true);
      }
    }
  });

  it("excludes only files, never a directory or a wildcard that could swallow future suites", () => {
    for (const pkg of packages) {
      for (const glob of pkg.exclude) {
        expect(glob.endsWith(".test.ts"), `${pkg.label}: "${glob}" is not a single test file`).toBe(true);
        // `**/foo*.test.ts` would silently absorb a suite nobody triaged.
        expect(glob.slice(3).includes("*"), `${pkg.label}: "${glob}" wildcards beyond the leading **/`).toBe(false);
      }
    }
  });

  it("every excluded suite is reachable by `pnpm test:full` (#640: it was reachable by nothing)", async () => {
    const { readFileSync } = await import("node:fs");
    const rootPkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const full = rootPkg.scripts["test:full"];
    expect(full, "root package.json has no test:full script").toBeTruthy();
    for (const pkg of packages) {
      if (pkg.exclude.length === 0) continue;
      const name = JSON.parse(readFileSync(join(REPO_ROOT, pkg.dir, "package.json"), "utf8")) as {
        name: string;
        scripts?: Record<string, string>;
      };
      // The package must be named by test:full AND actually have a `test` script to run —
      // `packages/shared` had neither, so three of its exclusions ran nowhere at all.
      expect(full, `test:full does not reach ${name.name}`).toContain(name.name);
      expect(name.scripts?.test, `${name.name} has no \`test\` script for test:full to invoke`).toBeTruthy();
    }
  });
});

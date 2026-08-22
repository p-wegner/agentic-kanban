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
  // #679 removed seven of these thirteen. They ran on in-memory SQLite with an injected
  // gitService and had no environmental excuse; `helpers/temp-repo.ts` only mkdirs a `.git`
  // so the repo lock accepts the path, and deliberately never runs `git init`. Measured
  // together: 193 tests, ~78s. This shrink is exactly the explicit, reviewed edit the
  // mechanism above exists to force — the list moving in the good direction still needs
  // someone to notice.
  server: [
    "**/cli.test.ts",
    "**/cli-butler.test.ts",
    "**/git.service.test.ts",
    "**/api-workspace.test.ts",
    "**/worker-git-transport-e2e.test.ts",
    "**/compose-lifecycle-real-docker.test.ts",
  ],
  "mcp-server": ["**/mcp-tools.test.ts"],
  client: [],
};

/**
 * A HARD CEILING on how many suites `test:mine` may skip, across all packages — written as a
 * literal on purpose (#721).
 *
 * It used to be `Object.values(BASELINE).reduce(...)`, which made the assertion below
 * tautological: the test above already asserts the live list deep-equals `BASELINE`, so a
 * total derived FROM `BASELINE` could never disagree with it. It was a dead assertion
 * presented as a second line of defence.
 *
 * As a literal it is a genuinely independent check, because it does not move when `BASELINE`
 * does: adding an exclusion to both the script and `BASELINE` — the edit the mechanism above
 * is designed to make visible, and which a reviewer can wave through as "one more line" —
 * still fails here until someone raises a number that has only ever been lowered. Lower it
 * whenever the list shrinks; think hard before raising it.
 */
const MAX_EXCLUSIONS = 10;

/**
 * #679 made each entry `{ glob, reason }` so an exclusion carries the argument for its own
 * existence — the comment form drifted away from the entries it described, which is how six
 * unjustified exclusions survived. This ratchet still reasons about the GLOBS; the reasons
 * get their own assertion at the bottom.
 */
type Exclusion = { glob: string; reason: string };
type Pkg = { dir: string; label: string; exclude: Exclusion[] };
const packages = PACKAGES as Pkg[];
const globsOf = (pkg: Pkg): string[] => pkg.exclude.map((e) => e.glob);

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
    const actual = Object.fromEntries(packages.map((p) => [p.label, globsOf(p)]));
    expect(actual).toEqual(BASELINE);
  });

  it("never skips more suites than the standing ceiling, whatever the baseline says", () => {
    const total = packages.reduce((n, p) => n + p.exclude.length, 0);
    expect(
      total,
      `test:mine skips ${total} suites; the ceiling is ${MAX_EXCLUSIONS}. This is deliberately ` +
        "NOT derived from BASELINE — updating both the script and BASELINE does not buy a pass here.",
    ).toBeLessThanOrEqual(MAX_EXCLUSIONS);
    // And the other direction, so the ceiling cannot quietly become a budget.
    expect(
      MAX_EXCLUSIONS - total,
      `the exclusion list has shrunk to ${total} — lower MAX_EXCLUSIONS to match`,
    ).toBe(0);
  });

  it("has no exclusion that outlived its file — a stale glob hides nothing and misleads", () => {
    for (const pkg of packages) {
      const names = testFileNames(resolve(REPO_ROOT, pkg.dir));
      for (const glob of globsOf(pkg)) {
        const base = basenameOf(glob);
        expect(base, `${pkg.label}: unexpected exclusion shape "${glob}" — expected "**/<file>.test.ts"`).toBeTruthy();
        expect(names.has(base!), `${pkg.label}: excludes "${base}" but no such test file exists any more`).toBe(true);
      }
    }
  });

  it("excludes only files, never a directory or a wildcard that could swallow future suites", () => {
    for (const pkg of packages) {
      for (const glob of globsOf(pkg)) {
        expect(glob.endsWith(".test.ts"), `${pkg.label}: "${glob}" is not a single test file`).toBe(true);
        // `**/foo*.test.ts` would silently absorb a suite nobody triaged.
        expect(glob.slice(3).includes("*"), `${pkg.label}: "${glob}" wildcards beyond the leading **/`).toBe(false);
      }
    }
  });

  // #679. The baseline above makes a change VISIBLE; these make it ARGUED. Six of the seven
  // suites removed in #679 were excluded with no environmental excuse at all, and the reader
  // could not tell — the justification lived in a comment above the list, which drifted away
  // from the entries it was written for. The rule the reasons are judged against: an exclusion
  // is legitimate when the suite needs something the gate box may not have or cannot share
  // under parallelism. "It is slow" is not a reason; scope it or speed it up.
  it("gives every excluded glob a reason that says something", () => {
    const missing = packages.flatMap((p) =>
      p.exclude.filter((e) => !e.reason || e.reason.trim().length < 15).map((e) => `${p.label}: ${e.glob}`),
    );
    expect(
      missing,
      "An exclusion is a hole in the pre-merge gate. Say what the suite needs that the gate box " +
        "may not have — not that it is slow.",
    ).toEqual([]);
  });

  it("rejects a reason that names no environmental need", () => {
    // Words naming a resource the gate box may not have or cannot share. A reason containing
    // none of them is asserting nothing checkable — most likely "slow", the case this rejects.
    const ENVIRONMENTAL = ["git", "docker", "daemon", "spawn", "child process", "binary", "transport", "parallelism"];
    const unjustified = packages.flatMap((p) =>
      p.exclude
        .filter((e) => !ENVIRONMENTAL.some((w) => e.reason.toLowerCase().includes(w)))
        .map((e) => `${p.label}: ${e.glob} — "${e.reason}"`),
    );
    expect(
      unjustified,
      "These exclusions give a reason naming no real git/docker/spawned-process need.",
    ).toEqual([]);
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

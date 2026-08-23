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
import { readdirSync, readFileSync } from "node:fs";
// @ts-expect-error — `scripts/` is plain .mjs with no type declarations and is not part
// of any package tsconfig, so this import is implicitly `any`. Suppressed rather than
// typed because the suite's whole point is to read the REAL script the runner uses; a
// hand-written .d.ts beside it would be one more thing that can drift from it.
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

/** Every `*.test.ts` file anywhere under a package dir, by basename -> absolute path. */
function testFilePaths(pkgDir: string): Map<string, string> {
  const found = new Map<string, string>();
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
      else if (e.name.endsWith(".test.ts")) found.set(e.name, join(dir, e.name));
    }
  };
  walk(pkgDir);
  return found;
}

/**
 * The resources an exclusion may legitimately claim, and what would CORROBORATE the claim in
 * the excluded suite's own source (#734).
 *
 * This is the part the #679 rule was missing. It asserted that a reason contained one of eight
 * words, and one of those words was `parallelism` — under a doc comment stating that "it is
 * slow" is not a reason. #721 probed it, and the reason *"it is just slow, so we skip it under
 * gate parallelism"* was accepted verbatim. That made the rule the opposite of what it said: it
 * did not forbid slowness exclusions, it taught you the phrasing that buys one. Two of the
 * three live `shared` entries already carried exactly that dressing.
 *
 * So `parallelism` is gone from the vocabulary — it names how the gate RUNS, not a resource the
 * box may lack — and each remaining word must now be BACKED BY THE SUITE. A reason claiming
 * `git` has to be attached to a suite whose source actually reaches for git.
 *
 * What this still cannot do, stated plainly rather than implied: it cannot verify the claimed
 * resource is the REAL reason for the exclusion. A slow suite that happens to spawn git can
 * still be excluded for being slow. What it does is turn an unfalsifiable phrase into a claim
 * about the code that a reader can check in one grep — a lie instead of boilerplate — which is
 * as far as a static rule reaches here. `MAX_EXCLUSIONS` remains the counter-pressure that
 * does not depend on believing any reason at all.
 */
const RESOURCE_CLAIMS: Array<{ word: string; corroboration: RegExp }> = [
  { word: "git", corroboration: /\bgit\b/i },
  { word: "docker", corroboration: /docker|compose/i },
  { word: "daemon", corroboration: /docker|daemon|listen/i },
  { word: "spawn", corroboration: /spawn|execFile|execSync|child_process|fork\(/ },
  { word: "child process", corroboration: /spawn|execFile|execSync|child_process|fork\(/ },
  { word: "binary", corroboration: /spawn|execFile|execSync|child_process|\.(exe|cmd)\b/i },
  { word: "transport", corroboration: /http|websocket|clone|fetch|serve/i },
];

/** Phrases that are a slowness argument, which the rule above says is not a reason on its own. */
const SLOWNESS_ONLY = /\bslow\b|\bslower\b|takes too long|\bparallelism\b/i;

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
      const names = testFilePaths(resolve(REPO_ROOT, pkg.dir));
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
  // under parallelism. "It is slow" is not a reason; scope it or speed it up. #734 made that
  // last sentence TRUE — until then `parallelism` was itself an accepted excuse. See
  // RESOURCE_CLAIMS above for what changed and what is still beyond a static check.
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
    const unjustified = packages.flatMap((p) =>
      p.exclude
        .filter((e) => !RESOURCE_CLAIMS.some((c) => e.reason.toLowerCase().includes(c.word)))
        .map((e) => `${p.label}: ${e.glob} — "${e.reason}"`),
    );
    expect(
      unjustified,
      "These exclusions give a reason naming no real git/docker/spawned-process need. Note that " +
        "the word `parallelism` stopped counting as one in #734: it describes how the gate runs, " +
        "not a resource the box may lack, and it was the loophole that let a pure slowness " +
        "excuse pass this very assertion.",
    ).toEqual([]);
  });

  // #734 — the reason is now checked against SOMETHING REAL: the excluded suite's own source.
  it("backs every claimed resource with evidence in the excluded suite itself", () => {
    const uncorroborated: string[] = [];
    for (const pkg of packages) {
      const paths = testFilePaths(resolve(REPO_ROOT, pkg.dir));
      for (const e of pkg.exclude) {
        const base = basenameOf(e.glob);
        const full = base ? paths.get(base) : undefined;
        if (!full) continue; // the stale-glob assertion above owns that failure
        const source = readFileSync(full, "utf8");
        for (const claim of RESOURCE_CLAIMS) {
          if (!e.reason.toLowerCase().includes(claim.word)) continue;
          if (claim.corroboration.test(source)) continue;
          uncorroborated.push(
            `${pkg.label}: ${e.glob} claims "${claim.word}" but nothing in its source matches ${claim.corroboration}`,
          );
        }
      }
    }
    expect(
      uncorroborated,
      "An exclusion's reason names a resource the excluded suite does not actually reach for. " +
        "Either the reason is wrong (fix it) or the exclusion is (delete it):\n  " +
        uncorroborated.join("\n  "),
    ).toEqual([]);
  });

  // #734 — the other half: a reason may ARGUE slowness, but never ONLY slowness. Before this,
  // `parallelism` was itself in the accepted vocabulary, so a slowness-only reason passed.
  it("rejects a reason whose whole argument is that the suite is slow", () => {
    const slownessOnly = packages.flatMap((p) =>
      p.exclude
        .filter(
          (e) =>
            SLOWNESS_ONLY.test(e.reason) && !RESOURCE_CLAIMS.some((c) => e.reason.toLowerCase().includes(c.word)),
        )
        .map((e) => `${p.label}: ${e.glob} — "${e.reason}"`),
    );
    expect(
      slownessOnly,
      "These reasons argue only that the suite is slow, which the rule above says is not a " +
        "reason: scope it or speed it up. A timing measurement is welcome ALONGSIDE a resource " +
        "the gate box cannot share — which is what the two `shared` git-integration entries do.",
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

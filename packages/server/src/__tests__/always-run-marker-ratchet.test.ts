// @gate:always-run — meta-ratchet over the always-run classification itself; imports nothing it checks (#538).
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
// #891: the marker rule itself comes from the script that RUNS the set, so this ratchet and
// the runner cannot disagree about what counts as marked. Four checks below used a bare
// `.includes(MARKER)`, and the one at `scanTestsDir` is why it mattered: it exempted a file
// from the unsound-signature scan BEFORE running it, so a tree-scanning suite that merely
// quoted the marker in a comment got a free pass from the ratchet built to catch exactly that.
import { isAlwaysRunMarked } from "../../../../scripts/test-mine.mjs";

/**
 * #538 — the always-run guard list was itself hand-maintained, which is the exact failure
 * mode it exists to prevent: `ALWAYS_RUN_TESTS` in `scripts/test-mine.mjs` hand-listed 9
 * files while ~35 tree-scanning suites (guard/ratchet/parity/scanner/drift shape — they
 * assert a property of the whole repo and import nothing they check, so dependency-based
 * `vitest related` selection can never pick them) went unlisted. That gap IS the rot
 * mechanism behind #483: `codex-skills-parity`, `pref-polarity-ratchet`,
 * `repository-table-ownership`, `no-self-http-in-services`, `command-safety-guard`,
 * `data-dir`, and `project-scaffold` were all in its failure set, and none was on the list.
 *
 * The fix: classify by DECLARATION, not by list. A suite that reaches state outside its own
 * module's import graph — a spawned process reading a script the diff can't statically link
 * to, a `MIGRATIONS_DIR`/journal read, or a recursive tree scan of `src`/`.claude`/`.codex` —
 * must carry a top-of-file `// @gate:always-run` marker, which `scripts/test-mine.mjs` scans
 * for to build its always-run set (replacing the hand-list). This test is the OTHER half:
 * it statically re-derives the same "reaches outside its own import graph" signal and fails
 * when a file matches it but carries no marker — so a NEW guard suite cannot be silently
 * selected away the way the #483 failure set was.
 *
 * This is a heuristic net, not a proof (stated risk, accepted in the ticket): a suite whose
 * ambient read hides behind a helper function will not match these regexes. The meta-ratchet
 * narrows the gap; it does not close it. A file that trips this check but is legitimately
 * reachable via its own imports (so file-scoping is safe to apply to it) belongs in
 * `KNOWN_SAFE_UNMARKED` with a one-line reason, not silently ignored — the same
 * "explain the exception in the test" discipline as every other ratchet here.
 *
 * #734 closed the two holes #687 disclosed in this file. Both exemption lists were keyed by
 * BASENAME, so eight strings were permanently un-guardable NAMES rather than eight exempted
 * files; they are keyed by `<package-label>/<path>` now. And a suite that reached the tree
 * only through the shared `guard-scan` helper matched no signature at all — a hole that WIDENED
 * with every guard centralised onto that helper — so using it is now a signature of its own.
 */

const packagesRoot = path.join(import.meta.dirname!, "..", "..", "..");
/**
 * #647: `client` was missing, so a client guard could match every unsound signature and never
 * be asked for a marker. Not hypothetical — the client owns `fetch-in-effect-ratchet`, a
 * repo-wide scan of exactly this shape. Kept in lockstep with `test-mine`'s
 * `ALWAYS_RUN_TESTS_DIR` and the gate tier's `ALWAYS_RUN_TESTS_DIRS` by
 * `always-run-dirs-lockstep.test.ts` — three lists describing one thing is how they drifted.
 */
export const SCAN_PACKAGES = [
  { label: "shared", testsDir: path.join(packagesRoot, "shared", "__tests__") },
  { label: "server", testsDir: path.join(packagesRoot, "server", "src", "__tests__") },
  { label: "mcp-server", testsDir: path.join(packagesRoot, "mcp-server", "src", "__tests__") },
  { label: "client", testsDir: path.join(packagesRoot, "client", "src", "__tests__") },
];

const MARKER = "@gate:always-run";

/** Test-file extensions this ratchet inspects. `.tsx`/`.mjs` were invisible before #647 —
 *  `test-mine-scope-derivation.test.mjs` carries the marker and was never even looked at. */
const TEST_FILE = /\.test\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/**
 * #647 item 1 — the detection half was far weaker than this file claimed. Its three
 * regexes encoded three IDIOMS rather than the property, and the repo does not write
 * them: `REACHES_OUTSIDE_PACKAGE` needed join/resolve + `__dirname` + four `../` in ONE
 * call (a shared-package guard at depth 3 could not match it if it tried);
 * `RECURSIVE_TREE_SCAN` needed the `function` keyword and a name containing list|walk|scan
 * (`collectSourceFiles` and every arrow-function walker missed). Measured: 12 of 41 marked
 * suites matched, so deleting the marker from `git-exec-single-spawn`, `settings-registry`,
 * `time-injection-spelling-ratchet` or `repo-path-literal-ratchet` left the ratchet GREEN —
 * the exact rot it exists to catch.
 *
 * Replaced by the property that actually holds: **the suite reads repo state resolved
 * outside its own directory.** It anchors a path at its own module location, climbs OUT of
 * that directory with a `..` segment, and then really touches disk. Nothing reached that way
 * has an edge in vitest's import graph, so a diff that breaks the target selects nothing.
 * Measured after the rewrite: 39 of 44 marked suites match, and it independently
 * rediscovered 18 unmarked repo-tree readers (now marked) including the three #647 named.
 *
 * Still a heuristic net, not a proof. The "through a helper" half of that gap is closed since
 * #734 (see USES_SHARED_GUARD_HELPER below); what remains is an unanchored path literal, and a
 * NEW suite in that shape would not be asked for a marker. Narrowing the gap is the goal;
 * closing it would need a real import analysis.
 */
const ANCHORED_AT_OWN_MODULE = /__dirname|import\.meta\.dirname|import\.meta\.url/;

/** A `..` path segment: `"..".."` as a whole segment, or the `../` prefix form. */
const CLIMBS_OUT_OF_OWN_DIR = /(['"`])\.\.\1|\.\.[/\\]/;

/** Actually reads the filesystem / runs a process at that resolved path — a suite that only
 *  builds a path string (never reading it) is not reaching outside anything. */
const TOUCHES_DISK =
  /\b(readFileSync|readdirSync|existsSync|statSync|readFile|readdir|globSync|gitExecSync|spawnSync|execFileSync|execSync)\b/;

/** A suite that reads the migrations directory/journal directly — a repo-wide resource no
 *  single changed source file imports. */
const READS_MIGRATIONS_DIR = /\bMIGRATIONS_DIR\b/;


/**
 * #687 — imports a repo SCRIPT (`scripts/…`) rather than a module in its own package.
 * `test-mine-scope-derivation.test.mjs` imports `scanAlwaysRunTests` from
 * `../../../../scripts/test-mine.mjs`; a change to that script is not a change to any file
 * the server package's `vitest related` graph is rooted in, so the suite that pins its
 * behaviour is exactly what gets dropped when the script itself is edited.
 */
const IMPORTS_A_REPO_SCRIPT = /from\s+["'][^"']*\/scripts\/[^"']+["']/;

/**
 * #734 — reaches the repo tree through the SHARED guard machinery
 * (`packages/shared/__tests__/helpers/guard-scan.ts`: `walkPackageSources`, `walkTestFiles`,
 * `packagesRootFrom`, `parseGuardSource`).
 *
 * This was the hole that WIDENED every time a guard was centralised onto that helper, which
 * the repo is actively doing (21 suites today, plus #721's typed AST layer and #734's own
 * conversions). A suite can now scan every package's sources without writing any of the
 * idioms the other signatures look for: `packagesRootFrom(import.meta.dirname, 2)` names no
 * `..` segment and calls no `readFileSync` — the walking and the reading both happen inside
 * the helper — so it matched nothing and was never asked for a marker. Delete its marker and
 * the ratchet stayed green, exactly the rot this suite exists to catch.
 *
 * Measured when added: all 21 suites that import the helper already carry the marker, so this
 * signature introduced no new offenders — it defends the marker they already have, and asks
 * for one from the next suite of that shape.
 *
 * #800 added `function-nloc` (`measureFunctionNloc`), the second shared test-only scanner in
 * `shared/__tests__/helpers`. It sits on top of `guard-scan` and walks a whole package tree on
 * the caller's behalf, so a suite that uses it writes no `readdirSync` and no `..` segment of
 * its own — precisely the hole #734 documents, reopened by a NEW helper rather than by a new
 * caller. Both nloc rings (client #763, server #800) went undefended the moment the scanner was
 * lifted out of the client test, which is how this was found.
 */
const USES_SHARED_GUARD_HELPER =
  /guard-scan|walkPackageSources|walkTestFiles|packagesRootFrom|parseGuardSource|function-nloc|measureFunctionNloc/;

const UNSOUND_SIGNATURES: Array<{ name: string; test: (source: string) => boolean }> = [
  { name: "reaches-tree-via-shared-guard-helper", test: (s) => USES_SHARED_GUARD_HELPER.test(s) },
  {
    name: "reads-outside-own-dir",
    test: (s) => ANCHORED_AT_OWN_MODULE.test(s) && CLIMBS_OUT_OF_OWN_DIR.test(s) && TOUCHES_DISK.test(s),
  },
  { name: "reads-migrations-dir", test: (s) => READS_MIGRATIONS_DIR.test(s) },
  /**
   * #687 — reading repo state anchored at your OWN directory is invisible to the import graph even
   * without climbing out of it. `repo-path-literal-ratchet.test.ts` does
   * `readdirSync(join(import.meta.dirname))` and reads every SIBLING test file; a diff to any of
   * them selects nothing that reaches it — yet `CLIMBS_OUT_OF_OWN_DIR` never matches, so it scored
   * zero signatures. That file is the one this suite's doc comment names as *the* example to copy,
   * which made the gap self-refuting: deleting its marker left the ratchet green.
   *
   * Deliberately `!CLIMBS` so it stays disjoint from `reads-outside-own-dir` above and a failure
   * message names one signature rather than two. Measured across all four packages: exactly two
   * files match this and not that (`repo-path-literal-ratchet` and `git-heavy-budget-ratchet`),
   * both already marked — so broadening from "enumerates a directory" to "touches disk" added no
   * false positives while catching the sibling-file readers a narrower regex missed.
   */
  {
    name: "reads-repo-state-from-own-dir",
    test: (s) =>
      ANCHORED_AT_OWN_MODULE.test(s) && TOUCHES_DISK.test(s) && !CLIMBS_OUT_OF_OWN_DIR.test(s),
  },
  { name: "imports-a-repo-script", test: (s) => IMPORTS_A_REPO_SCRIPT.test(s) },
];

/**
 * The REVERSE direction (#687): suites that carry the marker but match no signature.
 *
 * The forward check ("matches a signature but is unmarked") cannot see the rot that actually
 * happened — a marked suite the heuristic does not recognise is a suite whose marker nothing
 * defends. Delete it and every assertion here stays green, which is how the doc-cited example
 * came to be deletable. Measured before this test existed: 7 of 88 marked suites matched
 * nothing at all.
 *
 * Marked suites that legitimately match nothing are the ones marked BY POLICY rather than
 * because they are import-invisible: cheap cross-package parity/invariant checks that are
 * genuinely reachable through their own imports but are wanted on every gate run regardless.
 * Those are named here with a reason. Anything else must match a signature — which is what
 * makes a new marker either self-defending or a deliberate, reviewed exception.
 *
 * Keyed by `<package-label>/<path-under-__tests__>` since #734, for the same reason as
 * {@link KNOWN_SAFE_UNMARKED}: a basename key exempts every future file that happens to be
 * called that, anywhere in any package.
 */
const MARKED_BY_POLICY = new Set<string>([
  // Cross-package parity invariants: both sides are imported, so `vitest related` does reach
  // them. Marked because a registry/keys mismatch breaks settings for every project and is
  // milliseconds to check.
  "shared/settings-registry.test.ts",
  "server/settings-registry-keys.test.ts",
  // Pins the scheduler every background reconciler depends on (#529). Import-reachable;
  // marked because a regression here silently stops all sweeps rather than failing loudly.
  "server/periodic-sweep.test.ts",
  // #643 — asserts the tier CONTRACT (a level may only weaken verification visibly) against
  // the tier module it imports. Marked because the gate's own honesty is what it guards.
  "server/gate-tier-scoping.test.ts",
  // #687 — reaches the tree only through the helper it is testing (`countAlwaysRunGuardSuites`,
  // imported from pre-merge-gate-tier) and against TEMP fixture roots, never the real tree, so
  // no signature here applies. Marked because it is the suite that proves the guard COUNT in
  // every gate message is real; a wrong count is the number an operator checks instead of the
  // suite list.
  "server/guard-suite-count.test.ts",
  // #740 — asserts that every FK in the migrated schema has a leading index. It reaches the
  // migration .sql files only THROUGH createTestDb, so it names no MIGRATIONS_DIR itself and
  // matches no signature; but a new table with an un-indexed FK arrives as a migration file in
  // ANOTHER package, which package/import-graph scoping would not map to this suite.
  "server/fk-leading-index-ratchet.test.ts",
  // #739 — pins the column count of `workspaces` (88) and of each of its prefix column
  // families. Same shape as the FK ratchet above: it reaches the migrated schema only
  // THROUGH createTestDb, so it names no MIGRATIONS_DIR itself, but column 89 arrives as a
  // migration .sql file in ANOTHER package that import-graph scoping cannot map here.
  "server/workspaces-table-width-ratchet.test.ts",
]);

/**
 * Files that match an unsound signature but are deliberately NOT marked — each entry
 * states why file-scoping is still safe for it (e.g. it also imports the real module under
 * test, so `vitest related` reaches it through the ordinary dependency graph). Only SHRINK
 * this list; a file that stops matching its stated reason should be removed, not left stale.
 *
 * **Keyed by `<package-label>/<path-under-__tests__>` since #734.** It used to match by
 * BASENAME, which made these eight strings permanently un-guardable NAMES rather than
 * exemptions for eight files: a brand-new tree-scanning guard called `cli.test.ts` in any
 * package inherited the exemption of a spawn-based CLI integration test it has nothing to do
 * with, and `project-scripts.test.ts` already exists twice in this repo (server + e2e). An
 * exemption should be as narrow as the argument that earned it.
 */
const KNOWN_SAFE_UNMARKED = new Set<string>([
  // #647 item 5 removed three entries rather than adding any:
  //  - `stack-profile-read-is-pure.test.ts` no longer matches at all (its walk is over its
  //    own temp fixture dir, which never climbs out of the test's directory), so the
  //    exemption had nothing left to exempt;
  //  - `auto-merge-pref.test.ts` / `auto-review-pref.test.ts` were exempted on the reasoning
  //    that their subject is reachable by import. That is true of the ACCESSOR half and
  //    false of the half that matters: each also scans the whole `packages/` tree for
  //    hand-rolled reads of the pref, and no diff to the offending file imports the suite.
  //    Both carry the marker now.
  //
  // Spawn-based CLI integration tests, already excluded from `pnpm test:mine` entirely
  // (scripts/test-mine.mjs ALWAYS_RUN_TESTS never runs for a package whose suite is
  // excluded outright) — the MIGRATIONS_DIR read is real but moot for file-scoping.
  "server/cli.test.ts",
  "server/cli-butler.test.ts",
  // Import the real service under test (`merge-cleanup.service.ts` / project-scripts route /
  // `reconcileMergedIssue`); MIGRATIONS_DIR is only used to seed a temp test DB with the real
  // schema, not to assert a repo-wide property — reachable via the ordinary import graph.
  "server/merge-cleanup.service.test.ts",
  "server/project-scripts.test.ts",
  "server/reconcile-merged-issue.test.ts",
  // #661: same shape as merge-cleanup.service.test.ts above — imports the services under
  // test (merge-cleanup + workspace-issue-members repository) directly; MIGRATIONS_DIR
  // only seeds the temp DB.
  "server/ticket-groups.test.ts",
  // #647: same MIGRATIONS_DIR-shaped exemption, reached by the rewritten signature. Each
  // resolves the monorepo root only to find `packages/shared/drizzle` and seed a TEMP DB
  // with the real schema; the subject under test is the MCP tool, reachable by import.
  "mcp-server/disabled-tools.test.ts",
  "mcp-server/mcp-tools.test.ts",
  "mcp-server/tools/get-context-boundary.test.ts",
]);

interface Offender {
  file: string;
  signatures: string[];
}

/** Every test file under a `__tests__` tree. Recursive since #647: the flat read never saw
 *  `mcp-server/src/__tests__/tools/` (33 suites). */
function collectTestFiles(testsDir: string, rel = ""): { name: string; rel: string; full: string }[] {
  const dir = rel ? path.join(testsDir, rel) : testsDir;
  if (!fs.existsSync(dir)) return [];
  const out: { name: string; rel: string; full: string }[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const childRel = rel ? path.posix.join(rel, entry.name) : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
      out.push(...collectTestFiles(testsDir, childRel));
      continue;
    }
    if (!TEST_FILE.test(entry.name)) continue;
    out.push({ name: entry.name, rel: childRel, full: path.join(dir, entry.name) });
  }
  return out;
}

/**
 * Every scanned test file by its `<label>/<rel>` key — the identity both exemption lists are
 * keyed by since #734. Two files with the same basename in different packages are two entries,
 * which is the whole point of the change.
 */
function collectByPath(): Map<string, string> {
  const byPath = new Map<string, string>();
  for (const { label, testsDir } of SCAN_PACKAGES) {
    for (const f of collectTestFiles(testsDir)) byPath.set(`${label}/${f.rel}`, f.full);
  }
  return byPath;
}

function scanTestsDir(label: string, testsDir: string): Offender[] {
  const offenders: Offender[] = [];
  for (const { rel, full } of collectTestFiles(testsDir)) {
    const source = fs.readFileSync(full, "utf8");
    if (isAlwaysRunMarked(source)) continue;
    // Matched by PATH since #734: an exemption covers the file it was argued for, and moving
    // that file is a reviewed edit here rather than a silent transfer to its new neighbour.
    if (KNOWN_SAFE_UNMARKED.has(`${label}/${rel}`)) continue;
    const matched = UNSOUND_SIGNATURES.filter((sig) => sig.test(source)).map((sig) => sig.name);
    if (matched.length > 0) offenders.push({ file: rel, signatures: matched });
  }
  return offenders;
}

describe("always-run marker ratchet (#538)", () => {
  it("every suite with an unsound (import-graph-invisible) signature carries the @gate:always-run marker", () => {
    const offenders: string[] = [];
    for (const { label, testsDir } of SCAN_PACKAGES) {
      for (const { file, signatures } of scanTestsDir(label, testsDir)) {
        offenders.push(`${label}/${file} (${signatures.join(", ")})`);
      }
    }
    expect(
      offenders,
      `These suites reach state outside their own package's import graph (spawn a script under ` +
        `.claude/.codex/scripts, read MIGRATIONS_DIR, or recursively scan a directory tree) but carry ` +
        `no "${MARKER}" marker, so dependency-based test selection can silently stop running them — ` +
        `exactly the #483 failure mode. Add the marker as a top-of-file comment (see ` +
        `repo-path-literal-ratchet.test.ts), or add the file to KNOWN_SAFE_UNMARKED here with a reason ` +
        `if it is genuinely reachable via its own imports:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  it("KNOWN_SAFE_UNMARKED entries are not stale", () => {
    const stale: string[] = [];
    const byPath = collectByPath();
    for (const key of KNOWN_SAFE_UNMARKED) {
      const full = byPath.get(key);
      // #734: a path key that resolves to nothing is itself staleness — under the old basename
      // keys a moved or deleted file silently kept its exemption alive for its own name.
      if (!full) {
        stale.push(`${key}: no such test file — remove the entry`);
        continue;
      }
      const source = fs.readFileSync(full, "utf8");
      if (!UNSOUND_SIGNATURES.some((sig) => sig.test(source))) {
        stale.push(`${key}: no longer matches any unsound signature — remove the entry`);
      }
    }
    expect(stale, `Stale KNOWN_SAFE_UNMARKED entries:\n${stale.join("\n")}`).toEqual([]);
  });

  /**
   * #647 — the scan surface itself. A marker mechanism whose scan is narrower than the tree it
   * claims to guard fails silently in the one direction that matters, so assert the reach
   * rather than trusting it.
   */
  it("reaches every marked suite in every scanned package, at any depth", () => {
    const marked: string[] = [];
    for (const { label, testsDir } of SCAN_PACKAGES) {
      for (const f of collectTestFiles(testsDir)) {
        if (isAlwaysRunMarked(fs.readFileSync(f.full, "utf8"))) marked.push(`${label}/${f.rel}`);
      }
    }
    // Sanity floor: the mechanism is worthless if the walk finds nothing.
    expect(marked.length).toBeGreaterThan(20);
    // The two blind spots #647 named: a non-.ts suite, and a nested directory.
    const serverFiles = collectTestFiles(SCAN_PACKAGES[1].testsDir);
    expect(serverFiles.some((f) => f.name.endsWith(".test.mjs"))).toBe(true);
    const mcpFiles = collectTestFiles(SCAN_PACKAGES[2].testsDir);
    expect(mcpFiles.some((f) => f.rel.includes("/"))).toBe(true);
  });

  // #687 — the reverse direction. A marked suite that matches no signature has a marker
  // nothing defends: deleting it keeps every other assertion in this file green.
  it("every marked suite either matches a signature or is a declared policy marker", () => {
    const undefended: string[] = [];
    for (const { label, testsDir } of SCAN_PACKAGES) {
      for (const { rel, full } of collectTestFiles(testsDir)) {
        const source = fs.readFileSync(full, "utf8");
        if (!isAlwaysRunMarked(source)) continue;
        if (MARKED_BY_POLICY.has(`${label}/${rel}`)) continue;
        if (UNSOUND_SIGNATURES.some((sig) => sig.test(source))) continue;
        undefended.push(`${label}/${rel}`);
      }
    }
    expect(
      undefended,
      `These suites carry the "${MARKER}" marker but match none of the signatures, so nothing ` +
        `here would notice if the marker were deleted — the marker is undefended. Either the ` +
        `signature set is missing the shape this suite uses (extend UNSOUND_SIGNATURES, which ` +
        `protects every future suite of that shape), or the suite is marked by policy rather ` +
        `than because it is import-invisible (add it to MARKED_BY_POLICY with a reason):\n  ` +
        undefended.join("\n  "),
    ).toEqual([]);
  });

  it("MARKED_BY_POLICY entries are not stale", () => {
    // An entry that has started matching a signature is defended by the signature now, and
    // leaving it here would re-hide the next suite that lands in the same shape.
    const byPath = collectByPath();
    const stale: string[] = [];
    for (const key of MARKED_BY_POLICY) {
      const full = byPath.get(key);
      if (!full) { stale.push(`${key} (no such test file)`); continue; }
      const source = fs.readFileSync(full, "utf8");
      if (!isAlwaysRunMarked(source)) { stale.push(`${key} (no longer marked)`); continue; }
      if (UNSOUND_SIGNATURES.some((sig) => sig.test(source))) stale.push(`${key} (now matches a signature)`);
    }
    expect(stale, `remove these from MARKED_BY_POLICY:\n  ${stale.join("\n  ")}`).toEqual([]);
  });
});

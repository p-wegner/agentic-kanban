// @gate:always-run — meta-ratchet over the always-run classification itself; imports nothing it checks (#538).
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

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

/** A suite that spawns/requires/reads a script OUTSIDE its own package's `src` — vitest's
 *  import graph has no edge to it, so a diff that breaks the target script selects nothing. */
const REACHES_OUTSIDE_PACKAGE =
  /(?:join|resolve)\([^)]*(?:__dirname|import\.meta\.dirname)[^)]*\.\.[/\\]\.\.[/\\]\.\.[/\\]\.\.[/\\](?:\.claude|\.codex|scripts)[/\\]/;

/** A suite that reads the migrations directory/journal directly — a repo-wide resource no
 *  single changed source file imports. */
const READS_MIGRATIONS_DIR = /\bMIGRATIONS_DIR\b/;

/** A suite that recursively walks a directory tree (its own `readdirSync`-based walker, not a
 *  one-off read of a single named fixture) to assert an architectural invariant. */
const RECURSIVE_TREE_SCAN = /function\s+\w*(?:list|walk|scan)\w*\([^)]*\)[\s\S]{0,400}?readdirSync/i;

const UNSOUND_SIGNATURES: Array<{ name: string; pattern: RegExp }> = [
  { name: "reaches-outside-package", pattern: REACHES_OUTSIDE_PACKAGE },
  { name: "reads-migrations-dir", pattern: READS_MIGRATIONS_DIR },
  { name: "recursive-tree-scan", pattern: RECURSIVE_TREE_SCAN },
];

/**
 * Files that match an unsound signature but are deliberately NOT marked — each entry
 * states why file-scoping is still safe for it (e.g. it also imports the real module under
 * test, so `vitest related` reaches it through the ordinary dependency graph). Only SHRINK
 * this list; a file that stops matching its stated reason should be removed, not left stale.
 */
const KNOWN_SAFE_UNMARKED = new Set<string>([
  // Imports the real `stack-profile.service.ts` under test; its tree walk is a self-scoped
  // read of its own temp fixture dir (asserting "wrote nothing"), not a repo-wide scan — a
  // diff to the service reaches this suite via the ordinary `vitest related` import graph.
  "stack-profile-read-is-pure.test.ts",
  // Import the real `auto-merge-pref.ts`/`auto-review-pref.ts` accessors under test; each
  // suite's tree scan is a secondary regression guard against hand-rolled reads elsewhere,
  // but the primary subject is reachable via its own import.
  "auto-merge-pref.test.ts",
  "auto-review-pref.test.ts",
  // Spawn-based CLI integration tests, already excluded from `pnpm test:mine` entirely
  // (scripts/test-mine.mjs ALWAYS_RUN_TESTS never runs for a package whose suite is
  // excluded outright) — the MIGRATIONS_DIR read is real but moot for file-scoping.
  "cli.test.ts",
  "cli-butler.test.ts",
  // Import the real service under test (`merge-cleanup.service.ts` / project-scripts route /
  // `reconcileMergedIssue`); MIGRATIONS_DIR is only used to seed a temp test DB with the real
  // schema, not to assert a repo-wide property — reachable via the ordinary import graph.
  "merge-cleanup.service.test.ts",
  "project-scripts.test.ts",
  "reconcile-merged-issue.test.ts",
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

function scanTestsDir(testsDir: string): Offender[] {
  const offenders: Offender[] = [];
  for (const { name, rel, full } of collectTestFiles(testsDir)) {
    const source = fs.readFileSync(full, "utf8");
    if (source.includes(MARKER)) continue;
    // Matched by BASENAME, so an allowlisted file keeps its exemption wherever it moves to.
    if (KNOWN_SAFE_UNMARKED.has(name)) continue;
    const matched = UNSOUND_SIGNATURES.filter((sig) => sig.pattern.test(source)).map((sig) => sig.name);
    if (matched.length > 0) offenders.push({ file: rel, signatures: matched });
  }
  return offenders;
}

describe("always-run marker ratchet (#538)", () => {
  it("every suite with an unsound (import-graph-invisible) signature carries the @gate:always-run marker", () => {
    const offenders: string[] = [];
    for (const { label, testsDir } of SCAN_PACKAGES) {
      for (const { file, signatures } of scanTestsDir(testsDir)) {
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
    const byName = new Map<string, string>();
    for (const { testsDir } of SCAN_PACKAGES) {
      for (const f of collectTestFiles(testsDir)) byName.set(f.name, f.full);
    }
    {
      for (const name of KNOWN_SAFE_UNMARKED) {
        const full = byName.get(name);
        if (!full) continue;
        const source = fs.readFileSync(full, "utf8");
        const stillMatches = UNSOUND_SIGNATURES.some((sig) => sig.pattern.test(source));
        if (!stillMatches) stale.push(`${name}: no longer matches any unsound signature — remove the entry`);
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
        if (fs.readFileSync(f.full, "utf8").includes(MARKER)) marked.push(`${label}/${f.rel}`);
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
});

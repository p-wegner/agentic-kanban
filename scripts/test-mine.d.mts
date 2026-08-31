// Types for test-mine.mjs, so the guard suites that read the REAL runner's own
// lists can import it without `tsc` falling back to `any` (TS7016).
//
// Hand-written rather than generated, matching `security-scan.d.mts` (#827):
// the script is deliberately a plain .mjs with no build step, because
// `pnpm test:mine` and the pre-merge gate run it directly and a compile step
// between the runner and the suites that guard it is one more thing that can
// disagree with itself.
//
// Only the exported surface is described. Drift is not silent: the three suites
// that import these (`always-run-dirs-lockstep`, `test-mine-exclusions-ratchet`,
// `test-mine-scope-derivation`) execute the real module, so a declaration for an
// export that no longer exists fails at import time, not at type-check time.
// They previously carried `@ts-expect-error` here, which suppressed exactly the
// mismatch they exist to catch (#835).

/** One test package the runner knows about, with the suites it deliberately skips. */
export declare const PACKAGES: {
  dir: string;
  label: string;
  exclude: { glob: string; reason: string }[];
}[];

/** The `__tests__` dir, relative to the package dir, for each entry in {@link PACKAGES}. */
export declare const ALWAYS_RUN_TESTS_DIR: Record<string, string>;

/**
 * Does `source` DECLARE itself always-run — i.e. carry a top-of-line `// @gate:always-run`
 * comment — as opposed to merely mentioning the marker in prose or holding it as fixture data?
 *
 * The single definition of that rule for every importer (#891). It cannot live in
 * `packages/shared`: the runner is bare `.mjs` with no build step, and making it depend on a
 * built `dist/` would break it in worktrees, which have none.
 */
export declare function isAlwaysRunMarked(source: string): boolean;

/** Test-file extensions the marker scan recognises (`.tsx` and `.mjs` were invisible, #647). */
export declare const ALWAYS_RUN_TEST_FILE: RegExp;

/**
 * Scan `<pkgDir>/<testsDir>` recursively for test files carrying the
 * `@gate:always-run` marker, returning paths relative to `pkgDir`.
 * The lister/reader pair is injectable so the walk is unit-testable.
 */
export declare function scanAlwaysRunTests(
  pkgDir: string,
  testsDir: string,
  listDir?: (dir: string) => readonly (string | { name: string; isDirectory(): boolean })[],
  readText?: (path: string) => string,
): string[];

/**
 * The refusal message for `KANBAN_TEST_SELECTOR=impact` + `KANBAN_TEST_FILES` together, or
 * `null` when there is no conflict (#962).
 */
export declare function selectorFileScopeConflict(input: {
  impactSelectorRequested: boolean;
  scopedFiles: readonly string[];
}): string | null;

/** Changed files under a package, relative to that package's directory. */
export declare function ownedChangedFiles(
  pkgDir: string,
  files?: readonly string[],
  exists?: (path: string) => boolean,
): string[];

/** Packages whose vitest config resolves `@agentic-kanban/shared` straight to its `src/`. */
export declare const UPSTREAM_DEPENDENCIES: Record<string, string[]>;

/** Changed files owned by an UPSTREAM package this package depends on, as absolute paths. */
export declare function upstreamChangedFiles(
  label: string,
  files?: readonly string[],
  exists?: (path: string) => boolean,
  root?: string,
): string[];

/**
 * `{ [absolutePath]: boolean }` — whether each file is reachable from some suite
 * in `pkgDir` — or `null` when it could not be determined.
 */
export declare function relatedCoverageByFile(
  pkgDir: string,
  files: readonly string[],
  loadVitest?: (pkgDir: string) => Promise<{ createVitest: (...a: never[]) => unknown }>,
): Promise<Record<string, boolean> | null>;

/** Source files the related-selection asserted nothing about. `null` in means `null` out. */
export declare function uncoveredSourceFiles(
  coverage: Record<string, boolean> | null,
): string[] | null;

/** `path -> git status code`, or `null` when git cannot answer. */
export declare function treeSnapshot(): Map<string, string> | null;

/** Paths whose git status is not what it was before the run. */
export declare function treeDrift(
  before: Map<string, string> | null,
  after: Map<string, string> | null,
): string[];

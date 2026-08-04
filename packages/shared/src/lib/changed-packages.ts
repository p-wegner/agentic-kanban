/**
 * Derive which workspace packages a diff touches, so the pre-merge gate can run only the
 * test suites that could possibly be affected instead of the whole monorepo (#throughput).
 *
 * Pure string logic (no fs, no git) so it is client-safe through the shared barrel and
 * trivially unit-testable.
 *
 * The whole value of this module is that it is CONSERVATIVE: narrowing a merge gate is a
 * safety-relevant decision, so every ambiguity must resolve to "run everything". It returns
 * `null` — meaning "no scope, run all packages" — for anything it does not fully understand.
 */

/** Package labels as used by `scripts/test-mine.mjs` (its `PACKAGES[].label`). */
export type TestPackageLabel = "shared" | "server" | "mcp-server" | "client";

/** Maps a repo-relative path prefix to the package label that owns it. */
const PACKAGE_PREFIXES: ReadonlyArray<{ prefix: string; label: TestPackageLabel }> = [
  { prefix: "packages/shared/", label: "shared" },
  { prefix: "packages/server/", label: "server" },
  { prefix: "packages/mcp-server/", label: "mcp-server" },
  { prefix: "packages/client/", label: "client" },
];

/**
 * Paths that are owned by no single package and can change the behaviour of ANY suite:
 * root build/test config, the shared dependency graph, CI, and the gate's own scripts.
 * A diff touching one of these forfeits scoping entirely.
 */
const GLOBAL_SCOPE_BREAKERS: ReadonlyArray<RegExp> = [
  /^package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/,
  /^tsconfig(\.[a-z]+)?\.json$/,
  /^vitest\.[a-z.]*config\.[cm]?[jt]s$/,
  /^\.dependency-cruiser\.cjs$/,
  /^scripts\//,
  /^\.github\//,
];

/**
 * Packages whose suites scan the WHOLE repository tree rather than only their own sources,
 * so they must run no matter which package a diff touches. `shared` owns the architecture
 * and bundle-safety gates (`max-file-size.test.ts` walks every package's files;
 * `barrel-client-safety.test.ts` reasons about what the client can import), and those are
 * exactly the checks a narrow, confident diff is most likely to violate.
 */
const ALWAYS_RUN: ReadonlyArray<TestPackageLabel> = ["shared"];

/**
 * Order used for the returned list — stable output makes the value safe to put in a log line
 * or an env var and compare across runs.
 */
const LABEL_ORDER: ReadonlyArray<TestPackageLabel> = ["shared", "server", "mcp-server", "client"];

function normalise(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").trim();
}

/**
 * Which test packages must run for this diff.
 *
 * @returns a non-empty, ordered list of package labels, or `null` when no narrowing is safe
 *   (an empty diff, an unreadable diff, a path owned by no package, or a global config
 *   change). `null` means "run everything" — callers must treat it as the safe default and
 *   never as "run nothing".
 */
export function scopedTestPackages(changedFiles: readonly string[]): TestPackageLabel[] | null {
  // No files means we could not see the diff (git failed, or the caller had no base branch).
  // That is ignorance, not proof of a small change — refuse to scope.
  if (!changedFiles || changedFiles.length === 0) return null;

  const labels = new Set<TestPackageLabel>();
  for (const raw of changedFiles) {
    const path = normalise(raw);
    if (!path) continue;
    if (GLOBAL_SCOPE_BREAKERS.some((re) => re.test(path))) return null;
    const owner = PACKAGE_PREFIXES.find((p) => path.startsWith(p.prefix));
    // A tracked file under no package (a root doc, a stray config, a new top-level dir) is
    // something this map does not model — fail open rather than guess.
    if (!owner) return null;
    labels.add(owner.label);
  }
  if (labels.size === 0) return null;
  for (const always of ALWAYS_RUN) labels.add(always);
  return LABEL_ORDER.filter((l) => labels.has(l));
}

/**
 * The `KANBAN_TEST_PACKAGES` value for a diff, or `null` when the gate should not scope.
 * `test:mine` only knows about shared/server/mcp-server, so `client` is dropped from the
 * env value — but its presence in the scope is what keeps the OTHER packages from being
 * dropped when a diff spans both.
 */
export function testPackagesEnvValue(changedFiles: readonly string[]): string | null {
  const scope = scopedTestPackages(changedFiles);
  if (!scope) return null;
  const runnable = scope.filter((l) => l !== "client");
  return runnable.length > 0 ? runnable.join(",") : null;
}

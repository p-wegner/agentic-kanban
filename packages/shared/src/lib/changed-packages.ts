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
 * root build/test config, the shared dependency graph, and the gate's own scripts. A diff
 * touching one of these forfeits scoping entirely.
 *
 * `.github/**` is deliberately NOT here (#537 leak B): the gate is a local `vitest`/`build`
 * run, it never executes CI workflow config, so a workflow-file edit cannot change what the
 * gate's own commands do — voiding scope for it bought nothing but a wasted full run (#476
 * paid a 40-minute gate partly for exactly this). `scripts/**` is narrowed to only the
 * scripts the gate itself invokes or that its own test suites read — most of `scripts/` (e.g.
 * `scripts/board-monitor/`) has no bearing on what `pnpm test:mine && pnpm build` does.
 */
const GLOBAL_SCOPE_BREAKERS: ReadonlyArray<RegExp> = [
  /^package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/,
  /^tsconfig(\.[a-z]+)?\.json$/,
  /^vitest\.[a-z.]*config\.[cm]?[jt]s$/,
  /^\.dependency-cruiser\.cjs$/,
  /^scripts\/test-mine\.mjs$/,
  /^scripts\/check-god-modules\.mjs$/,
  // #988 — `pnpm check:arch` is this script now, so an edit here changes what the arch half of
  // the gate runs, exactly as an edit to the god-module script does.
  /^scripts\/check-arch\.mjs$/,
  // #988 — and `pnpm typecheck` is this one (#980), which was never listed: it decides which
  // packages get typechecked and with what cache, so a diff touching it cannot be scoped by a
  // map that only models source ownership.
  /^scripts\/typecheck\.mjs$/,
  /^scripts\/build-.*\.mjs$/,
  /^scripts\/copy-assets\.mjs$/,
  // #643: the breakers above are ROOT-anchored, so a PER-PACKAGE `package.json` or
  // `vitest.config.ts` was scoped to its own package like any source file — even though a
  // dependency bump or a vitest-config change (environment, setup files, timeouts, pool) can
  // alter how EVERY suite behaves, including suites in other packages that import it. Same
  // class of mistake as the root-level entries, just one directory down.
  /^packages\/[^/]+\/package\.json$/,
  // Any `vitest.*.{ts,mts,js,…}` sitting directly in a package root — `vitest.config.ts`,
  // `vitest.workspace.mts`, `vitest.setup.ts`. The root-level breaker can afford to name only
  // `*config*` because anything else at the root is unowned and fails open anyway; a file
  // inside a package IS owned, so this one has to be the broader pattern.
  /^packages\/[^/]+\/vitest\.[^/]*\.[cm]?[jt]s$/,
  /^packages\/[^/]+\/tsconfig(\.[a-z]+)?\.json$/,
];

/**
 * Paths that are owned by no package but ALSO cannot affect what the gate's own commands
 * (`pnpm test:mine && pnpm build`) do, so a diff touching only these can still be scoped
 * (#537 leak B). This is narrower than "not a breaker" — it is an explicit allowlist, not the
 * absence of one, because the default for an unrecognised path must stay fail-open (see the
 * `!owner` branch below). CI workflow config is the concrete case: the gate never executes it.
 */
const IGNORABLE_UNOWNED_PATHS: ReadonlyArray<RegExp> = [
  /^\.github\//,
  /^scripts\/board-monitor\//,
];

/**
 * Packages whose suites scan the WHOLE repository tree rather than only their own sources,
 * so they must run no matter which package a diff touches. `shared` owns the architecture
 * and bundle-safety gates (`max-file-size.test.ts` walks every package's files;
 * `barrel-client-safety.test.ts` reasons about what the client can import), and those are
 * exactly the checks a narrow, confident diff is most likely to violate.
 *
 * #647: `server` belongs here for the same reason and was missing. Most of the repo-wide
 * guards actually live there — time-injection-spelling, windows-hide-spawn,
 * start-policy-single-source, repo-path-literal, the always-run marker ratchet — so an
 * mcp-only or client-only diff dropped EVERY one of them. That is the precise opposite of
 * what a tree-scanning guard is for: the diffs least likely to be checked by their own
 * package's suites were the ones that skipped the checks covering the whole tree.
 *
 * The cost is real (server is the largest suite) and is accepted: this list is the safety
 * floor under scoping, and a floor that omits most of the guards is not a floor.
 */
const ALWAYS_RUN: ReadonlyArray<TestPackageLabel> = ["shared", "server"];

/**
 * DOWNSTREAM dependents of each package (#241). Ownership is not the same as blast radius:
 * `packages/shared` is imported by every other package (git-service, the merge services, the
 * Drizzle schema and its migrations), so a shared-only diff affects precisely the suites that
 * ownership-based scoping dropped.
 *
 * The concrete failure this closes: a migration-only diff (`packages/shared/drizzle/NNNN_x.sql`
 * + the journal) scoped to `shared` alone and therefore SKIPPED
 * `packages/server/src/__tests__/migration-schema-drift.test.ts` — the gate `packages/shared/CLAUDE.md`
 * names as THE gate for exactly that diff. Same for `shared/src/lib/git-service/*`: it could
 * merge without one merge-service test running.
 *
 * Derived from the workspace `package.json` dependency graph: server, mcp-server and client each
 * depend on `@agentic-kanban/shared`; nothing depends on the other three. Keep this in sync if
 * that ever changes — the direction that matters for safety is the one that ADDS suites.
 */
const DOWNSTREAM_DEPENDENTS: Readonly<Record<TestPackageLabel, ReadonlyArray<TestPackageLabel>>> = {
  shared: ["server", "mcp-server", "client"],
  server: [],
  "mcp-server": [],
  client: [],
};

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
    if (IGNORABLE_UNOWNED_PATHS.some((re) => re.test(path))) continue;
    const owner = PACKAGE_PREFIXES.find((p) => path.startsWith(p.prefix));
    // A tracked file under no package (a root doc, a stray config, a new top-level dir) is
    // something this map does not model — fail open rather than guess.
    if (!owner) return null;
    labels.add(owner.label);
  }
  if (labels.size === 0) return null;
  // Expand along the dependency graph BEFORE adding ALWAYS_RUN. Order matters: `shared` is in
  // ALWAYS_RUN, so expanding after it would pull shared's dependents in for EVERY diff and
  // scoping would degenerate to "run everything". Only labels the diff actually OWNS expand.
  for (const owned of [...labels]) {
    for (const dependent of DOWNSTREAM_DEPENDENTS[owned]) labels.add(dependent);
  }
  for (const always of ALWAYS_RUN) labels.add(always);
  return LABEL_ORDER.filter((l) => labels.has(l));
}

/**
 * The `KANBAN_TEST_PACKAGES` value for a diff, or `null` when the gate should not scope.
 *
 * #639: this used to `filter((l) => l !== "client")`, on the rationale that "test:mine only
 * knows about shared/server/mcp-server". That rationale expired when #601 added
 * `packages/client` to `scripts/test-mine.mjs` — but the filter stayed, so a client-only diff
 * scoped to `["shared", "client"]` and then handed the gate `"shared"`. The client's ~146 test
 * files were skipped for precisely the diffs they exist to cover, which nullified #601 without
 * leaving a trace: the gate still reported a clean pass.
 *
 * The scope is now passed through verbatim. Every label in it is a `PACKAGES[].label` in
 * test-mine, and `test-mine-scope-labels.test.ts` holds the two lists in lockstep.
 */
export function testPackagesEnvValue(changedFiles: readonly string[]): string | null {
  const scope = scopedTestPackages(changedFiles);
  if (!scope) return null;
  return scope.length > 0 ? scope.join(",") : null;
}

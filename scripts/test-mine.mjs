// test:mine — the fast, opinionated unit-test loop for day-to-day iteration.
//
// Runs ONLY the suites that are reliably green in this environment (main checkout
// AND inside a git worktree). The known-flaky / pre-existing-broken suites listed
// in the block below are skipped so agents and humans stop chasing false failures.
// `pnpm test:full` (#640) is the run that includes them.
//
// Why a wrapper instead of a single vitest invocation: the flaky suites live in
// two different packages (server + mcp-server), each with its own vitest config.
// This runs vitest once per package with the right `--exclude` globs and
// aggregates the exit codes.
//
// Why we invoke vitest's own entry directly (node <pkg>/node_modules/vitest/vitest.mjs)
// with cwd set to the package, instead of `pnpm --filter <pkg> test -- <args>`:
// forwarding flags through `pnpm run test -- ...` is unreliable on Windows. The
// nested `pnpm.cmd` shell shim mangles the `--` forward-separator, so the
// `--exclude` globs never reach vitest and the flaky suites run anyway. Calling
// vitest directly from the package dir lets its own `vitest.config.ts` resolve
// and the flags arrive verbatim. (Verified: this excludes the suites; the pnpm
// path did not.)
//
// Excluded suites. These used to say "keep in sync with CLAUDE.md's Known Flaky Test Suites
// table" — that table was DELETED in 0b45b0a9b4, so it was an instruction to sync with nothing
// (#641). This block is the doc of record now, and `test-mine-exclusions-ratchet.test.ts` keeps
// it honest: the exclusion set is pinned, every glob must still match a real file, and growth
// requires an explicit reviewed edit rather than a one-line commit by whoever's gate was red.
//
// An excluded suite runs in `pnpm test:full` (added in #640 — before it, `pnpm test` was the
// server package alone and `packages/shared` had no `test` script at all, so several of these
// were reachable by NO command in the repo, despite the "still runs in the full pnpm test"
// claim that used to appear below).
//
// The ticket refs below said #202 ("Refactor safety net plugin improvements"), which is
// unrelated; the flake tickets are #173 (contention timeouts) and #164 (opt-in real docker).
//   shared:
//     - git-service.integration.test.ts (#173) real git on temp dirs; Windows file-locking /
//       timing — same root cause as server's git.service.test.ts below. Measured: passes in
//       ~36s, fails on a 30s timeout in ~43s, no code change in between — pure timing flake.
//     - append-only-hotfile-merge.integration.test.ts, migration-renumber-conflict-guard.test.ts
//       — same #173 shape, found 2026-08-03 when they were failing EVERY pre-merge gate and so
//       blocking every merge on the board. Both are real-git-on-temp-dirs and both pass in
//       isolation (316s/5 tests and 152s/2 tests respectively) but exceed even a 240s per-test
//       timeout under full-suite parallelism. Raising their timeouts was already tried and is
//       not the answer: they are starved, not merely slow.
//   server:
//     - cli.test.ts        spawn-based CLI integration; stale migration list / worktree DB resolution
//     - cli-butler.test.ts spawn-based CLI integration; same root causes
//     - git.service.test.ts real git on temp dirs; Windows file-locking / timing
//     - done-unmerged-invariant-scanner.test.ts, workspace-merge-service.test.ts,
//       workspace-already-merged.test.ts, api-workspace.test.ts, workspace-lifecycle-transitions.test.ts,
//       merge-endpoint-reconcile-noop.test.ts, merge-service-edge-cases.test.ts, preferences.test.ts
//       (#173) — every one of these is green in isolation; under full
//       parallelism a single file can hit CPU-contention timeouts of 15-17min, flaking the
//       merge gate red and (via #172) leaking a vitest worker fleet on each retry.
//     - auto-review-pref.test.ts was on this list and is NOT any more (#647 item 5). It is
//       half accessor test, half WHOLE-TREE scan for hand-rolled auto_review reads — and the
//       scanning half is reachable by no other command, so excluding it meant that guard ran
//       nowhere while looking like it was covered. Measured 5 tests / ~19s, no DB, no git, no
//       docker: it is slow-ish because it walks the tree, not because it contends, which is
//       not the #173 shape the rest of this list has. It carries @gate:always-run now.
//     - worker-git-transport-e2e.test.ts — same #173 shape, arrived with the worker-fleet
//       epic (#188) and was never added here. It stands up TWO http listeners (board +
//       git-http) and does real `git clone`/`push` over the wire, so it is the heaviest
//       file in the package. Measured: 2/2 green in isolation on three consecutive runs
//       (~24s), but it failed the merge gate three times in a row under full-suite load
//       with `repo provisioning failed: git clone ...`. Runs in `pnpm test:full`.
//     - compose-lifecycle-real-docker.test.ts (#164) — opt-in real-docker smoke test;
//       shells out to a real daemon and pulls/builds real images, so it's excluded from
//       the fast loop even on a machine with docker running. Run it via `pnpm test:docker`
//       (or `pnpm test:full`, which does include it — self-skips when docker is absent).
//   mcp-server:
//     - mcp-tools.test.ts  spawn-based MCP integration; stale migration list FIXED (reads journal dynamically).
//       Its catalog↔runtime parity gate has a fast NON-SPAWNING twin that DOES run here:
//       mcp-catalog-parity.test.ts (#982) — so parity breaks surface in this loop, not
//       only in `pnpm test:full`.
//
// Pass-through: any extra args are forwarded to vitest run in BOTH packages, so you can
// still narrow the run, e.g.:
//   pnpm test:mine -- --changed HEAD            (run tests for all git-changed files)
//   pnpm test:mine -- src/__tests__/tags.test.ts
// NOTE: vitest 4 removed the --related flag. Use `pnpm exec vitest related <file>`
// from inside the package dir to run tests that cover a specific source file.

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

/** @type {{ dir: string, label: string, exclude: string[] }[]} */
export const PACKAGES = [
  {
    dir: "packages/shared",
    label: "shared",
    exclude: [
      "**/git-service.integration.test.ts",
      // Same #173 shape as the server list below: real git on temp dirs, green in isolation,
      // starved under full-suite parallelism. Measured on master 2026-08-03, isolation vs the
      // merge gate's parallel run:
      //   append-only-hotfile-merge.integration  5 passed in 316s (~63s/test) -> TIMED OUT at 240s
      //   migration-renumber-conflict-guard      2 passed in 152s (~75s/test) -> TIMED OUT at 60s
      // They were failing EVERY pre-merge gate on this repo, so the gate blocked all merges
      // while providing no signal. They run in `pnpm test:full`.
      "**/append-only-hotfile-merge.integration.test.ts",
      "**/migration-renumber-conflict-guard.test.ts",
    ],
  },
  {
    dir: "packages/server",
    label: "server",
    exclude: [
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
      "**/worker-git-transport-e2e.test.ts",
      "**/compose-lifecycle-real-docker.test.ts",
    ],
  },
  {
    dir: "packages/mcp-server",
    label: "mcp-server",
    exclude: ["**/mcp-tools.test.ts"],
  },
  {
    // #601: the client was NOT in this list, so `pnpm test:mine` — which IS what the
    // pre-merge verify gate runs — had never executed a single one of its 142 test files.
    // Every client-only change merged on server+shared+mcp evidence alone. The suite is
    // ~1.3k fast unit tests (no DB, no git, no docker) and adds well under two minutes,
    // which is a small price for the gate meaning what it claims.
    dir: "packages/client",
    label: "client",
    exclude: [],
  },
];

// Extra args after `--` (pnpm strips the first `--`; node leaves the rest in argv).
const passthrough = process.argv.slice(2);

/**
 * Optional worker cap via `KANBAN_TEST_MAX_WORKERS` (#278).
 *
 * vitest defaults to `maxWorkers = cpus/2` with `pool: "forks"` and full isolation,
 * so each fork re-transforms its own module graph. When the pre-merge verify gate
 * runs on a box that is ALSO running a dev server, other worktrees' gates and the
 * agent itself, that fan-out is self-defeating: it multiplies peak memory and
 * process-spawn pressure, which is what produced the load-dependent timeouts that
 * made gates fail and retry (#218 failed 7 times over 4 days).
 *
 * Not set = vitest's own default, so interactive `pnpm test:mine` is unchanged.
 * The gate sets it explicitly (see `pre-merge-gate.service.ts`).
 *
 * A passthrough `--maxWorkers` on the command line wins — an explicit flag from the
 * caller must never be silently overridden by an env var.
 */
const maxWorkersRaw = (process.env.KANBAN_TEST_MAX_WORKERS || "").trim();
const callerSetWorkers = passthrough.some((a) => a.startsWith("--maxWorkers"));
const workerCapArgs =
  maxWorkersRaw && /^\d+$/.test(maxWorkersRaw) && !callerSetWorkers
    ? [`--maxWorkers=${maxWorkersRaw}`]
    : [];
if (maxWorkersRaw && !/^\d+$/.test(maxWorkersRaw)) {
  console.warn(`[test:mine] ignoring non-numeric KANBAN_TEST_MAX_WORKERS="${maxWorkersRaw}"`);
}

/**
 * Resolve vitest's runnable entry for a package. pnpm hoists most deps to the
 * workspace root, but each package may also have a local copy. Prefer the local
 * one, fall back to the root.
 */
function resolveVitestEntry(pkgDir) {
  const candidates = [
    resolve(pkgDir, "node_modules/vitest/vitest.mjs"),
    resolve(ROOT, "node_modules/vitest/vitest.mjs"),
  ];
  return candidates.find((p) => existsSync(p));
}

/**
 * Test files that must run for EVERY diff that reaches their package, because what they
 * check is not reachable through the module graph (#278, classification mechanism #538).
 *
 * `vitest related <changed files>` selects tests that IMPORT the change. These suites import
 * nothing they check — they read the filesystem and assert a property of the tree: no raw git
 * spawn outside the adapter, no file over the god-module ceiling, no un-journaled migration,
 * no unregistered settings key, no `repoPath: "/repo"` in a suite that drives the real lock.
 * A change that breaks one of them is by definition a change none of their imports mention,
 * so file-level scoping would silently stop enforcing exactly the rules that exist because
 * review missed them once already.
 *
 * #538: this set used to be a hand-maintained list (9 files) — the exact failure mode it
 * exists to prevent, since a NEW tree-scanning suite is silently never added (measured: 7 of
 * #483's failure set were exactly this). It is now DERIVED by scanning each package's
 * `__tests__` directory for a top-of-file `// @gate:always-run` marker, so declaring a suite
 * always-run and actually running it always-run can't drift apart. The companion
 * `always-run-marker-ratchet.test.ts` statically re-derives the same "reaches outside its own
 * import graph" signal and fails when a matching file carries no marker — so a new guard suite
 * can't be silently unmarked either.
 *
 * Only consulted when a run is file-scoped; a full-suite run includes them anyway.
 */
const ALWAYS_RUN_MARKER = "@gate:always-run";

/** Test-file extensions the marker scan recognises. `.tsx` and `.mjs` were invisible (#647). */
const ALWAYS_RUN_TEST_FILE = /\.test\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/** The `__tests__` dir, relative to the package dir, for each entry in PACKAGES.
 *
 *  #639: `client` was missing here while `pre-merge-gate-tier.ts` DID scan
 *  `packages/client/src/__tests__` for the marker — so the gate counted the client's guard in
 *  its "+N guard suites" pass message and then structurally could not run it. Every label in
 *  PACKAGES must appear (see `buildAlwaysRunTests`, which now throws rather than skipping). */
export const ALWAYS_RUN_TESTS_DIR = {
  shared: "__tests__",
  server: "src/__tests__",
  "mcp-server": "src/__tests__",
  client: "src/__tests__",
};

/**
 * Scan `<pkgDir>/<testsDir>` for `.test.ts` files carrying the marker, returning paths
 * relative to `pkgDir` (the shape `runPackage`'s `guards` mode expects). Pure function of its
 * arguments (a directory-listing/reading pair) so it is unit-testable without touching the
 * real filesystem.
 */
export function scanAlwaysRunTests(
  pkgDir,
  testsDir,
  listDir = (d) => (existsSync(d) ? readdirSync(d, { withFileTypes: true }) : []),
  readText = (p) => readFileSync(p, "utf8"),
) {
  const found = [];
  // #647: this scan was FLAT and `.test.ts`-only. `mcp-server/src/__tests__/tools/` alone
  // holds 33 suites the walk never saw, and `test-mine-scope-derivation.test.mjs` carries the
  // marker while being structurally invisible to it. A marker that silently does nothing is
  // worse than no marker — the gate reports the guard and does not run it.
  const walk = (relDir) => {
    for (const entry of listDir(resolve(pkgDir, relDir))) {
      // Tolerate a plain-string lister (older injected test doubles) as well as Dirents.
      const name = typeof entry === "string" ? entry : entry.name;
      const isDir = typeof entry === "string" ? false : entry.isDirectory();
      const rel = `${relDir}/${name}`;
      if (isDir) {
        if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
        walk(rel);
        continue;
      }
      if (!ALWAYS_RUN_TEST_FILE.test(name)) continue;
      if (readText(resolve(pkgDir, rel)).includes(ALWAYS_RUN_MARKER)) found.push(rel);
    }
  };
  walk(testsDir);
  return found;
}

function buildAlwaysRunTests() {
  /** @type {Record<string, string[]>} */
  const map = {};
  for (const pkg of PACKAGES) {
    const testsDir = ALWAYS_RUN_TESTS_DIR[pkg.label];
    // #639: this used to `continue`, which is why the client's marked guard was silently
    // never force-run. A missing entry is a bug in this file, not a package opting out —
    // failing loudly is the only way the next added package can't repeat it.
    if (!testsDir) {
      throw new Error(
        `[test:mine] ALWAYS_RUN_TESTS_DIR has no entry for package "${pkg.label}" — ` +
          `its @gate:always-run guard suites would be silently skipped. Add one.`,
      );
    }
    map[pkg.label] = scanAlwaysRunTests(resolve(ROOT, pkg.dir), testsDir);
  }
  return map;
}

const ALWAYS_RUN_TESTS = buildAlwaysRunTests();

/**
 * File-level test scoping via `KANBAN_TEST_FILES` (comma-separated, repo-relative), the
 * gate's tier 1 (#278).
 *
 * `KANBAN_TEST_PACKAGES` is package-granular, so any diff touching `packages/server` — the
 * vast majority of board tickets — still paid the full ~4,165-test server suite. This narrows
 * that to `vitest related <the files the diff actually changed>`, which is dependency-aware:
 * vitest walks its own module graph and selects every suite that imports the change, directly
 * or transitively.
 *
 * Scoping applies only to a package the diff OWNS files in. A package that is in scope purely
 * as a downstream DEPENDENT (or via ALWAYS_RUN) has no changed files of its own to relate to,
 * and `vitest related` with someone else's paths would select nothing — so those packages
 * keep running their full suite. Same fail-open discipline as the package scope: unset, or a
 * value naming no file in a package, means "run everything for that package".
 */
const fileScopeRaw = (process.env.KANBAN_TEST_FILES || "").trim();
const scopedFiles = fileScopeRaw
  ? fileScopeRaw.split(",").map((s) => s.trim().replace(/\\/g, "/")).filter(Boolean)
  : [];

/**
 * The changed files under a package, as paths relative to that package's directory.
 *
 * Pure function of its arguments (no module-level state) so it is unit-testable in isolation —
 * `files` defaults to the `KANBAN_TEST_FILES`-derived `scopedFiles` and `exists` to a real
 * filesystem check, but a test can inject both.
 */
export function ownedChangedFiles(pkgDir, files = scopedFiles, exists = (p) => existsSync(resolve(ROOT, p))) {
  const prefix = `${pkgDir.replace(/\\/g, "/")}/`;
  return files
    .filter((f) => f.startsWith(prefix))
    .map((f) => f.slice(prefix.length))
    // A deleted file cannot be related to anything and makes `vitest related` error out.
    .filter((rel) => exists(`${pkgDir}/${rel}`));
}

/**
 * Packages whose OWN vitest config resolves `@agentic-kanban/shared` to the shared package's
 * `src/` directly (both do — `vitest.config.ts` aliases it), so `vitest related` run from that
 * package can walk straight through the alias into a shared source file (#537 leak A).
 *
 * Without this, a `packages/shared`-only diff expands to server/mcp-server as DOWNSTREAM
 * dependents (`changed-packages.ts`), but `ownedChangedFiles` only matches files under a
 * package's own directory — so server/mcp-server own nothing changed and fall back to their
 * full suites even though shared is the most frequently touched package (imported by
 * `git-service`, `settings-registry`, `ticket-context`, ...).
 */
export const UPSTREAM_DEPENDENCIES = {
  server: ["packages/shared"],
  "mcp-server": ["packages/shared"],
};

/**
 * Changed files owned by an UPSTREAM package this package depends on, given as ABSOLUTE paths
 * (resolved against `root`) — `vitest related` resolves them through the alias regardless of
 * which package's cwd it runs from, as long as the path is one vitest can stat.
 *
 * Pure function of its arguments so it is unit-testable without touching the real filesystem.
 */
export function upstreamChangedFiles(
  label,
  files = scopedFiles,
  exists = (p) => existsSync(resolve(ROOT, p)),
  root = ROOT,
) {
  const upstreamDirs = UPSTREAM_DEPENDENCIES[label] ?? [];
  const result = [];
  for (const upstreamDir of upstreamDirs) {
    for (const rel of ownedChangedFiles(upstreamDir, files, exists)) {
      result.push(resolve(root, upstreamDir, rel));
    }
  }
  return result;
}

function runPackage({ dir, label, exclude }, mode = null) {
  return new Promise((resolvePromise) => {
    const pkgDir = resolve(ROOT, dir);
    const vitestEntry = resolveVitestEntry(pkgDir);
    if (!vitestEntry) {
      console.error(
        `[test:mine] ${label}: could not find vitest. Run \`pnpm install\` first.`
      );
      resolvePromise(1);
      return;
    }
    const excludeArgs = exclude.flatMap((glob) => ["--exclude", glob]);
    const modeArgs = mode?.kind === "related"
      ? ["related", ...mode.files, "--run", "--passWithNoTests"]
      : mode?.kind === "guards"
        ? ["run", ...mode.files, "--passWithNoTests"]
        : ["run"];
    const args = [vitestEntry, ...modeArgs, ...excludeArgs, ...workerCapArgs, ...passthrough];
    console.log(
      `\n[test:mine] ${label}: node vitest ${[...modeArgs, ...excludeArgs, ...workerCapArgs, ...passthrough].join(" ")}`
    );
    // No shell — pass argv as an array so globs reach vitest verbatim (vitest does
    // its own glob matching; the OS shell must NOT expand them). cwd = package dir
    // so vitest picks up that package's vitest.config.ts.
    //
    // #643: a `related` run carries `--passWithNoTests`, so a changed file that NO test
    // imports (a config, a .sql, an asset, or a module nobody covers) exits 0 having asserted
    // nothing — and the gate then reports "passed (tier: file-scoped, N changed files)". The
    // run is therefore TEE'd rather than inherited: output still streams live, and we can also
    // see whether vitest selected anything. `selectedNothing` is what the caller uses to fall
    // back to the package suite instead of banking a green from an empty run.
    const tee = mode?.kind === "related";
    const child = spawn(process.execPath, args, {
      cwd: pkgDir,
      stdio: tee ? ["inherit", "pipe", "pipe"] : "inherit",
      windowsHide: true,
    });
    let sawNoTestFiles = false;
    if (tee) {
      const watch = (stream, sink) => {
        stream.on("data", (chunk) => {
          sink.write(chunk);
          if (/No test files found/i.test(chunk.toString())) sawNoTestFiles = true;
        });
      };
      watch(child.stdout, process.stdout);
      watch(child.stderr, process.stderr);
    }
    child.on("exit", (code) => resolvePromise({ code: code ?? 1, selectedNothing: sawNoTestFiles }));
    child.on("error", (err) => {
      console.error(`[test:mine] ${label} failed to start:`, err);
      resolvePromise({ code: 1, selectedNothing: false });
    });
  });
}

/** Extensions whose change SHOULD be covered by some test — the ones worth falling back for. */
const SOURCE_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs)$/i;

/**
 * Run a package's file-scoped `related` selection, falling back to its FULL suite when that
 * selection turned out to be empty for a real source change (#643).
 *
 * "Empty selection" is not a pass: `vitest related` selects by import graph, so a source file
 * nobody imports — or imports only through a mechanism vitest cannot see — yields zero tests
 * and a green exit. Falling back for source files keeps the cheap case cheap (a .sql/.json/
 * asset change still selects nothing and still costs nothing) while refusing to bank a green
 * from a run that asserted nothing about code.
 */
async function runRelatedWithFallback(pkg, files) {
  const { code, selectedNothing } = await runPackage(pkg, { kind: "related", files });
  if (!selectedNothing) return code;
  const sourceChanges = files.filter((f) => SOURCE_EXTENSIONS.test(f));
  if (sourceChanges.length === 0) {
    console.log(
      `[test:mine] ${pkg.label}: 0 tests selected for ${files.length} changed file(s) — none are source files, nothing to fall back to.`
    );
    return code;
  }
  console.warn(
    `[test:mine] ${pkg.label}: 0 tests selected for ${sourceChanges.length} changed SOURCE file(s) — ` +
      `a green here would assert nothing. Falling back to the package's full suite.`
  );
  return runPackage(pkg).then((r) => r.code);
}

/**
 * Optional package scoping via `KANBAN_TEST_PACKAGES` (comma-separated labels, e.g.
 * "shared,server").
 *
 * Set by the pre-merge gate (`pre-merge-gate.service.ts`) when it can prove from the diff
 * which workspace packages a branch touches. A client-only ticket then skips the ~507
 * server+mcp test files instead of paying for them, which is the difference between a
 * ~40-minute gate and a few minutes.
 *
 * Deliberately opt-IN and fail-open: an unset or unrecognised value runs everything, so a
 * plain `pnpm test:mine` and any caller that cannot determine scope are unaffected. The
 * gate only ever passes a scope it derived conservatively — see `scopedTestPackages`.
 */
const scopeRaw = (process.env.KANBAN_TEST_PACKAGES || "").trim();
const scopeLabels = scopeRaw ? new Set(scopeRaw.split(",").map((s) => s.trim()).filter(Boolean)) : null;
const selected = scopeLabels ? PACKAGES.filter((p) => scopeLabels.has(p.label)) : PACKAGES;
if (scopeLabels && selected.length === 0) {
  console.warn(`[test:mine] KANBAN_TEST_PACKAGES="${scopeRaw}" matched no known package — running ALL packages instead of silently testing nothing.`);
}
const toRun = selected.length > 0 ? selected : PACKAGES;
if (scopeLabels && toRun !== PACKAGES) {
  console.log(`[test:mine] scoped to: ${toRun.map((p) => p.label).join(", ")} (KANBAN_TEST_PACKAGES)`);
}

// Guarded so this file can be `import`ed (e.g. by unit tests exercising the pure functions
// above) without spawning real vitest processes. `pnpm test:mine` runs this file directly, so
// `process.argv[1]` is its own path in that case.
if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  let failed = false;
  for (const pkg of toRun) {
    const owned = scopedFiles.length > 0 ? ownedChangedFiles(pkg.dir) : [];
    let relatedFiles = owned;
    if (owned.length === 0 && scopedFiles.length > 0) {
      // Nothing of THIS package's own files changed — it may still be in scope purely as a
      // downstream dependent (e.g. server/mcp-server pulled in by a shared-only diff). Relate
      // against the upstream package's changed files instead of falling back to the full suite.
      const upstream = upstreamChangedFiles(pkg.label);
      if (upstream.length > 0) {
        console.log(`\n[test:mine] ${pkg.label}: no own changes; file-scoped to ${upstream.length} upstream changed file(s)`);
        if (await runRelatedWithFallback(pkg, upstream) !== 0) failed = true;
        const guards = (ALWAYS_RUN_TESTS[pkg.label] ?? []).filter((f) => existsSync(resolve(ROOT, pkg.dir, f)));
        if (guards.length > 0 && (await runPackage(pkg, { kind: "guards", files: guards })).code !== 0) failed = true;
        continue;
      }
    }
    if (relatedFiles.length === 0) {
      // Nothing of this package changed (or no file scope at all) — full suite, as before.
      if ((await runPackage(pkg)).code !== 0) failed = true;
      continue;
    }
    console.log(`\n[test:mine] ${pkg.label}: file-scoped to ${relatedFiles.length} changed file(s) (KANBAN_TEST_FILES)`);
    if (await runRelatedWithFallback(pkg, relatedFiles) !== 0) failed = true;
    const guards = (ALWAYS_RUN_TESTS[pkg.label] ?? []).filter((f) => existsSync(resolve(ROOT, pkg.dir, f)));
    if (guards.length > 0 && (await runPackage(pkg, { kind: "guards", files: guards })).code !== 0) failed = true;
  }

  if (failed) {
    console.error("\n[test:mine] One or more packages had failing tests.");
    process.exit(1);
  }
  console.log("\n[test:mine] All reliable suites passed.");
}

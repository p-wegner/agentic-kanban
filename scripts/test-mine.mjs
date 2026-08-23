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
//     - done-unmerged-invariant-sweep.test.ts, workspace-merge-service.test.ts,
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

import { spawn, execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

/**
 * An exclusion must say WHY it is one (#679).
 *
 * `ae6de9b34d` pointed the verify gate at `test:mine` and, in the SAME commit, added 12
 * exclusions to it — the gate was made cheap and simultaneously blinded to the suites
 * guarding what it protects. Nothing recorded which of those were environmental (real git,
 * a real docker daemon, a spawned CLI — the #173 shape the mechanism exists for) and which
 * were merely slow, so the list could only grow, and re-auditing it meant re-deriving every
 * entry from scratch. Six had no environmental excuse at all.
 *
 * A `{ glob, reason }` pair makes the argument part of the entry rather than a comment that
 * drifts away from it, and `exclusion-reasons.test.ts` fails on a missing or boilerplate one.
 * The rule the reasons are judged against: an exclusion is legitimate when the suite needs
 * something the gate box may not have or cannot share — a real `git` process, a docker
 * daemon, a spawned CLI binary. "It is slow" is not a reason; scope it or speed it up.
 *
 * @type {{ dir: string, label: string, exclude: { glob: string, reason: string }[] }[]}
 */
export const PACKAGES = [
  {
    dir: "packages/shared",
    label: "shared",
    exclude: [
      {
        glob: "**/git-service.integration.test.ts",
        reason: "drives real `git` processes against temp repos",
      },
      // Same #173 shape: real git on temp dirs, green in isolation, starved under full-suite
      // parallelism. Measured on master 2026-08-03, isolation vs the merge gate's parallel run:
      //   append-only-hotfile-merge.integration  5 passed in 316s (~63s/test) -> TIMED OUT at 240s
      //   migration-renumber-conflict-guard      2 passed in 152s (~75s/test) -> TIMED OUT at 60s
      // They were failing EVERY pre-merge gate on this repo, so the gate blocked all merges
      // while providing no signal. They run in `pnpm test:full`.
      {
        glob: "**/append-only-hotfile-merge.integration.test.ts",
        reason: "real git on temp dirs; ~63s/test in isolation and times out under gate parallelism",
      },
      {
        glob: "**/migration-renumber-conflict-guard.test.ts",
        reason: "real git on temp dirs; ~75s/test in isolation and times out under gate parallelism",
      },
    ],
  },
  {
    dir: "packages/server",
    label: "server",
    // #679 RE-INCLUDED seven suites (193 tests) that were excluded with no environmental
    // excuse: workspace-merge-service, done-unmerged-invariant-sweep, preferences,
    // workspace-lifecycle-transitions, merge-service-edge-cases, merge-endpoint-reconcile-noop,
    // workspace-already-merged. They run on in-memory SQLite with an injected `gitService`;
    // the ones that touch `helpers/temp-repo.ts` only need a directory with a `.git` inside so
    // the repo lock accepts it — that helper deliberately never runs `git init`. Measured
    // together on master: 193 tests, ~78s wall. What their absence let through: re-breaking
    // conflict-marker spillover (#598-600), reintroducing the 0-commit false-positive Done,
    // breaking merge-retry idempotency, breaking `resolveMergeState`'s decision table — each
    // already shipped once as a bug, each covered by a test that did not run.
    exclude: [
      { glob: "**/cli.test.ts", reason: "spawns the CLI binary as a child process" },
      { glob: "**/cli-butler.test.ts", reason: "spawns the CLI binary as a child process" },
      { glob: "**/git.service.test.ts", reason: "drives real `git` processes against temp repos" },
      {
        glob: "**/api-workspace.test.ts",
        reason: "execFileSync(\"git\", ...) — really runs git init/add/commit per case",
      },
      {
        glob: "**/worker-git-transport-e2e.test.ts",
        reason: "end-to-end git smart-HTTP transport over a real server and real clones",
      },
      {
        glob: "**/compose-lifecycle-real-docker.test.ts",
        reason: "needs a real docker daemon; pulls and builds images",
      },
    ],
  },
  {
    dir: "packages/mcp-server",
    label: "mcp-server",
    exclude: [
      { glob: "**/mcp-tools.test.ts", reason: "spawns the MCP server as a child process" },
    ],
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
 * Guards-only mode (`KANBAN_TEST_GUARDS_ONLY=1`): run ONLY the marker-derived guard suites,
 * every package, nothing else.
 *
 * Exists because the pre-merge gate's docs-only skip sat UPSTREAM of the always-run
 * mechanism: a markdown-only diff skipped `verify_script` wholesale, so the suites explicitly
 * marked "must run even when the gate scopes" were not run at all — and ~16 of them take
 * markdown as their assertion INPUT (`CLAUDE.md`, `docs/env-vars.md`, the `.claude`/`.codex`
 * `SKILL.md` pairs). It already fired: a `SKILL.md`-only branch merged green through the gate
 * and left master red on `codex-skills-parity`, the guard that exists to catch that drift.
 *
 * Deliberately NOT expressible as `KANBAN_TEST_FILES=<the .md files>`: markdown at the repo
 * root is owned by no package, so file scoping resolves to "no own changes" and falls back to
 * the FULL suite — the opposite of the cheap check a docs diff warrants. The guard set is the
 * same declared one (`@gate:always-run`), so this mode cannot drift from what the gate forces
 * to run.
 */
const guardsOnly = /^(1|true|yes)$/i.test((process.env.KANBAN_TEST_GUARDS_ONLY || "").trim());

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
    const excludeArgs = exclude.flatMap(({ glob }) => ["--exclude", glob]);
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

/** Normalise a path for comparison — vitest reports Windows paths with backslashes. */
const slash = (p) => p.replace(/\\/g, "/");

/** Load vitest's node API from the package's own resolution root. */
function defaultVitestLoader(pkgDir) {
  const req = createRequire(resolve(pkgDir, "package.json"));
  return import(pathToFileURL(req.resolve("vitest/node")).href);
}

/**
 * Opt-out for the per-file coverage probe below (`KANBAN_TEST_NO_COVERAGE_PROBE=1`). The probe
 * fails open on its own, so this exists for the case where it works but is not wanted — e.g.
 * a caller that has already decided to run the full suite anyway.
 */
const coverageProbeDisabled = /^(1|true|yes)$/i.test(
  (process.env.KANBAN_TEST_NO_COVERAGE_PROBE || "").trim(),
);

/**
 * Which of the changed files at least one test suite in this package actually imports (#762).
 *
 * WHY this exists, measured 2026-08-23 (the #762 investigation asked what the gate verifies for
 * `shared` and `mcp-server`, both at 98% rework):
 *
 *   packages/shared/src/types/api.ts        -> 0 suites, in shared AND in server
 *   packages/shared/src/lib/ticket-context.ts -> 0 suites in shared
 *   packages/shared/src/lib/changed-packages.ts -> 1 suite
 *   packages/shared/src/lib/git-service.ts  -> 9 in shared, 429 in server
 *
 * `vitest related` walks the TRANSFORMED module graph, so a type-only module (`export interface
 * ...`) is erased before the graph is built and can never be selected. #643's fallback caught
 * that only when the WHOLE run selected nothing — so a two-file diff of `types/api.ts` +
 * `lib/changed-packages.ts` selects exactly one suite (`changed-packages.test.ts`), the run is
 * not empty, no fallback fires, and the gate reports "passed (tier: file-scoped, 2 changed
 * file(s))" having asserted nothing whatsoever about `types/api.ts`. Verified by measurement,
 * not by reading: that diff really does select 1.
 *
 * The fix is to apply #643's own rule PER FILE instead of per run. This computes the mapping
 * with vitest's OWN machinery (`globTestSpecifications` + `getTestDependencies`, the two calls
 * `related` itself is built from), so it cannot disagree with what the subsequent `related`
 * spawn will select.
 *
 * Fails OPEN: any error returns `null`, which leaves the pre-existing whole-run fallback as the
 * only check — a narrower gate must never be the consequence of this probe breaking.
 *
 * Stops as soon as every target is accounted for, so the common case (every changed file is
 * imported by some suite) costs a handful of dependency walks rather than the whole graph. The
 * expensive case is the one that then runs the full suite anyway.
 *
 * @returns `{ [absolutePath]: boolean }`, or `null` when it could not be determined.
 */
export async function relatedCoverageByFile(pkgDir, files, loadVitest = defaultVitestLoader) {
  const targets = files.map((f) => slash(resolve(pkgDir, f)));
  if (targets.length === 0) return {};
  /** @type {Record<string, boolean>} */
  const covered = Object.fromEntries(targets.map((t) => [t, false]));
  const cwd = process.cwd();
  let vitest;
  try {
    const { createVitest } = await loadVitest(pkgDir);
    // vitest resolves its config relative to cwd, the same way the `related` spawn does.
    process.chdir(pkgDir);
    vitest = await createVitest("test", {
      watch: false,
      run: true,
      passWithNoTests: true,
      reporters: [],
    });
    const specs = await vitest.specifications.globTestSpecifications();
    let remaining = targets.length;
    for (const spec of specs) {
      const id = slash(spec.moduleId);
      const deps = new Set([...(await vitest.specifications.getTestDependencies(spec))].map(slash));
      for (const target of targets) {
        if (covered[target]) continue;
        if (target === id || deps.has(target)) {
          covered[target] = true;
          remaining -= 1;
        }
      }
      if (remaining === 0) break;
    }
    return covered;
  } catch (err) {
    console.warn(
      `[test:mine] could not derive per-file test coverage for ${pkgDir} (${err?.message ?? err}) — ` +
        `falling back to the whole-run emptiness check only.`,
    );
    return null;
  } finally {
    process.chdir(cwd);
    try {
      await vitest?.close?.();
    } catch {
      /* a probe that cannot shut down cleanly must not fail the run */
    }
  }
}

/**
 * The changed SOURCE files that no suite imports — the ones a file-scoped green would say
 * nothing about. `null` in means `null` out (coverage undetermined, so no claim either way).
 *
 * Pure function of its argument so the rule is unit-testable without booting vitest.
 */
export function uncoveredSourceFiles(coverage) {
  if (!coverage) return null;
  return Object.entries(coverage)
    .filter(([file, isCovered]) => !isCovered && SOURCE_EXTENSIONS.test(file))
    .map(([file]) => file);
}

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
  // #762: per-FILE emptiness first — see `relatedCoverageByFile`. A run that selects some
  // suites can still be selecting none for one of the changed files.
  const uncovered = coverageProbeDisabled
    ? null
    : uncoveredSourceFiles(await relatedCoverageByFile(resolve(ROOT, pkg.dir), files));
  if (uncovered && uncovered.length > 0) {
    console.warn(
      `[test:mine] ${pkg.label}: ${uncovered.length} of ${files.length} changed file(s) are imported by NO ` +
        `suite in this package, so a file-scoped run would assert nothing about them:\n` +
        uncovered.map((f) => `  - ${f}`).join("\n") +
        `\n[test:mine] ${pkg.label}: running the package's full suite instead.`,
    );
    return runPackage(pkg).then((r) => r.code);
  }
  if (uncovered) {
    console.log(
      `[test:mine] ${pkg.label}: every changed file (${files.length}) is imported by at least one suite — file-scoping is safe here.`,
    );
  }
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

/* ---------------------------------------------------------------------------
 * Working-tree hermeticity (#680)
 *
 * The static half of this lives in `packages/shared/__tests__/test-tree-write-hermeticity.test.ts`,
 * which fails any `fs` write in a TEST whose destination is anchored to this checkout. That
 * cannot see the other door: a suite that SPAWNS something which writes — a generator, a hook
 * script, a scaffolded runner given `cwd: REPO_ROOT`. #814's leak came out of exactly such a
 * subprocess, and the symptom is #680's: the repo-scanning `@gate:always-run` suites walk the
 * tree while another suite mutates it, so the gate goes red under load and green in isolation.
 * It also silently withholds every board-wide merge, because auto-merge refuses to land while
 * the main checkout has a dirty tracked file.
 *
 * So: snapshot `git status` around the run and NAME what changed.
 *
 * Reporting, not failing, by default — and that is deliberate rather than timid. Several agents
 * share this checkout, so a path that changed during the run is not proof the run changed it,
 * and a gate that fails on a neighbour's edit is a worse version of the flakiness this ticket
 * exists to remove. On a dedicated runner set `KANBAN_TEST_HERMETIC=strict`, where the
 * attribution IS sound and the drift should fail the run.
 * ------------------------------------------------------------------------- */

const hermeticMode = (process.env.KANBAN_TEST_HERMETIC || "report").trim().toLowerCase();

/** `path -> status code`, or `null` when git cannot answer (not a checkout, no git on PATH). */
export function treeSnapshot() {
  try {
    // Raw `git` on purpose: this script runs as bare `node scripts/test-mine.mjs` with no
    // guarantee that packages/shared is built, so it cannot import the git-exec adapter.
    const out = execFileSync("git", ["status", "--porcelain", "-z"], {
      cwd: ROOT, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
    });
    const entries = new Map();
    for (const record of out.split("\0")) {
      if (record.length < 4) continue;
      entries.set(record.slice(3), record.slice(0, 2));
    }
    return entries;
  } catch {
    return null;
  }
}

/** Paths whose git status is not what it was before the run. Empty when nothing drifted. */
export function treeDrift(before, after) {
  if (!before || !after) return [];
  const drifted = [];
  for (const [file, status] of after) {
    const was = before.get(file);
    if (was !== status) drifted.push(`${status} ${file}${was ? `  (was "${was}")` : ""}`);
  }
  for (const [file, status] of before) {
    if (!after.has(file)) drifted.push(`   ${file}  (was "${status}", now clean)`);
  }
  return drifted.sort();
}

/** Print the drift; returns true when the run should be failed for it. */
function reportTreeDrift(before) {
  const drifted = treeDrift(before, treeSnapshot());
  if (drifted.length === 0) return false;
  const strict = /^(1|true|yes|strict)$/i.test(hermeticMode);
  const how = strict ? "error" : "warn";
  console[how](`\n[test:mine] the working tree changed during this run (${drifted.length} path(s)):`);
  for (const line of drifted) console[how](`  ${line}`);
  console[how](
    "  A test that writes into this checkout makes the repo-scanning guard suites see a moving\n" +
    "  tree under parallelism (#680), and a dirty tracked file withholds every auto-merge (#814).\n" +
    "  If this run owns those paths, write into os.tmpdir() instead. If another agent sharing this\n" +
    "  checkout owns them, this line is noise — set KANBAN_TEST_HERMETIC=strict on a dedicated\n" +
    "  runner to make it fail there, where the attribution is sound.",
  );
  return strict;
}

// Guarded so this file can be `import`ed (e.g. by unit tests exercising the pure functions
// above) without spawning real vitest processes. `pnpm test:mine` runs this file directly, so
// `process.argv[1]` is its own path in that case.
if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  let failed = false;
  const treeBefore = treeSnapshot();
  if (guardsOnly) {
    // Every package's guard suites, and only those. A package with no marked suite is skipped
    // rather than falling through to its full suite.
    const planned = PACKAGES.map((pkg) => ({
      pkg,
      guards: (ALWAYS_RUN_TESTS[pkg.label] ?? []).filter((f) => existsSync(resolve(ROOT, pkg.dir, f))),
    })).filter((entry) => entry.guards.length > 0);
    const total = planned.reduce((n, entry) => n + entry.guards.length, 0);
    console.log(`\n[test:mine] guards-only mode (KANBAN_TEST_GUARDS_ONLY): ${total} @gate:always-run suite(s) across ${planned.length} package(s)`);
    if (total === 0) {
      // Fail loudly rather than reporting a green that checked nothing — the whole point of
      // this mode is that SOMETHING ran.
      console.error("[test:mine] guards-only mode found no @gate:always-run suites — refusing to report a green that checked nothing.");
      process.exit(1);
    }
    for (const { pkg, guards } of planned) {
      if ((await runPackage(pkg, { kind: "guards", files: guards })).code !== 0) failed = true;
    }
    if (reportTreeDrift(treeBefore)) failed = true;
    if (failed) {
      console.error("\n[test:mine] One or more guard suites failed.");
      process.exit(1);
    }
    console.log("\n[test:mine] All guard suites passed.");
    process.exit(0);
  }
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

  if (reportTreeDrift(treeBefore)) failed = true;
  if (failed) {
    console.error("\n[test:mine] One or more packages had failing tests.");
    process.exit(1);
  }
  console.log("\n[test:mine] All reliable suites passed.");
}

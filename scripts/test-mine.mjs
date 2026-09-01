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
//
// Selectors (#951): `KANBAN_TEST_SELECTOR=impact` picks the suites with the test-impact skill's
// multi-signal ranking instead of `vitest related`. OPT-IN and fail-open — see the block near
// `runImpactSelector` below. When `KANBAN_TEST_FILES` is ALSO set the two are UNIONED rather than
// one replacing the other (#967): the related suites are derived and handed to `select --union`,
// where they are exempt from the score floor but still counted against the budget.

import { spawn, spawnSync, execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, relative, resolve } from "node:path";
import {
  acquireForBuilderTest,
  MACHINE_LOCK_HEARTBEAT_INTERVAL_MS,
} from "./machine-verify-lock.mjs";

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

/**
 * The marker, matched as a DECLARATION rather than as a substring (#891).
 *
 * This was `source.includes(ALWAYS_RUN_MARKER)`, which cannot tell a marker from a sentence
 * about markers, or from the string used as data. Two suites were force-run on that basis, and
 * they were the two that guard this very mechanism: `guard-suite-count.test.ts` (which holds the
 * marker in a `const MARKER` fixture) and `test-mine-scope-derivation.test.mjs` (whose fixture
 * text exists to assert that a NON-test file carrying the marker is ignored). The scanner was
 * matching a string whose whole purpose is to describe what it should skip.
 *
 * Benign in outcome — both arguably should always run — but load-bearing for the wrong reason:
 * rewriting that constant as `"// @gate:" + "always-run"`, or moving the fixture into a JSON
 * file, silently drops the marker mechanism's own guards out of every gate, with no test to fail
 * on it. That is what this file already warns about at #647: "a marker that silently does
 * nothing is worse than no marker".
 *
 * Line- and comment-anchored, \b-terminated so the house style of a trailing rationale
 * (`// @gate:always-run - reads the tree...`) still matches.
 */
const ALWAYS_RUN_MARKER_RE = /^\s*\/\/\s*@gate:always-run\b/m;

/**
 * Does `source` DECLARE itself always-run?
 *
 * The single definition of that rule for everything that CAN import this file. It deliberately
 * does NOT live in `packages/shared`: this script is run by bare `node` from the repo root with
 * no build step and imports only Node built-ins, so reaching into a workspace package would make
 * the test runner depend on a built `packages/shared/dist` — which worktrees do not have. A
 * runner that cannot run until something is built is a bootstrap problem, and the drift this
 * fixes is not worth trading for it.
 *
 * `pre-merge-gate-tier.ts` cannot import it either — `packages/server` ships only `dist/`, so a
 * published install importing a repo-root script would crash on load. It keeps a deliberate
 * mirror, and `always-run-dirs-lockstep.test.ts` holds the two to the same RULE with fixtures
 * rather than to the same TEXT by comment. Six copies became two bound by an executable check;
 * do not "finish the job" by importing this from shipped server code.
 */
export function isAlwaysRunMarked(source) {
  return ALWAYS_RUN_MARKER_RE.test(source);
}

/** Test-file extensions the marker scan recognises. `.tsx` and `.mjs` were invisible (#647). */
export const ALWAYS_RUN_TEST_FILE = /\.test\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

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
      if (isAlwaysRunMarked(readText(resolve(pkgDir, rel)))) found.push(rel);
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
 * Flake-retry mode (`KANBAN_RETRY_TEST_FILES=pkg:file,pkg:file`): run EXACTLY these suites and
 * nothing else (#894).
 *
 * Why its own variable rather than reusing `KANBAN_TEST_FILES`: that one takes CHANGED SOURCE
 * files and derives their related tests via `vitest related`. Handing it a test-file path asks
 * "what tests relate to this test", which is not the question — and for a suite that imports
 * nothing it checks (every guard/ratchet/scanner) the answer is "nothing", so the retry would
 * silently run an empty set and report green.
 *
 * The package label is part of each entry because vitest runs with the PACKAGE as its cwd, so
 * a bare `src/__tests__/x.test.ts` is ambiguous — every package has one.
 *
 * Motivation: the gate ran the full 7,183-test suite fifteen times on one workspace, failing
 * each time on ~3 timing-shaped tests that pass in ~22s when re-run on a quiet box. See
 * `packages/server/src/services/verify-flake-retry.ts` for the measurement and the guard rails.
 */
export function parseRetryScope(raw) {
  const out = new Map();
  for (const entry of (raw || "").split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(":");
    // No label means we cannot know which package's cwd the path is relative to. Skipping is
    // the safe read: a wrong guess runs a DIFFERENT file and reports a green for it.
    if (idx <= 0) continue;
    const label = trimmed.slice(0, idx).trim();
    const file = trimmed.slice(idx + 1).trim().replace(/\\/g, "/");
    if (!label || !file) continue;
    if (!out.has(label)) out.set(label, []);
    const files = out.get(label);
    if (!files.includes(file)) files.push(file);
  }
  return out;
}

const retryScope = parseRetryScope(process.env.KANBAN_RETRY_TEST_FILES);

/* ---------------------------------------------------------------------------
 * Impact selector (`KANBAN_TEST_SELECTOR=impact`, #951)
 *
 * OPT-IN, and deliberately NOT the default until #954 has produced a measured miss rate —
 * a selector with no miss rate is a guess, and this one NARROWS a merge gate.
 *
 * Why: the `KANBAN_TEST_FILES` path scopes with `vitest related`, which sees only the import
 * graph and, on an empty selection, falls back to the package's FULL suite
 * (`runRelatedWithFallback`) — ~4,165 tests for `packages/server`. The test-impact skill scores
 * the same change from several independent signals (import reach, name affinity, git change-set
 * coupling, runtime coverage, failure history), ranks them, and never returns a silent empty set.
 *
 * We ask it for `--format pkgfile`, which emits `<packageDir>:<path relative to that package>`
 * per line — the same `label:file` shape `parseRetryScope` already consumes, so this runner never
 * re-derives package ownership. (The prefix is the package DIRECTORY, so it is mapped back to a
 * PACKAGES label here; an unknown directory is dropped loudly rather than guessed at.)
 *
 * Every existing guard rail is kept:
 *   - the `@gate:always-run` top-up still runs, per package;
 *   - vitest still runs per package with that package's dir as cwd;
 *   - it FAILS OPEN — selector unset, skill not installed, non-zero exit, or an empty selection
 *     all fall back to today's `vitest related` behaviour, LOUDLY.
 * ------------------------------------------------------------------------- */

const testSelector = (process.env.KANBAN_TEST_SELECTOR || "").trim().toLowerCase();
const impactSelectorRequested = testSelector === "impact";
if (testSelector && !impactSelectorRequested) {
  console.warn(
    `[test:mine] unknown KANBAN_TEST_SELECTOR="${testSelector}" — the only supported value is "impact". ` +
      `Using the default \`vitest related\` scoping.`,
  );
}

/**
 * Minimum impact score a suite must reach to be selected (`KANBAN_TEST_MIN_SCORE`, default 1.0).
 *
 * The measured shape on this repo (2026-08-30): a one-file change scores a handful of suites at
 * 1.00 and then has a long tail tied at ~0.14. `--min-score 1.0` is the floor that keeps the
 * head and drops the tail — 6 files in 0.39 s, versus 20 for a 60 s budget.
 */
const impactMinScoreRaw = (process.env.KANBAN_TEST_MIN_SCORE || "1.0").trim();
const impactMinScore = /^\d+(\.\d+)?$/.test(impactMinScoreRaw) ? impactMinScoreRaw : "1.0";
if (impactSelectorRequested && impactMinScoreRaw !== impactMinScore) {
  console.warn(
    `[test:mine] ignoring non-numeric KANBAN_TEST_MIN_SCORE="${impactMinScoreRaw}" — using ${impactMinScore}.`,
  );
}

/**
 * Wall-clock ceiling for the selected suites (`KANBAN_TEST_BUDGET`, e.g. `60s`, #966).
 *
 * This is the per-project `test_impact_budget_<id>` setting, exported by the board into both the
 * merge gate's verify run and the builder's own loop. It composes with the score floor and the
 * ORDER is the contract: `impact.mjs` applies `--min-score` first (an evidence floor) and
 * `--budget` second (fill the remaining time with the highest-scoring survivors). Reversing them
 * would spend the clock on weakly-implicated suites before strongly-implicated ones.
 *
 * Since the map carries MEASURED durations (#955) this denominates in real seconds; before that
 * it was a files x 3s estimate, which is why the same `60s` used to mean ~20 files and now means
 * ~360. A value the tool cannot parse is DROPPED rather than defaulted: a default budget would
 * silently narrow the run on a typo, which is the one failure direction that can hide a break.
 * (The board validates the setting on write — see `shared/lib/test-impact-budget.ts` — so this
 * guard only fires for a value edited around the API or exported by hand.)
 */
const impactBudgetRaw = (process.env.KANBAN_TEST_BUDGET || "").trim();
const impactBudget = /^\d+(\.\d+)?(ms|s)?$/i.test(impactBudgetRaw) ? impactBudgetRaw : "";
if (impactBudgetRaw && !impactBudget) {
  console.warn(
    `[test:mine] ignoring unparseable KANBAN_TEST_BUDGET="${impactBudgetRaw}" — expected e.g. "60s" or "90000ms" ` +
      `(a bare number is ms; "m" is NOT a unit the selector understands — spell minutes in seconds). ` +
      `Running the selection with NO time budget.`,
  );
}

/**
 * Whether to pass `--rebuild-if-stale` (`KANBAN_IMPACT_REBUILD=1`, default OFF).
 *
 * The ticket's first draft had this always-on. It is wrong here, and measured so: the skill's
 * `findRoot()` resolves via `git rev-parse --show-toplevel`, which keeps a WORKTREE a worktree,
 * so a rebuild writes a worktree-LOCAL `docs/tests/impact-map.json`. That map helps nobody, it
 * lands in the branch diff (and immediately trips this file's own hermeticity report, which is
 * how it was caught), and it breaks the single-writer property #952's freshness work depends on.
 *
 * Keeping the map fresh is #952's job, on the MAIN checkout. A stale map here is not silent —
 * the skill says `[inventory STALE]` and widens to the package tier, and that line is echoed.
 */
const impactRebuildIfStale = /^(1|true|yes)$/i.test((process.env.KANBAN_IMPACT_REBUILD || "").trim());

/**
 * The base ref the selection computes its change set against (`KANBAN_IMPACT_BASE`, #956).
 *
 * WITHOUT IT THE SELECTION SEES NOTHING AT GATE TIME, and that failure is silent. `impact.mjs`'s
 * `changedFiles(base)` only consults `base...HEAD` when a base is given; its other two sources are
 * `git diff HEAD` and untracked files, both empty on the clean, fully-committed tree the pre-merge
 * gate runs against. The selection then degrades to the constant always-run set — identical for
 * every branch — while still reporting itself as a selection. That is exactly #963, which had to be
 * fixed on the ledger side for the same reason.
 *
 * The interactive `pnpm test:mine` case is the opposite and is why this is not simply always `HEAD`
 * or the default branch: a developer's uncommitted work IS the change set, and passing a base there
 * would replace it with "everything committed since the base". So: unset (the inner loop) keeps
 * today's uncommitted-work behaviour; the gate sets it to the workspace's base branch.
 *
 * **Positional, never `--base`.** `cmdSelect` reads `positional[0]` and ignores a `--base` flag
 * entirely — getting that backwards is what made #963's first fix inert.
 */
const impactBase = (process.env.KANBAN_IMPACT_BASE || "").trim();

/**
 * Test files the run must include REGARDLESS of what the selection ranked (`KANBAN_TEST_NEW_FILES`,
 * comma-separated, repo-relative, #956).
 *
 * A test file the diff ADDS is the one suite a ranked selection is structurally worst at: it is
 * absent from the committed impact map (which is built from the base tree), so it has no coverage
 * history, no failure history and no runtime signal — the very signals the score is made of. A
 * brand-new suite could therefore be ranked out below the floor by its own newness, and the branch
 * that introduced it would merge without ever running it. Nothing else in the pipeline catches
 * that: the guards cover marked tree-scanners, not new tests.
 *
 * So the gate names them explicitly and they are merged into the selection. This is a WIDENING of
 * an opt-in narrowing, so it never needs to fail open — an unset or unparseable value simply adds
 * nothing.
 */
const impactNewTestFiles = (process.env.KANBAN_TEST_NEW_FILES || "")
  .split(",")
  .map((s) => s.trim().replace(/\\/g, "/"))
  .filter(Boolean);

/**
 * Where the skill's CLI lives, in preference order.
 *
 * The worktree copy comes FIRST and is the one the instruction to agents names: the board copies
 * an enabled plugin's whole skill directory into every worktree (`copySkillToWorktree`, with
 * `dereference: true`, so the junction becomes real files). The `$HOME` copy is a fallback for
 * the main checkout / a machine where the plugin is not enabled on this project.
 */
export const IMPACT_CLI_CANDIDATES = [
  ".claude/skills/test-impact/tools/impact.mjs",
  ".codex/skills/test-impact/tools/impact.mjs",
];

/** Absolute path to the impact CLI, or null when the skill is not installed here. */
export function resolveImpactCli(root = ROOT, home = process.env.USERPROFILE || process.env.HOME || "") {
  const explicit = (process.env.KANBAN_IMPACT_CLI || "").trim();
  if (explicit) return existsSync(explicit) ? explicit : null;
  const candidates = [
    ...IMPACT_CLI_CANDIDATES.map((rel) => resolve(root, rel)),
    ...(home ? IMPACT_CLI_CANDIDATES.map((rel) => resolve(home, rel)) : []),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** `packages/<x>` (the pkgfile prefix) -> the PACKAGES label vitest is run under. */
export function packageLabelByDir(packages = PACKAGES) {
  return new Map(packages.map((p) => [p.dir.replace(/\\/g, "/"), p.label]));
}

/**
 * Does a package `exclude` glob match this package-relative test path?
 *
 * Only the shapes those globs actually use (`**' + '/name.test.ts`), so this is a deliberately
 * small matcher rather than a dependency: `**` spans path segments, `*` does not.
 */
export function matchesExcludeGlob(glob, relPath) {
  const pattern = glob.replace(/\\/g, "/");
  const rx = pattern
    .split("/")
    .map((seg) =>
      seg === "**"
        ? "(?:.*)"
        : seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"),
    )
    .join("/")
    // `**' + '/x` must also match a bare `x` at the root of the package.
    .replace(/\(\?:\.\*\)\//g, "(?:.*/)?");
  return new RegExp(`^${rx}$`).test(relPath.replace(/\\/g, "/"));
}

/**
 * Drop the selected suites this package will not actually run, and say which.
 *
 * The selector ranks every test file in the repo; it knows nothing about this runner's
 * `exclude` list (the #173 environmental exclusions — real git, docker, a spawned CLI). Handing
 * an excluded path to vitest is not harmless in either direction:
 *   - if OTHER selected suites survive, vitest runs those and exits 0, silently dropping the
 *     excluded one — a green for a suite that never ran;
 *   - if it was the only one selected for that package, vitest resolves nothing and exits 1
 *     with a bare `No test files found`, failing the run for a suite this runner is never
 *     allowed to run anyway.
 * Neither is a signal about the change, so the exclusion is applied HERE, loudly.
 */
export function partitionExcluded({ dir, exclude }, files) {
  const kept = [];
  const excluded = [];
  for (const file of files) {
    const hit = exclude.find(({ glob }) => matchesExcludeGlob(glob, file));
    if (hit) excluded.push({ file: `${dir}/${file}`, reason: hit.reason });
    else kept.push(file);
  }
  return { kept, excluded };
}

/**
 * Turn `--format pkgfile` stdout into the `label -> [relative test file]` map `runPackage`'s
 * file modes expect.
 *
 * Pure function of its arguments so the mapping is unit-testable without spawning the skill.
 * A line whose directory prefix is not a known package is reported in `unknown` rather than
 * silently dropped: it means the selector saw a package this runner does not run, and a caller
 * that swallowed that would report a green for tests it never executed.
 */
export function parseImpactSelection(stdout, packages = PACKAGES) {
  const byDir = packageLabelByDir(packages);
  /** @type {Map<string, string[]>} */
  const byLabel = new Map();
  const unknown = [];
  for (const rawLine of (stdout || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("[test-impact]")) continue;
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const dir = line.slice(0, idx).trim().replace(/\\/g, "/");
    const file = line.slice(idx + 1).trim().replace(/\\/g, "/");
    if (!dir || !file) continue;
    const label = byDir.get(dir);
    if (!label) {
      unknown.push(line);
      continue;
    }
    if (!byLabel.has(label)) byLabel.set(label, []);
    const files = byLabel.get(label);
    if (!files.includes(file)) files.push(file);
  }
  return { byLabel, unknown };
}

/**
 * Merge the gate's NEW test files into a selection map, in place of nothing (#956).
 *
 * Pure and exported so the rule — "a suite the diff adds always runs, whatever it scored" — is a
 * table test rather than something only a live gate run would exercise. Returns the count actually
 * added, so the caller can say so; a file already selected, or one under no known package, adds
 * nothing (the latter is reported by the caller, not silently guessed at).
 *
 * Only `*.test.*` paths are honoured. The gate derives the list from its diff, and a diff names
 * source files too — handing vitest a non-test path makes it resolve no suite and fail the package
 * with a bare `No test files found`, i.e. turn a widening into a red gate.
 */
export function mergeNewTestFiles(byLabel, newFiles, packages = PACKAGES) {
  const byDir = packageLabelByDir(packages);
  let added = 0;
  const unknown = [];
  for (const raw of newFiles) {
    const file = raw.replace(/\\/g, "/");
    if (!/\.test\.[cm]?[jt]sx?$/.test(file)) continue;
    const entry = [...byDir.entries()].find(([dir]) => file.startsWith(`${dir}/`));
    if (!entry) {
      unknown.push(file);
      continue;
    }
    const [dir, label] = entry;
    const rel = file.slice(dir.length + 1);
    if (!byLabel.has(label)) byLabel.set(label, []);
    const files = byLabel.get(label);
    if (!files.includes(rel)) {
      files.push(rel);
      added += 1;
    }
  }
  return { added, unknown };
}

/**
 * Ask the skill which suites to run. Returns `null` on ANY failure — the caller then falls back
 * to `vitest related`, which is the pre-#951 behaviour.
 *
 * The skill's stderr carries its own summary line (`… N test file(s) selected …`, `151 below
 * --min-score 1`, the staleness/escalation notes). That line is the operator's only view of what
 * was DROPPED, so it is echoed verbatim rather than swallowed.
 */
export function runImpactSelector({
  cli,
  minScore = impactMinScore,
  root = ROOT,
  rebuildIfStale = impactRebuildIfStale,
  base = impactBase,
  newTestFiles = impactNewTestFiles,
  budget = impactBudget,
  /**
   * The OTHER selector's picks, repo-relative (#967) — `vitest related`'s suite set for the
   * `KANBAN_TEST_FILES` scope, already derived by `relatedUnionSpecs`.
   *
   * Handed to the tool as `--union` rather than merged into the result here, and that placement is
   * the whole contract: `select` applies the score floor, then admits externals, then cuts to the
   * budget. Unioning consumer-side would happen AFTER the budget cut, so the run would exceed the
   * budget the setting promises. Empty means "no other selector ran", which is the pre-#967 argv.
   */
  union = [],
  spawnFn = spawnSync,
} = {}) {
  // The base is POSITIONAL and must come before the flags — `cmdSelect` reads `positional[0]` and
  // never looks at a `--base` flag. See `impactBase` for what an absent base silently costs at
  // gate time.
  const args = [cli, "select", ...(base ? [base] : []), "--format", "pkgfile", "--min-score", String(minScore)];
  // #966 — the floor is applied first and the budget second, by the tool. Omitted entirely when
  // unset, so a project with no budget gets byte-identical argv to the pre-#966 runner.
  if (budget) args.push("--budget", String(budget));
  // #967 — the union goes over STDIN (`--union -`), never inline as a comma list.
  //
  // MEASURED: `relatedTestSpecs` for a diff touching `packages/server/src/db/index.ts` returns 536
  // suites, whose comma-joined form is 33,735 chars — past Windows' 32,767-char CreateProcess
  // limit before the rest of the argv is counted. `spawnSync` then fails ENAMETOOLONG, this
  // function's `res.error` branch fails open to `vitest related`, and the run silently loses BOTH
  // the impact selection and the budget cap the project asked for — on exactly the widest, highest
  // fan-out diffs, which are the ones a budget exists to bound. Stdin has no such limit, and `-` is
  // one of the four shapes `readUnionList` already accepts.
  if (union.length > 0) args.push("--union", "-");
  if (rebuildIfStale) args.push("--rebuild-if-stale");
  console.log(
    `\n[test:mine] impact selector: node ${args.slice(1).join(" ")}` +
      (union.length > 0 ? ` (${union.length} union entr(ies) on stdin)` : ""),
  );
  const res = spawnFn(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    // Newline-separated, which is what `readUnionList` splits on for the `-` shape. Empty when
    // there is no union, so the pre-#967 argv AND stdio are byte-identical for that caller.
    ...(union.length > 0 ? { input: `${union.join("\n")}\n` } : {}),
  });
  // The skill's own summary/escalation lines — what it selected AND what it dropped.
  if (res.stderr) process.stderr.write(res.stderr);
  if (res.error) {
    console.warn(`[test:mine] impact selector failed to start (${res.error.message}) — falling back to \`vitest related\`.`);
    return null;
  }
  if (res.status !== 0) {
    console.warn(`[test:mine] impact selector exited ${res.status} — falling back to \`vitest related\`.`);
    return null;
  }
  const { byLabel, unknown } = parseImpactSelection(res.stdout ?? "");
  if (unknown.length > 0) {
    console.warn(
      `[test:mine] impact selector named ${unknown.length} suite(s) in package(s) this runner does not run — ` +
        `they will NOT be executed:\n` +
        unknown.map((l) => `  - ${l}`).join("\n"),
    );
  }
  const total = [...byLabel.values()].reduce((n, files) => n + files.length, 0);
  if (total === 0) {
    console.warn(
      `[test:mine] impact selector selected 0 suites — a green from that would assert nothing. ` +
        `Falling back to \`vitest related\`.`,
    );
    return null;
  }
  // #956 — the gate's new test files are merged AFTER the fail-open check, deliberately. An empty
  // selection must still fall back to `vitest related` even when the diff adds a suite: running
  // only the new file there would be NARROWER than the fallback, and the empty selection is
  // evidence the selector had nothing to say about this change at all.
  if (newTestFiles.length > 0) {
    const { added, unknown: unknownNew } = mergeNewTestFiles(byLabel, newTestFiles);
    if (added > 0) {
      console.log(
        `[test:mine] added ${added} NEW test file(s) from the diff on top of the selection — a suite ` +
          `the diff adds is absent from the impact map, so it can be ranked out by its own newness.`,
      );
    }
    if (unknownNew.length > 0) {
      console.warn(
        `[test:mine] ${unknownNew.length} new test file(s) are in package(s) this runner does not run — ` +
          `they will NOT be executed:\n` + unknownNew.map((l) => `  - ${l}`).join("\n"),
      );
    }
  }
  return byLabel;
}

/**
 * `KANBAN_TEST_SELECTOR=impact` + `KANBAN_TEST_FILES` is a UNION, not a conflict (#967).
 *
 * **This reverses #962's refusal, deliberately, and the reason it was a refusal is worth keeping in
 * view.** The pair used to be two rival answers to "which suites", and the file list was silently
 * DISCARDED — a green that asserts more than it checked, which is why refusing beat picking a
 * winner. What changed is that there is now a third answer: `impact.mjs select --union` takes the
 * other selector's picks as input, entering them AFTER the score floor (they are another selector's
 * evidence — our floor has no authority over it) and BEFORE the budget cut (or "only these seconds"
 * would be a lie). So the file list is no longer discarded; it is derived into suites via vitest's
 * own machinery (`relatedTestSpecs`) and merged.
 *
 * Why the union rather than either alone: the two selectors' MISSES are different in kind.
 * `vitest related` is blind to runtime reach (a spawned script, a fixture, a migration read) but
 * its omissions are provably outside the import graph; the impact heuristic sees runtime reach via
 * co-change/coverage/failure history but is a ranked bet under a floor and a budget. Replace-mode
 * silently gave up the first half.
 *
 * Returns a message to print, or `null`. It is now INFORMATIONAL — the caller logs it and
 * continues, rather than exiting 2. Kept as a pure function (rather than an inline `console.log`)
 * so the rule stays a unit test instead of something only a real double-scoped run would reveal.
 */
export function selectorFileScopeUnionNote({ impactSelectorRequested, scopedFiles }) {
  if (!impactSelectorRequested || scopedFiles.length === 0) return null;
  return (
    `[test:mine] KANBAN_TEST_SELECTOR=impact and KANBAN_TEST_FILES are both set — running the UNION ` +
    `(#967): the suites \`vitest related\` would select for the ${scopedFiles.length} named file(s) are ` +
    `derived and passed to \`select --union\`, so they are exempt from --min-score but still counted ` +
    `against the budget.`
  );
}

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
        // #894 flake-retry: the named suites, and deliberately NO `--passWithNoTests`. If a
        // suite resolves to nothing — it is in this package's `exclude` list, or the path no
        // longer selects — vitest exits non-zero and the retry fails, leaving the gate red.
        // That is the correct direction to fail: a retry that "passes" by running nothing
        // would clear a merge on the strength of an empty run. Note also that an unknown
        // `kind` falls through to `["run"]`, i.e. the package's FULL suite, which for this
        // mode would be the 44-minute operation the whole mechanism exists to avoid.
        : mode?.kind === "flake-retry"
          ? ["run", ...mode.files]
          // #951 impact selection: the named suites, no `--passWithNoTests`. Both ways a file
          // could resolve to nothing are handled BEFORE we get here — nonexistent paths are
          // dropped by `existsSync`, and this package's `exclude` globs by `partitionExcluded`
          // (which reports each one and its reason). So an empty resolution at this point is
          // unexpected, and failing is the correct direction for a selector that NARROWS a gate.
          : mode?.kind === "impact"
            ? ["run", ...mode.files]
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
 * The suites `vitest related <files>` WOULD select for this package, as repo-relative paths (#967).
 *
 * This is the other selector's answer, made available to the impact selection as `--union` input
 * rather than being thrown away. `KANBAN_TEST_SELECTOR=impact` used to REPLACE the edit-based
 * scope, which silently gave up the half of the safety `related` is actually good at: its misses
 * are provably outside the import graph, while the heuristic's are a ranked bet. The two see
 * different things, so the union is strictly stronger than either.
 *
 * Built from vitest's OWN machinery — `globTestSpecifications` + `getTestDependencies`, the two
 * calls `related` itself is built from, the same pair `relatedCoverageByFile` uses — so this cannot
 * name a different set than a `vitest related` spawn would have run. It is deliberately NOT a
 * second, cheaper approximation: an approximation here would silently either widen the gate (an
 * unrelated suite in the union) or, worse, claim `related`'s safety while omitting one of its picks.
 *
 * Fails OPEN, returning `null`: the union is a WIDENING of an opt-in narrowing, so a probe that
 * cannot run must leave the impact selection exactly as it was rather than fail the gate.
 *
 * @returns repo-relative suite paths, or `null` when the derivation failed.
 */
export async function relatedTestSpecs(pkgDir, files, loadVitest = defaultVitestLoader, root = ROOT) {
  const targets = files.map((f) => slash(resolve(pkgDir, f)));
  if (targets.length === 0) return [];
  const cwd = process.cwd();
  let vitest;
  try {
    const { createVitest } = await loadVitest(pkgDir);
    process.chdir(pkgDir);
    vitest = await createVitest("test", { watch: false, run: true, passWithNoTests: true, reporters: [] });
    const specs = await vitest.specifications.globTestSpecifications();
    const selected = [];
    const targetSet = new Set(targets);
    for (const spec of specs) {
      const id = slash(spec.moduleId);
      if (targetSet.has(id)) {
        selected.push(id);
        continue;
      }
      const deps = await vitest.specifications.getTestDependencies(spec);
      for (const dep of deps) {
        if (targetSet.has(slash(dep))) {
          selected.push(id);
          break;
        }
      }
    }
    // Repo-relative, because that is the vocabulary the impact inventory keys tests in — the
    // skill matches `--union` entries against `inv.entries`, so a package-relative path would be
    // "not in the inventory" for every single pick and lose its measured duration.
    return [...new Set(selected.map((p) => slash(relative(root, p))))];
  } catch (err) {
    console.warn(
      `[test:mine] could not derive the \`vitest related\` suite set for ${pkgDir} (${err?.message ?? err}) — ` +
        `the impact selection runs WITHOUT that selector's picks unioned in.`,
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
 * The union input for `select --union`: every suite `vitest related` would have selected, across
 * every package the file scope names files in (#967).
 *
 * Per package, because `vitest related` is per package — a suite is selected by the vitest instance
 * whose config resolves the changed file, and `UPSTREAM_DEPENDENCIES` is what lets a
 * `packages/shared` change reach the server's suites through its alias, exactly as the
 * `related`-path loop below does it. Deriving the union from a single root instance would miss that.
 *
 * Returns `{ specs, failedPackages }` — a package whose probe failed is NAMED, never silently
 * treated as "related selected nothing there". Silence would read as "the other selector agreed
 * with ours", which is the one thing this must not claim.
 */
export async function relatedUnionSpecs(packages, ownedFor, upstreamFor, derive = relatedTestSpecs) {
  const specs = new Set();
  const failedPackages = [];
  for (const pkg of packages) {
    const owned = ownedFor(pkg);
    const files = owned.length > 0 ? owned : upstreamFor(pkg);
    if (files.length === 0) continue;
    const found = await derive(resolve(ROOT, pkg.dir), files);
    if (found === null) {
      failedPackages.push(pkg.label);
      continue;
    }
    for (const spec of found) specs.add(spec);
  }
  return { specs: [...specs], failedPackages };
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

  /* -------------------------------------------------------------------------
   * Machine-wide verify lock (#957)
   *
   * #949 brought every heavyweight verification the SERVER PROCESS runs under one in-process
   * semaphore. This run is not in that process: a builder agent's own `pnpm test:mine` is a
   * separate process tree, and with WIP 2-3 it is the single largest load the board cannot see.
   * So the box could sit at 100% CPU with one gate correctly serialized and three unserialized
   * test runners beside it — the exact symptom #949 was filed against.
   *
   * Taking the lock HERE is what makes a builder participate at all; nothing the board does can
   * make it, which is why this is a change to the repo's own test entrypoint rather than to a
   * board service. It only helps repos that adopt it, and that is inherent.
   *
   * OPT-IN (`KANBAN_MACHINE_VERIFY_LOCK=1`): with the switch off `acquireForBuilderTest` returns
   * immediately with no handle and no note, and this run is byte-for-byte what it was before.
   * Bounded by the short `builder-test` role — a builder that waits an hour for a gate has
   * stopped being a builder — and on timeout it RUNS ANYWAY, having printed why.
   * ---------------------------------------------------------------------- */
  const lockHolder = `test:mine ${process.cwd()}`;
  const { handle: machineLock, note: machineLockNote } = await acquireForBuilderTest(lockHolder);
  const heartbeat = machineLock
    ? setInterval(() => machineLock.heartbeat(), MACHINE_LOCK_HEARTBEAT_INTERVAL_MS)
    : null;
  // Never let the heartbeat timer be the reason this process cannot exit.
  heartbeat?.unref?.();
  // Released on EVERY exit path — this block calls `process.exit()` in half a dozen places, and
  // a lock leaked by one of them would block every other verifier on the box for the full
  // staleness window. `once` so a normal fallthrough plus an explicit exit cannot double-release.
  process.once("exit", () => {
    if (heartbeat) clearInterval(heartbeat);
    machineLock?.release();
    // The note is repeated at the END as well as when it was issued: a run's caveat is worth
    // nothing if it scrolled past thousands of lines of vitest output an hour ago.
    if (machineLockNote) console.warn(`\n${machineLockNote}`);
  });

  /* -------------------------------------------------------------------------
   * The gate's step-timing self-report (#988)
   *
   * `packages/server/src/services/verify-step-timings.ts` is the other half of this contract.
   * A merge gate sees the whole `verify_script` as ONE opaque `runSetupScript` call, so nothing
   * on the board's side can say whether three minutes were tests, typecheck or depcruise — and
   * #980 measured that floor by hand precisely because the gate would not say.
   *
   * Emitted from a `process.once("exit")` handler rather than from each of the half-dozen
   * `process.exit()` sites below, for the same reason the lock release above is: a report that
   * only some exit paths produce is worse than none, because its absence then reads as "this
   * step was free" instead of "this path forgot to print".
   *
   * `scope` is the honesty half. A run narrowed to guards or to an impact selection cost less
   * BECAUSE it checked less, and a bare `tests 40s` beside a `tier: guards-only` gate would
   * invite exactly the wrong conclusion about the floor.
   * ---------------------------------------------------------------------- */
  const stepStartedAt = Date.now();
  // Package scoping is the BASE, not a mode: every branch below runs inside whatever
  // `KANBAN_TEST_PACKAGES` left in `toRun`, so it is the honest label whenever nothing narrower
  // was chosen. A narrower mode overwrites it — `impact-selected` already implies the package
  // scope it selected within, and naming both would be two labels for one run.
  let stepScope = toRun !== PACKAGES ? "package-scoped" : "full";
  process.once("exit", () => {
    console.log(`[gate:step] name=tests seconds=${Math.round((Date.now() - stepStartedAt) / 1000)} scope=${stepScope}`);
  });

  const treeBefore = treeSnapshot();
  if (retryScope.size > 0) {
    // #894 — the narrow re-run of suites that just failed a full gate. Runs ONLY what it was
    // given: no guard top-up, no related-derivation, no fallback to a package's full suite.
    // A fallback here would defeat the purpose, since the point is that this costs ~22s
    // rather than 44 minutes.
    const planned = PACKAGES.map((pkg) => ({
      pkg,
      files: (retryScope.get(pkg.label) ?? []).filter((f) => existsSync(resolve(ROOT, pkg.dir, f))),
    })).filter((entry) => entry.files.length > 0);
    const total = planned.reduce((n, entry) => n + entry.files.length, 0);
    const asked = [...retryScope.values()].reduce((n, files) => n + files.length, 0);
    stepScope = "flake-retry";
    console.log(`\n[test:mine] flake-retry mode (KANBAN_RETRY_TEST_FILES): ${total} suite(s) across ${planned.length} package(s)`);
    if (total !== asked) {
      // Never quietly run a subset: a suite that vanished between the failing run and the
      // retry (renamed, deleted, or attributed to the wrong package) means the retry no
      // longer covers what failed, and a green would be a false clearance.
      console.error(`[test:mine] flake-retry was asked for ${asked} suite(s) but only ${total} exist on disk — refusing to report a green that did not re-run everything that failed.`);
      process.exit(1);
    }
    if (total === 0) {
      console.error("[test:mine] flake-retry mode resolved no suites — refusing to report a green that checked nothing.");
      process.exit(1);
    }
    for (const { pkg, files } of planned) {
      if ((await runPackage(pkg, { kind: "flake-retry", files })).code !== 0) failed = true;
    }
    if (reportTreeDrift(treeBefore)) failed = true;
    if (failed) {
      console.error("\n[test:mine] The re-run suites failed again — this is a real failure, not machine load.");
      process.exit(1);
    }
    console.log("\n[test:mine] All re-run suites passed.");
    process.exit(0);
  }
  if (guardsOnly) {
    // Every package's guard suites, and only those. A package with no marked suite is skipped
    // rather than falling through to its full suite.
    const planned = PACKAGES.map((pkg) => ({
      pkg,
      guards: (ALWAYS_RUN_TESTS[pkg.label] ?? []).filter((f) => existsSync(resolve(ROOT, pkg.dir, f))),
    })).filter((entry) => entry.guards.length > 0);
    const total = planned.reduce((n, entry) => n + entry.guards.length, 0);
    stepScope = "guards-only";
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
  const unionNote = selectorFileScopeUnionNote({ impactSelectorRequested, scopedFiles });
  if (unionNote) console.log(unionNote);
  // #951 — the opt-in impact selector, tried BEFORE the `vitest related` path and falling
  // through to it on any failure. `impactScope === null` is exactly that fall-through, so the
  // loop below is unchanged for every caller that did not opt in.
  let impactScope = null;
  if (impactSelectorRequested) {
    const cli = resolveImpactCli();
    if (!cli) {
      console.warn(
        `[test:mine] KANBAN_TEST_SELECTOR=impact, but the test-impact skill is not installed here ` +
          `(looked for ${IMPACT_CLI_CANDIDATES.join(", ")} under the repo root and $HOME) — ` +
          `falling back to \`vitest related\`.`,
      );
    } else {
      // #967 — derive the OTHER selector's picks first, so they enter `select` as `--union` input
      // (before its budget cut) rather than being appended to a finished selection afterwards.
      // Empty when no file scope was given, which reproduces the pre-#967 call exactly.
      let union = [];
      if (scopedFiles.length > 0) {
        const { specs, failedPackages } = await relatedUnionSpecs(
          toRun,
          (pkg) => ownedChangedFiles(pkg.dir),
          (pkg) => upstreamChangedFiles(pkg.label),
        );
        union = specs;
        if (failedPackages.length > 0) {
          // Never let a failed derivation read as "related agreed with the impact selection".
          console.warn(
            `[test:mine] could not derive the \`vitest related\` suite set for ${failedPackages.join(", ")} — ` +
              `those packages contribute NOTHING to the union, so the run is as narrow as impact alone there.`,
          );
        }
        console.log(
          `[test:mine] union input: ${union.length} suite(s) from \`vitest related\` over ` +
            `${scopedFiles.length} changed file(s) — passed to \`select --union\`.`,
        );
      }
      impactScope = runImpactSelector({ cli, union });
    }
  }
  /** @type {{ planned: { pkg: any, files: string[] }[], total: number, namedOverall: number, excludedCount: number } | null} */
  let impactPlan = null;
  if (impactScope) {
    /** @type {{ file: string, reason: string }[]} */
    const excludedSelections = [];
    const planned = toRun
      .map((pkg) => {
        const onDisk = (impactScope.get(pkg.label) ?? []).filter((f) =>
          existsSync(resolve(ROOT, pkg.dir, f)),
        );
        // The selector does not know this runner's `exclude` list, so an excluded suite would
        // otherwise be dropped silently by vitest (green for a suite that never ran) or fail
        // the whole package with a bare `No test files found`. Neither says anything about the
        // change — drop it here and name it.
        const { kept, excluded } = partitionExcluded(pkg, onDisk);
        excludedSelections.push(...excluded);
        return { pkg, files: kept };
      })
      .filter((entry) => entry.files.length > 0);
    if (excludedSelections.length > 0) {
      console.warn(
        `[test:mine] the selector named ${excludedSelections.length} suite(s) this runner excludes ` +
          `— NOT run here (they run in \`pnpm test:full\`):\n` +
          excludedSelections.map(({ file, reason }) => `  - ${file} — ${reason}`).join("\n"),
      );
    }
    const total = planned.reduce((n, entry) => n + entry.files.length, 0);
    const namedOverall = [...impactScope.values()].reduce((n, files) => n + files.length, 0);
    impactPlan = { planned, total, namedOverall, excludedCount: excludedSelections.length };
    if (total === 0) {
      // Everything the selector named is excluded here or outside the package scope. Running
      // only the guards and reporting a green would assert nothing about the change, so this
      // fails open the same way an empty selection does.
      console.warn(
        `[test:mine] impact selection left 0 runnable suite(s) after exclusions and package ` +
          `scope — falling back to \`vitest related\`.`,
      );
      impactScope = null;
    }
  }
  if (impactScope) {
    const { planned, total, namedOverall, excludedCount } = impactPlan;
    stepScope = scopedFiles.length > 0 ? "impact+related" : "impact-selected";
    console.log(
      `\n[test:mine] ${scopedFiles.length > 0 ? "impact+related-scoped" : "impact-scoped"} to ${total} suite(s) ` +
        `across ${planned.length} package(s) (KANBAN_TEST_SELECTOR=impact, --min-score ${impactMinScore}` +
        `${scopedFiles.length > 0 ? `, unioned with \`vitest related\` over ${scopedFiles.length} changed file(s)` : ""}); ` +
        `the @gate:always-run guards run on top, per package.`,
    );
    // Excluded suites are already reported above with their reason, so they are not also
    // blamed on the package scope — otherwise this line tells the operator to widen
    // KANBAN_TEST_PACKAGES for a suite that would still not run.
    const outOfScope = namedOverall - total - excludedCount;
    if (outOfScope > 0) {
      // Never let "the selector picked suites, but KANBAN_TEST_PACKAGES excludes their package"
      // read as a clean narrow run. It is the same class of quiet gap as an empty selection.
      console.warn(
        `[test:mine] the selector named ${namedOverall} suite(s) but only ${total} are in the ` +
          `packages currently in scope (${toRun.map((p) => p.label).join(", ")}) — ${outOfScope} ` +
          `are NOT being run. Widen KANBAN_TEST_PACKAGES if that is not intended.`,
      );
    }
    for (const { pkg, files } of planned) {
      if ((await runPackage(pkg, { kind: "impact", files })).code !== 0) failed = true;
    }
    // The guard top-up is NOT conditional on the package being in `planned`: a guard suite
    // asserts a property of the tree, so it must run for every package in scope regardless of
    // whether the selector named anything there (#538).
    for (const pkg of toRun) {
      const guards = (ALWAYS_RUN_TESTS[pkg.label] ?? []).filter((f) => existsSync(resolve(ROOT, pkg.dir, f)));
      if (guards.length > 0 && (await runPackage(pkg, { kind: "guards", files: guards })).code !== 0) failed = true;
    }
    if (reportTreeDrift(treeBefore)) failed = true;
    if (failed) {
      console.error("\n[test:mine] One or more impact-selected suites failed.");
      process.exit(1);
    }
    console.log("\n[test:mine] All impact-selected suites and guards passed.");
    process.exit(0);
  }
  // The `vitest related` path. Per-package it may be file-scoped or a full suite (a package with
  // no own changes and no upstream ones falls through to its whole suite), so the ONE label this
  // step can honestly claim is whether a file scope was in play at all — the gate message names
  // the tier separately, and a `file-scoped` here that meant "for three of five packages" would
  // be a narrower claim than the run earned.
  if (scopedFiles.length > 0) stepScope = "file-scoped";
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

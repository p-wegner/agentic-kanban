// gate:always-run — the ENFORCEMENT POINT for the `@gate:always-run` guard set on the
// direct-master path (#817).
//
// ## Why this exists
//
// The `@gate:always-run` marker declares a suite that must run for every diff reaching its
// package, because what it checks is not reachable through the module graph (see
// `scripts/test-mine.mjs`, `ALWAYS_RUN_MARKER`). Two mechanisms already force that set to run:
// `pre-merge-gate.service.ts` (which sets `KANBAN_TEST_GUARDS_ONLY=1` for a docs-only diff, and
// appends the guards to every file-scoped run) and `test-mine.mjs` itself. BOTH of them are on
// the MERGE path.
//
// A commit made directly on master — the `direct-master` skill, which is how a large share of
// this repo's work lands — passes through neither. Measured on #800/#817: the server nloc ring
// landed at `086a41b6bc` with a baseline measured at that commit, and within the SAME DAY three
// baselined functions grew past their entries on plain master commits:
//
//   session-lifecycle.ts::createSessionLifecycle   614 -> 615  (aeb4bb67e0, #801)
//   agent-remote.service.ts::createRemoteAgentService 573 -> 594  (428ad4bdf9, 06e56ee005, aeb4bb67e0)
//   worker/worker-agent-runner.ts::createWorkerAgentRunner 404 -> 410  (06e56ee005, #799)
//
// `git merge-base --is-ancestor 086a41b6bc <each>` is true for all three: the ring WAS in their
// history and it DID catch them. It just caught them retroactively — as a red suite the next
// person to merge ANYTHING had to deal with. A ratchet with no enforcement point on the path
// most of the work takes is a report, and it externalises its cost onto whoever merges next.
//
// ## Why a command and not a pre-commit hook
//
// Several agents commit into this one checkout concurrently (see the root CLAUDE.md, "Several
// agents committing in ONE checkout"). A `pre-commit` hook that runs a test suite would:
//   - serialise those agents behind one vitest fleet, on a box that is already the binding
//     constraint (the reason `KANBAN_TEST_MAX_WORKERS` exists at all, #278);
//   - fire on every commit including the doc-only and message-only ones; and
//   - be routed around with `--no-verify` the first time it costs someone a minute, which is
//     strictly worse than no hook because then nobody knows whether it ran.
//
// A named, fast, opt-out-able command that the `direct-master` skill tells you to run once per
// GROUP of commits is honest about all three. It is deliberately the same declared set the
// merge gate forces, so the two can't drift: this is `test-mine.mjs`'s existing guards-only
// mode with a name, a worker cap suited to a shared box, and a wall-clock report.
//
// ## Usage
//
//   pnpm gate:always-run                  # every @gate:always-run suite, every package
//   pnpm gate:always-run -- --maxWorkers=8
//
// Any extra args are forwarded to vitest by `test-mine.mjs`.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

/**
 * Default worker cap.
 *
 * vitest's own default is `cpus/2` with `pool: "forks"` and full isolation, which on a box
 * shared with a dev server, other agents and their gates multiplies peak memory rather than
 * finishing sooner (#278). The guard set is ~130 mostly-IO-bound tree scans, so a low cap costs
 * little. An explicit `KANBAN_TEST_MAX_WORKERS` or a passthrough `--maxWorkers` still wins —
 * `test-mine.mjs` resolves that precedence, this only supplies the default.
 */
const DEFAULT_MAX_WORKERS = "4";

const passthrough = process.argv.slice(2);
const callerSetWorkers =
  passthrough.some((a) => a.startsWith("--maxWorkers")) ||
  (process.env.KANBAN_TEST_MAX_WORKERS || "").trim() !== "";

const env = {
  ...process.env,
  KANBAN_TEST_GUARDS_ONLY: "1",
  ...(callerSetWorkers ? {} : { KANBAN_TEST_MAX_WORKERS: DEFAULT_MAX_WORKERS }),
};

console.log(
  `[gate:always-run] running ONLY the @gate:always-run guard suites` +
    (callerSetWorkers ? "" : ` (workers capped at ${DEFAULT_MAX_WORKERS}; override with --maxWorkers=N)`),
);

const startedAt = Date.now();
const child = spawn(process.execPath, [resolve(__dirname, "test-mine.mjs"), ...passthrough], {
  cwd: ROOT,
  env,
  stdio: "inherit",
  windowsHide: true,
});

/** Wall-clock as `m:ss`, because "is this fast enough that anyone will run it?" is the question. */
function elapsed() {
  const s = Math.round((Date.now() - startedAt) / 1000);
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

child.on("exit", (code) => {
  if (code === 0) {
    console.log(`\n[gate:always-run] guard set GREEN in ${elapsed()}.`);
  } else {
    console.error(
      `\n[gate:always-run] guard set RED in ${elapsed()}.\n` +
        `  Fix it BEFORE committing to master. A guard left red on master is not your problem\n` +
        `  alone — it fails the pre-merge gate of every workspace that merges next, and the\n` +
        `  usual outcome is that someone else re-baselines your growth to unblock themselves.`,
    );
  }
  process.exit(code ?? 1);
});

child.on("error", (err) => {
  console.error(`[gate:always-run] failed to start:`, err);
  process.exit(1);
});

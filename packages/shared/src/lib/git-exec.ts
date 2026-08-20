import { AsyncLocalStorage } from "node:async_hooks";
import { execFile, execFileSync, spawn, type ChildProcess, type ExecFileException, type StdioOptions } from "node:child_process";
import { existsSync } from "node:fs";
import type { ExecResult } from "./exec-result.js";
import { recordOperation } from "./operation-metrics.js";

/**
 * The single sanctioned adapter for spawning the `git` CLI.
 *
 * Every git invocation in the codebase MUST go through one of these primitives —
 * spawning `git` directly via `child_process` anywhere else is forbidden and gated
 * by `packages/shared/__tests__/git-exec-single-spawn.test.ts`. Centralising the
 * spawn keeps the Windows quirks (`windowsHide`), buffer limits, timeouts and error
 * normalisation in one place, and makes git a single replaceable adapter at the
 * boundary of the app (clean-architecture: the git CLI is an external system; this
 * module is its port).
 *
 * Since #398 this adapter is also the PROCESS-WIDE SCHEDULER for git spawns: git
 * concurrency used to be budgeted in four independent places (runBgGit cap 5, the
 * monitor cycle's concurrency 4, scheduleWorktreeDiffStatsRefresh, plus unbounded
 * inline `Promise.all`s) against one disk and one event loop, which is what starved
 * `/api/health` to 6-24s. The budget now lives HERE, beneath all of them:
 *  - a FIFO semaphore of `GIT_SPAWN_SLOTS` over every buffered async spawn, with an
 *    `interactive` priority lane that jumps the normal queue (see `GitExecPriority`);
 *  - a short-TTL dedupe memo over READ-ONLY commands (see `DEDUPE_SAFE_SUBCOMMANDS`)
 *    so identical concurrent spawns share one child and identical back-to-back
 *    spawns within `GIT_DEDUPE_MEMO_TTL_MS` share one result.
 * `gitExecSync` is deliberately NOT scheduled (a sync call cannot queue; it is being
 * removed by a separate ticket), and `gitStream` is exempt (protocol plumbing bounded
 * by the HTTP request lifecycle). Callers' private budgets above this module become
 * harmless fan-out limits, not the real concurrency control.
 *
 * Node-only: this imports `node:child_process`, so it must never be value-exported
 * from the `@agentic-kanban/shared/lib` barrel (that would white-screen the client
 * bundle, see #791). Import it via its deep path: `@agentic-kanban/shared/lib/git-exec`.
 */

/** Generous default for diff/log output; individual callers may narrow it. */
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;

/**
 * Wall-clock ceiling applied to every buffered git invocation that does not set its
 * own `timeout`. Without it a single git call could block FOREVER — and one did: a
 * monitor-path git call that never returned kept `processWorkspaceCandidates` pending,
 * so the monitor cycle's `finally` never ran, `cycleRunning` stayed `true`, and every
 * later cycle short-circuited on the re-entrancy guard for every project until the
 * server was restarted (the #208 tail). Ten minutes is far longer than any legitimate
 * buffered call here (the largest is a shallow/`--single-branch` clone) while still
 * guaranteeing that a wedged git eventually dies. `gitStream` is deliberately exempt:
 * it carries packfiles for the worker-fleet smart-HTTP transport, which has no
 * meaningful upper bound and is already bounded by the HTTP request lifecycle.
 */
export const DEFAULT_GIT_TIMEOUT_MS = 10 * 60_000;

/**
 * Never let git block on a human. `GIT_TERMINAL_PROMPT=0` makes any credential /
 * host-key / passphrase prompt FAIL FAST instead of waiting on a tty that no server
 * process has, which is the most common way a git call hangs indefinitely on a
 * private remote. Merged over (not replacing) the caller's `env` so explicit
 * overrides like `GIT_INDEX_FILE` still apply, and over `process.env` when the
 * caller passes none, because `child_process`'s `env` option REPLACES the
 * environment rather than extending it.
 */
function nonInteractiveEnv(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  return { ...(env ?? process.env), GIT_TERMINAL_PROMPT: "0" };
}

/**
 * Scheduling lane for a buffered async git spawn (#398).
 *
 * `interactive` — request-path work a user is actively waiting on (an HTTP handler
 * building a response). Jumps ahead of everything queued in the normal lane, but
 * never preempts a child that is already running.
 * `normal` (default) — background sweeps, cache refreshes, monitor work.
 */
export type GitExecPriority = "interactive" | "normal";

/**
 * Ambient priority context (#398 follow-up, G8). The `interactive` lane above was dead
 * code: no production call site passed `priority: "interactive"`, so HTTP request paths
 * queued behind minutes of monitor-cycle git (measured: /diff 180s, /stats 145s,
 * repo-merge-status 115s on an idle workspace). Threading an options parameter through
 * every git-service function between a route handler and this adapter would have touched
 * ~20 files, so the priority rides an AsyncLocalStorage context instead: a Hono
 * middleware wraps every /api request in `runWithGitPriority("interactive", next)`, and
 * `gitExec` reads the ambient value when the caller passes no explicit `priority`.
 *
 * Semantics:
 *  - An explicit `opts.priority` always wins over the ambient context.
 *  - Only code running inside a `runWithGitPriority` scope is affected; background work
 *    (monitor cycles, reconcilers, crons) never enters one, so the default is unchanged.
 *  - ALS propagates through awaits AND into fire-and-forget promises started inside the
 *    scope (e.g. a stale-while-revalidate refresh kicked off by a request). That is
 *    accepted: such work was user-initiated, and the lane only reorders the queue —
 *    it never starves the normal lane of running slots.
 */
const ambientGitPriority = new AsyncLocalStorage<GitExecPriority>();

/**
 * Run `fn` with `priority` as the ambient lane for every `gitExec` call in its async
 * continuation (unless a call passes an explicit `opts.priority`). This is the seam the
 * server's HTTP middleware uses to mark request-path git as `interactive`.
 */
export function runWithGitPriority<T>(priority: GitExecPriority, fn: () => T): T {
  return ambientGitPriority.run(priority, fn);
}

export interface GitExecOptions {
  /** Working directory. Omit only for repo-path-as-argument commands like `clone`. */
  cwd?: string;
  /** Kill the process after this many ms (passed through to child_process). */
  timeout?: number;
  /** Max bytes of stdout/stderr to buffer. Defaults to 10 MiB. */
  maxBuffer?: number;
  /** Environment overrides (e.g. `GIT_INDEX_FILE`). Replaces the inherited env when set. */
  env?: NodeJS.ProcessEnv;
  /** Written to the process's stdin and closed (e.g. `hash-object --stdin`). Async variants only. */
  input?: string;
  /** Queue lane when all spawn slots are busy. Defaults to `normal`. See `GitExecPriority`. */
  priority?: GitExecPriority;
  /**
   * Force a real spawn, never a memoized result (#621).
   *
   * The dedupe memo below is invalidated by adapter-driven mutations, so a read after a
   * mutation THIS process made is always fresh. Mutations by ANOTHER process — an agent
   * running `git commit` in its worktree — are bounded only by the ~1.5s TTL, as that
   * comment states.
   *
   * For most reads that is a fine trade. For the detached-HEAD guards it is not: the whole
   * PURPOSE of `syncBranchToHead`/`ensureOnBranch` is to notice commits made out-of-band by
   * the agent, so serving them a memoized `rev-parse HEAD` can tell them the branch is
   * already in sync and return without capturing the dangling commit. Those call sites set
   * this flag; nothing else should need it.
   */
  fresh?: boolean;
  /**
   * INSTRUMENTATION ONLY — override the metric label for this call and exclude it from
   * duplicate-spawn accounting. Changes nothing about how git is spawned or what it is asked to do.
   *
   * Exists for the monitor's environmental CONTROL spawn (#368): `git --version` does no repository
   * work, so it must be readable on its own line rather than blended into a real subcommand's
   * figures, and N identical control spawns inside one cycle would otherwise read as N-1 spawns a
   * per-cycle memo could have removed — corrupting the `duplicateSpawns` number that refuted #359's
   * recommended fix. The DURATION still flows through the same `recordOperation` call as every real
   * git operation, which is the whole point of a control: a control timed by a different mechanism
   * than the thing it controls for proves nothing. For the same reason a probe is never deduped by
   * the #398 memo: it must spawn a real child every time or it measures nothing.
   */
  probeLabel?: string;
}

/**
 * #591 — git's result IS the shared `ExecResult`, plus the instrumentation field only this
 * adapter produces. The `code: null` / `Error` conventions documented on `ExecResult` were
 * git's first; docker and devcontainer were brought onto them rather than the reverse.
 */
export interface GitExecResult extends ExecResult {
  /**
   * INSTRUMENTATION ONLY — the two durations this call contributed to `operation-metrics`, handed
   * back so a caller that needs the INDIVIDUAL sample (rather than a window aggregate) reads the
   * same numbers the registry got instead of re-timing the call its own way.
   *
   * Optional so the many hand-built `GitExecResult` fixtures in tests stay valid; `gitExec` always
   * populates it. `totalMs` is call-to-callback (INCLUDING time waiting in the #398 spawn queue, so
   * `totalMs - childMs` keeps meaning "wait", now an explicit queue rather than event-loop
   * congestion), `childMs` is the child's own lifetime from its `exit` event (null when the process
   * never spawned, e.g. ENOENT) — see the split's caveat in the spawn implementation.
   */
  timing?: { totalMs: number; childMs: number | null };
}

/**
 * Metric label of the monitor's environmental CONTROL spawn (#368).
 *
 * Exported because two readers must agree on it: the probe that emits it and the cycle report that
 * must EXCLUDE it from aggregates describing the cycle's real work.
 */
export const GIT_CONTROL_OPERATION_LABEL = "git:control";

// ---------------------------------------------------------------------------
// #398 — process-wide spawn semaphore with a priority lane.
// ---------------------------------------------------------------------------

/**
 * Maximum buffered async git children in flight at once, process-wide. Chosen from the
 * ticket's 6-8 band: 8 keeps throughput on the ~120ms-per-spawn Windows floor while still
 * capping the fan-out that used to fire 28-40+ concurrent spawns which then serialized on
 * the repo index lock (measured 112.7s for one such burst — see project.service.ts:476).
 */
export const GIT_SPAWN_SLOTS = 8;

let activeSpawns = 0;
const interactiveQueue: Array<() => void> = [];
const normalQueue: Array<() => void> = [];

/** Release one slot: hand it to the next queued spawn (interactive lane first), FIFO within each lane. */
function releaseSlot(): void {
  const next = interactiveQueue.shift() ?? normalQueue.shift();
  if (next) {
    next(); // slot transfers directly; activeSpawns unchanged
  } else {
    activeSpawns--;
  }
}

/**
 * Run `spawnBuffered` under the process-wide semaphore. When a slot is free the spawn
 * happens synchronously in this tick (so tests and callers observing the spawn right
 * after the call still work); otherwise the spawn is queued FIFO in its priority lane.
 */
function scheduleSpawn(args: string[], opts: GitExecOptions): Promise<GitExecResult> {
  const startedMs = Date.now();
  if (activeSpawns < GIT_SPAWN_SLOTS) {
    activeSpawns++;
    return spawnBuffered(args, opts, startedMs).finally(releaseSlot);
  }
  return new Promise<GitExecResult>((resolve) => {
    const run = () => {
      // `void`: this deliberately does not await — it RESOLVES the enclosing promise, which
      // is the caller's handle. `spawnBuffered` never rejects (it returns `{error}`), so there
      // is no rejection to lose (no-floating-promises).
      void spawnBuffered(args, opts, startedMs).finally(releaseSlot).then(resolve);
    };
    (opts.priority === "interactive" ? interactiveQueue : normalQueue).push(run);
  });
}

// ---------------------------------------------------------------------------
// #398 — short-TTL dedupe memo over read-only spawns.
// ---------------------------------------------------------------------------

/**
 * Git subcommands that CANNOT mutate repository state (refs, index intent, working tree)
 * and are therefore safe to dedupe: identical concurrent calls may share one child, and
 * identical back-to-back calls within `GIT_DEDUPE_MEMO_TTL_MS` may share one result.
 *
 * Decided CONSERVATIVELY — a subcommand is listed only when every argv form of it is
 * mutation-free from the caller's perspective:
 *  - `rev-parse`, `rev-list`, `log`, `shortlog`, `show`, `diff`, `ls-files`, `ls-tree`,
 *    `cat-file`, `merge-base`, `for-each-ref`, `describe` — pure reads.
 *  - `status` — semantically a read; it may opportunistically refresh the index stat
 *    cache, but that refresh is idempotent and racing two identical `status` calls was
 *    never better than one.
 *  - `merge-tree` — writes OBJECTS to the odb (even with `--write-tree`), never refs or
 *    the working tree; object writes are content-addressed and idempotent, so sharing
 *    one call is safe (this is the read-only conflict probe `detectConflicts` uses).
 *
 * NEVER list here: `commit`, `merge`, `rebase`, `checkout`, `switch`, `reset`, `add`,
 * `worktree`, `branch` (mutates without `--list`), `tag`, `fetch`/`push`/`pull`/`clone`
 * (remote or ref mutation; also non-idempotent network work), `stash`, `config`,
 * `update-ref`, `gc`. A mutating command sharing a child would silently drop one
 * caller's mutation; a memoized one would report success without doing the work.
 *
 * Note on #359's counter-argument (see `spawnDedupeKey`): what was rejected there was a
 * CYCLE-LIFETIME cache, which could have served stale SHAs across a merge-gate run
 * (#243). This memo is different on both counts: the TTL is ~1.5s, and any NON-listed
 * command scheduled through this adapter invalidates the memo for its cwd (before and
 * after it runs), so a rev-parse re-read after an adapter-driven mutation never serves
 * the pre-mutation value. Mutations by OTHER processes (agents in worktrees) are bounded
 * only by the TTL — which is why it stays short.
 */
const DEDUPE_SAFE_SUBCOMMANDS = new Set([
  "rev-parse",
  "rev-list",
  "log",
  "shortlog",
  "show",
  "diff",
  "status",
  "ls-files",
  "ls-tree",
  "cat-file",
  "merge-base",
  "merge-tree",
  "for-each-ref",
  "describe",
]);

/** How long an identical read-only result may be re-served without a fresh spawn. */
export const GIT_DEDUPE_MEMO_TTL_MS = 1500;

/** Identical read-only spawns currently in flight, keyed by full call identity. */
const inFlightByKey = new Map<string, Promise<GitExecResult>>();
/** Recently completed read-only results, served until `expiresAt`. */
const resultMemo = new Map<string, { result: GitExecResult; expiresAt: number }>();
const RESULT_MEMO_SWEEP_SIZE = 512;

/**
 * Full call identity for dedupe — stricter than the metrics-only `spawnDedupeKey`:
 * two calls may only share a child/result when cwd, argv, timeout AND maxBuffer all
 * match (a narrower buffer or timeout is an observable behavioural difference).
 */
function dedupeKeyFor(args: string[], opts: GitExecOptions): string | null {
  // env can change what git reads (GIT_INDEX_FILE, GIT_DIR); input feeds stdin and is
  // not part of the key; a probe must really spawn (see `probeLabel`). All three
  // disqualify the call from dedupe rather than complicating the key.
  if (opts.env !== undefined || opts.input !== undefined || opts.probeLabel !== undefined) return null;
  // #621: an explicit fresh read must really spawn — same disqualification as a probe.
  if (opts.fresh) return null;
  const sub = effectiveSubcommand(args);
  if (sub === null || !DEDUPE_SAFE_SUBCOMMANDS.has(sub)) return null;
  return JSON.stringify([opts.cwd ?? "", args, opts.timeout ?? DEFAULT_GIT_TIMEOUT_MS, opts.maxBuffer ?? DEFAULT_MAX_BUFFER]);
}

/** Drop memoized results for a cwd (all, when cwd is unknown) — called around any command that might mutate. */
function invalidateMemoForCwd(cwd: string | undefined): void {
  if (resultMemo.size === 0) return;
  if (cwd === undefined) {
    resultMemo.clear();
    return;
  }
  const prefix = `[${JSON.stringify(cwd)},`;
  for (const key of resultMemo.keys()) {
    if (key.startsWith(prefix)) resultMemo.delete(key);
  }
}

/** Lazy bound on the memo: sweep expired entries when the map grows past the sweep size. */
function sweepResultMemo(now: number): void {
  if (resultMemo.size <= RESULT_MEMO_SWEEP_SIZE) return;
  for (const [key, entry] of resultMemo) {
    if (entry.expiresAt <= now) resultMemo.delete(key);
  }
}

/**
 * TEST-ONLY — reset the scheduler's module state (slots, queues, dedupe maps) so
 * concurrency tests are independent. Never call from production code: dropping the
 * queues loses scheduled work.
 */
export function __resetGitExecSchedulerForTests(): void {
  activeSpawns = 0;
  interactiveQueue.length = 0;
  normalQueue.length = 0;
  inFlightByKey.clear();
  resultMemo.clear();
}

function exitCodeOf(err: ExecFileException | null, hadError: boolean): number | null {
  if (!err) return hadError ? null : 0;
  return typeof err.code === "number" ? err.code : null;
}

/**
 * Run git and resolve with {stdout, stderr, code, error} — NEVER rejects on a
 * non-zero exit. Use this when the exit code itself is meaningful (e.g.
 * `diff --quiet`, allowed-exit-code probes) or when failures should be swallowed.
 *
 * Every call goes through the process-wide spawn semaphore, and read-only calls
 * (see `DEDUPE_SAFE_SUBCOMMANDS`) additionally go through the dedupe memo (#398).
 */
export function gitExec(args: string[], opts: GitExecOptions = {}): Promise<GitExecResult> {
  // Resolve the scheduling lane HERE, synchronously, while still inside the caller's
  // async context — the queued callback in `scheduleSpawn` runs later, outside it.
  if (opts.priority === undefined) {
    const ambient = ambientGitPriority.getStore();
    if (ambient !== undefined) opts = { ...opts, priority: ambient };
  }
  const key = dedupeKeyFor(args, opts);
  if (key === null) {
    // Potentially mutating (or dedupe-disqualified): conservatively drop memoized
    // reads for this cwd both before it runs (don't serve a stale read scheduled
    // after the mutation was requested) and after it completes (the state change
    // lands at completion).
    invalidateMemoForCwd(opts.cwd);
    return scheduleSpawn(args, opts).finally(() => invalidateMemoForCwd(opts.cwd));
  }
  const now = Date.now();
  const memo = resultMemo.get(key);
  if (memo) {
    if (memo.expiresAt > now) return Promise.resolve(memo.result);
    resultMemo.delete(key);
  }
  const existing = inFlightByKey.get(key);
  if (existing) return existing;
  const tracked = scheduleSpawn(args, opts)
    .then((result) => {
      // Memoize only results whose process actually ran (code !== null): a spawn
      // failure / kill is environmental and retryable — caching it would convert a
      // transient failure into 1.5s of guaranteed failures. Non-zero exits ARE
      // memoized: for an identical read-only argv they are as deterministic as
      // success (`diff --quiet`'s exit 1 is its answer).
      if (result.code !== null) {
        resultMemo.set(key, { result, expiresAt: Date.now() + GIT_DEDUPE_MEMO_TTL_MS });
        sweepResultMemo(Date.now());
      }
      return result;
    })
    .finally(() => inFlightByKey.delete(key));
  inFlightByKey.set(key, tracked);
  return tracked;
}

/** The raw buffered spawn — exactly one `execFile("git", …)` site, wrapped by the scheduler above. */
function spawnBuffered(args: string[], opts: GitExecOptions, startedMs: number): Promise<GitExecResult> {
  const { cwd, timeout = DEFAULT_GIT_TIMEOUT_MS, maxBuffer = DEFAULT_MAX_BUFFER, env, input, probeLabel } = opts;
  // #359 — the child's OWN lifetime, captured on its `exit` event, separately from the
  // call-to-callback figure below.
  //
  // Why this exists: `recordOperation` used to receive only `Date.now() - startedMs` measured
  // INSIDE the execFile callback, which Node delivers after stdio close AND after whatever else is
  // queued on the event loop. So a 90ms git process behind a congested loop was recorded as a
  // multi-second "git call", and with ~130 spawns per monitor cycle the metric inflated
  // arbitrarily. That is what produced `rev-parse` averages of 9,231ms and 9,153ms on two
  // independent cycles — 1% apart, implausibly stable for disk work — alongside `blockingMs: 0`,
  // while an out-of-process harness measures `git --version` at 88-138ms on this machine. Several
  // confident conclusions (a per-spawn tax, a git-specific penalty, an antivirus story) were drawn
  // from that number and are invalidated by this split.
  //
  // `exit` still arrives through the event loop, so this is a tighter bound rather than a perfect
  // one; read it beside the event-loop delay the monitor reports for the same window. Since #398,
  // `startedMs` is taken when the call ENTERS the scheduler, so `totalMs - childMs` also counts
  // explicit spawn-queue wait — deliberately, that difference still means "time not spent in git".
  let childExitMs: number | undefined;
  return new Promise((resolve) => {
    const child = execFile("git", args, { cwd, timeout, maxBuffer, windowsHide: true, env: nonInteractiveEnv(env) }, (err, stdout, stderr) => {
      const totalMs = Date.now() - startedMs;
      const childMs = childExitMs === undefined ? undefined : childExitMs - startedMs;
      recordOperation(
        probeLabel ?? gitOperationLabel(args),
        totalMs,
        false,
        // A control probe carries no call identity on purpose — see `probeLabel`.
        probeLabel === undefined ? spawnDedupeKey(args, cwd) : undefined,
        childMs,
      );
      let error: Error | null = err;
      // `spawn git ENOENT` conflates two very different failures (#271): a missing WORKING
      // DIRECTORY (deleted repo — deterministic, act on the project) and the git BINARY not
      // spawning (PATH broken or process/handle exhaustion — environmental, retryable).
      // Disambiguate here, at the single spawn site, so every caller reports the real cause.
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        error = cwd && !existsSync(cwd)
          ? new Error(`working directory does not exist: ${cwd} (repo deleted or moved?)`)
          : new Error("git could not be spawned (ENOENT) with the working directory present — PATH problem or process/handle exhaustion, NOT a missing repo");
      }
      resolve({
        stdout: stdout == null ? "" : stdout.toString(),
        stderr: stderr == null ? "" : stderr.toString(),
        code: exitCodeOf(err, err != null),
        error,
        timing: { totalMs, childMs: childMs ?? null },
      });
    });
    // Registered before any await point so a fast-exiting child cannot beat the listener.
    child.once("exit", () => { childExitMs = Date.now(); });
    if (input != null) child.stdin?.end(input);
  });
}

/**
 * Run git and resolve with raw stdout, rejecting with a normalised
 * `git <args> failed: <stderr|message>` Error on any non-zero exit. The standard
 * choice for commands whose output you want and whose failure should propagate.
 */
export async function gitExecOrThrow(args: string[], opts: GitExecOptions): Promise<string> {
  const result = await gitExec(args, opts);
  if (result.error) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.error.message}`);
  }
  return result.stdout;
}

export interface GitExecSyncOptions extends GitExecOptions {
  /** child_process stdio config; defaults to capturing stdout only. */
  stdio?: StdioOptions;
}

/**
 * Synchronous git. Returns stdout as a string (empty when stdout is not piped via
 * `stdio`). Throws the standard `execFileSync` error on a non-zero exit — preserve
 * the try/catch-as-boolean idiom (`diff --quiet`) by catching it.
 *
 * NOT scheduled through the #398 semaphore: a synchronous spawn cannot queue without
 * blocking the event loop even harder, and gitExecSync is being retired by a separate
 * ticket. It DOES conservatively invalidate the dedupe memo for its cwd, since it may
 * mutate state a memoized read would then misreport.
 */
export function gitExecSync(args: string[], opts: GitExecSyncOptions): string {
  const { cwd, timeout = DEFAULT_GIT_TIMEOUT_MS, maxBuffer = DEFAULT_MAX_BUFFER, env, stdio } = opts;
  const startedMs = Date.now();
  const sub = effectiveSubcommand(args);
  if (sub === null || !DEDUPE_SAFE_SUBCOMMANDS.has(sub)) invalidateMemoForCwd(cwd);
  try {
    const out = execFileSync("git", args, { cwd, timeout, maxBuffer, windowsHide: true, encoding: "utf8", stdio, env: nonInteractiveEnv(env) });
    return (out ?? "").toString();
  } finally {
    // `blocking: true` — this spawn holds the event loop for its whole duration, with a
    // ten-minute default ceiling. The `finally` matters: the try/catch-as-boolean idiom
    // (`diff --quiet`) throws on the interesting path, and an unrecorded throw would make the
    // most expensive calls the invisible ones (#359).
    // A synchronous spawn has no callback queue to wait in, so its wall clock IS the child's
    // lifetime — reported as both so `totalMs - childMs` reads 0 for sync calls and isolates the
    // async queue wait (#359).
    const elapsed = Date.now() - startedMs;
    recordOperation(gitOperationLabel(args), elapsed, true, spawnDedupeKey(args, cwd), elapsed);
  }
}

/**
 * Identity of one git invocation — the working directory plus the full argv.
 *
 * Feeds the duplicate-spawn accounting in `operation-metrics`: an open measurement window counts
 * how many spawns inside it repeated a spawn it had already seen. That measurement (5-9 of 33-58
 * `rev-parse` spawns per cycle were exact repeats, 7-25% of all git spawns, median 12% — five
 * consecutive live cycles on 57 active workspaces) originally REFUTED #359's cycle-lifetime memo
 * proposal: a cache living as long as a monitor cycle could not produce a measurable win and would
 * have sat next to the merge-gate SHAs that #243 compares before and after a gate run. #398 then
 * implemented a different thing the same measurement JUSTIFIES: a ~1.5s memo at the adapter
 * (`DEDUPE_SAFE_SUBCOMMANDS` above) that collapses exactly those measured repeats while being
 * invalidated by any adapter-driven mutation — the #243 hazard the cycle-lifetime design had.
 * Note the dedupe layer uses its own stricter key (`dedupeKeyFor`, which also includes timeout and
 * maxBuffer); this one stays coarse because it only labels metrics.
 */
function spawnDedupeKey(args: string[], cwd: string | undefined): string {
  return `${cwd ?? ""} ${args.join(" ")}`;
}

/**
 * The subcommand a git argv will execute, skipping global flags and their values
 * (`-c k=v`, `--git-dir X`, …). `null` for flag-only invocations like `--version`.
 * Shared by the metric label and the #398 read-only classification.
 */
function effectiveSubcommand(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-c" || arg === "--git-dir" || arg === "-C" || arg === "--work-tree") { i++; continue; }
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return null;
}

/**
 * Low-cardinality label for one git invocation: `git:status`, `git:rev-list`.
 *
 * The subcommand only — never a path, a ref or an id. `operation-metrics` is a live map with no
 * eviction, so an unbounded label set would be a slow leak, and "which git subcommand costs the
 * seconds" is the question #359 needs answered anyway. A leading `-c core.foo=bar` is skipped so
 * config-prefixed calls land on the same label as their bare equivalents.
 */
function gitOperationLabel(args: string[]): string {
  const sub = effectiveSubcommand(args);
  return sub === null ? "git:unknown" : `git:${sub}`;
}

/**
 * Streaming git for protocol plumbing (`upload-pack`/`receive-pack`
 * `--stateless-rpc`, used by the worker-fleet git smart-HTTP service). Returns
 * the raw ChildProcess with piped stdio so the caller can pipe an HTTP request
 * body into stdin and stream stdout back out — the buffered variants above
 * cannot carry multi-hundred-MB packfiles. Still the ONE sanctioned spawn site:
 * callers get a process handle, not the right to spawn git themselves.
 * Exempt from the #398 semaphore: its lifetime is bounded by the HTTP request.
 */
export function gitStream(args: string[], opts: Pick<GitExecOptions, "cwd" | "env"> = {}): ChildProcess {
  return spawn("git", args, {
    cwd: opts.cwd,
    env: nonInteractiveEnv(opts.env),
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

// The worker half of running a verify job for the board (#1437). The board sends `verify_job`; this
// checks the EXACT sha out into a throwaway worktree of the worker's own clone (git transport),
// installs, runs the project's verify script with bounded workers, and reports: progress frames
// while it runs, the full log as chunk frames, then one `verify_result`.
//
// Three rules, each the worker's side of #1428's trust boundary:
//   1. THE SHA IS THE JOB. After checkout the worker reads HEAD back and REFUSES (`sha_mismatch`) when
//      it is not the sha the board sent; the result carries the sha actually verified, never an echo.
//   2. A REFUSAL IS NEVER A PASS. No slot, a sha it cannot fetch, a failed install: `passed:false`
//      with `refused` set, so the board treats it as "not verified", not as red or green.
//   3. BOUNDED. `slots` caps concurrent jobs; the verify child gets `KANBAN_TEST_MAX_WORKERS`.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitExec, gitExecOrThrow } from "@agentic-kanban/shared/lib/git-exec";
import { execSucceeded } from "@agentic-kanban/shared/lib/exec-result";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import type { WorkerToBoardMessage } from "@agentic-kanban/shared/lib/worker-protocol";
import {
  VERIFY_LOG_TAIL_BYTES,
  chunkVerifyLog,
  type VerifyCancelFrame,
  type VerifyJobFrame,
  type VerifyLiveJobsFrame,
  type VerifyRefusal,
  type VerifyResultFrame,
  type VerifyStage,
  type WorkerVerifyCapability,
} from "@agentic-kanban/shared/lib/worker-verify-protocol";
import { killProcessTree } from "../services/process-exec.js";
import { stripCheckoutPrefix } from "../services/failed-suite-parse.js";
import { composeGitUrl, deriveFallbackSetupCommand, gitAuthEnv } from "./worker-repo.js";

export type CheckoutOutcome = { ok: true; dir: string; sha: string } | { ok: false; refused: VerifyRefusal; reason: string; sha?: string };
export interface ScriptOutcome { exitCode: number; timedOut: boolean; output: string }

export interface VerifyRunnerDeps {
  workRoot: string;
  boardUrl: () => string;
  sendToBoard: (message: WorkerToBoardMessage) => void;
  log: (line: string) => void;
  slots: number;
  ramGb: number;
  /** Fetch + check out `job.sha` detached in a throwaway dir. Injectable for tests. */
  prepareCheckout?: (job: VerifyJobFrame) => Promise<CheckoutOutcome>;
  /** Run a shell script in `dir`, streaming output through `onOutput`. Injectable for tests. */
  runScript?: (dir: string, script: string, opts: { timeoutMs: number; env: Record<string, string>; onOutput: (chunk: string) => void; signal?: AbortSignal }) => Promise<ScriptOutcome>;
  /** Remove the throwaway checkout. Injectable for tests. */
  cleanup?: (job: VerifyJobFrame, dir: string) => Promise<void>;
  /** #1465: true while the board socket is open. Absent = always connected (frames are never held back). */
  isConnected?: () => boolean;
  /** #1465: where a finished job's frames wait for delivery. Absent = in memory only. Injectable for tests. */
  store?: VerifyResultStore;
}

/** #1465: durable store for the frames of a job that finished (like #1444's undelivered session results). */
export interface VerifyResultStore {
  save(jobId: string, entry: StoredVerifyResult): void;
  remove(jobId: string): void;
  loadAll(): Array<{ jobId: string; entry: StoredVerifyResult }>;
}
export interface StoredVerifyResult { finishedAt: number; frames: WorkerToBoardMessage[] }

/** A buffered verdict older than this is useless: the board gave the job up after its reconnect grace. */
export const VERIFY_RESULT_RETENTION_MS = 30 * 60 * 1000;
export const VERIFY_RESULT_PRUNE_INTERVAL_MS = 5 * 60 * 1000;

/**
 * One JSON file per job under `<workRoot>/verify-results-retained/`; every failure is swallowed (best effort).
 * #1495: the board does not ack, so the dir holds EVERY recent result, delivered or not (was `verify-undelivered`).
 */
export function createFileVerifyResultStore(workRoot: string): VerifyResultStore {
  const dir = join(workRoot, "verify-results-retained");
  const file = (jobId: string): string => join(dir, `${jobId.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
  return {
    save(jobId, entry) { try { mkdirSync(dir, { recursive: true }); writeFileSync(file(jobId), JSON.stringify({ jobId, ...entry })); } catch { /* memory copy still delivers */ } },
    remove(jobId) { try { rmSync(file(jobId), { force: true }); } catch { /* gone */ } },
    loadAll() {
      try {
        return readdirSync(dir).filter((f) => f.endsWith(".json")).flatMap((f) => {
          try {
            const raw = JSON.parse(readFileSync(join(dir, f), "utf8")) as { jobId?: string } & Partial<StoredVerifyResult>;
            return typeof raw.jobId === "string" && Array.isArray(raw.frames) && typeof raw.finishedAt === "number" ? [{ jobId: raw.jobId, entry: { finishedAt: raw.finishedAt, frames: raw.frames } }] : [];
          } catch { return []; }
        });
      } catch { return []; }
    },
  };
}

export interface DaemonVerifyRunner {
  /** Takes a `verify_job` frame; true when the message was one (and is consumed). */
  handle(message: { type: string }): boolean;
  /** What this worker declares in its heartbeat. */
  capability(): WorkerVerifyCapability;
  /** #1517: stage and file counts of every running job, for `worker status`. */
  jobs(): VerifyJobStatus[];
  /** #1465: call right after `hello` on every (re)connect: re-announces running jobs and delivers buffered verdicts. */
  onConnected(): void;
  /** #1489: kill the job's process tree and remove its checkout; true when the job was running or buffered. */
  cancel(jobId: string): boolean;
  /** #1489: the board's set of wanted job ids; every running job (and buffered verdict) outside it is reaped. */
  reapExcept(liveJobIds: readonly string[]): string[];
}

const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const FILE_MARKER_RE = /^\s*(?:[\u2713\u221a\u00d7\u2717\u2718]|FAIL\b|\u276f)\s+\S+\.(?:test|spec)\.[cm]?[jt]sx?/;
const FILES_SUMMARY_RE = /Test Files\s+(?:(\d+) failed\s*\|\s*)?(\d+) passed(?:\s*\|[^()]*)?\s*\((\d+)\)/;

/**
 * #1517: cumulative vitest file progress over a whole script run. Colour codes are stripped (a worker
 * with FORCE_COLOR printed `ESC[32m✓` and no marker line ever matched), lines are buffered across
 * chunks, and counts only grow: a `test:mine` run is several vitest invocations, each ending in its
 * own `Test Files` summary, so a summary banks its files and the next package counts on top.
 */
export function createVerifyProgressTracker(): { push(chunk: string): void; snapshot(): { filesDone: number; filesTotal?: number } } {
  let pending = "";
  let banked = 0;
  let current = 0;
  let total: number | undefined;
  const consume = (raw: string): void => {
    const line = raw.replace(ANSI_RE, "");
    const summary = FILES_SUMMARY_RE.exec(line);
    if (summary) { banked += Number(summary[3]); current = 0; total = banked; return; }
    if (FILE_MARKER_RE.test(line)) current++;
  };
  return {
    push(chunk) {
      const lines = (pending + chunk).split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const l of lines) consume(l);
    },
    snapshot: () => ({ filesDone: banked + current, ...(total !== undefined ? { filesTotal: total } : {}) }),
  };
}

/** vitest pass/fail marker lines and its `Test Files  N passed (M)` summary, for progress (one-shot form of the tracker). */
export function parseVerifyProgress(output: string): { filesDone: number; filesTotal?: number } {
  const t = createVerifyProgressTracker();
  t.push(`${output}\n`);
  const snap = t.snapshot();
  return snap.filesTotal !== undefined ? { filesDone: snap.filesTotal, filesTotal: snap.filesTotal } : snap;
}

/** #1517: one running verify job as `worker status` shows it. */
export interface VerifyJobStatus { jobId: string; tier: string; sha: string; stage: VerifyStage; filesDone?: number; filesTotal?: number; startedAt: string }

/** Test files the output names as failed (`FAIL <path>`), sorted + deduped. */
export function parseVerifyFailingSuites(output: string): string[] {
  const found = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const m = /(?:^|\s)(?:FAIL|\u00d7|\u2717|\u2718)\s+\[?\s*([^\s>\]]+\.(?:test|spec)\.[cm]?[jt]sx?)/.exec(line);
    if (m) found.add(stripCheckoutPrefix(m[1]));
  }
  return [...found].sort();
}

async function defaultPrepareCheckout(deps: VerifyRunnerDeps, job: VerifyJobFrame): Promise<CheckoutOutcome> {
  const repo = { ...job.auth, baseBranch: "" };
  const url = composeGitUrl(deps.boardUrl(), repo);
  const env = gitAuthEnv(repo);
  const cacheDir = join(deps.workRoot, "repos", job.auth.projectId);
  mkdirSync(join(deps.workRoot, "repos"), { recursive: true });
  try {
    if (!existsSync(join(cacheDir, ".git"))) {
      await gitExecOrThrow(["clone", url, cacheDir], { timeout: 10 * 60 * 1000, env });
    } else {
      await gitExecOrThrow(["fetch", url, "+refs/heads/*:refs/remotes/origin/*", "--prune"], { cwd: cacheDir, timeout: 10 * 60 * 1000, env });
    }
  } catch (err) {
    return { ok: false, refused: "fetch_failed", reason: errorMessage(err) };
  }
  let have = await gitExec(["cat-file", "-e", `${job.sha}^{commit}`], { cwd: cacheDir });
  if (!execSucceeded(have)) {
    // A staging or detached tip no branch points at: ask for the sha itself.
    await gitExec(["fetch", url, job.sha], { cwd: cacheDir, timeout: 10 * 60 * 1000, env });
    have = await gitExec(["cat-file", "-e", `${job.sha}^{commit}`], { cwd: cacheDir });
  }
  if (!execSucceeded(have)) return { ok: false, refused: "sha_unavailable", reason: `this worker cannot fetch ${job.sha} from the board` };
  const dir = join(deps.workRoot, "verify", job.jobId);
  mkdirSync(join(deps.workRoot, "verify"), { recursive: true });
  try {
    await gitExecOrThrow(["worktree", "add", "--detach", dir, job.sha], { cwd: cacheDir });
  } catch (err) {
    return { ok: false, refused: "fetch_failed", reason: `worktree add failed: ${errorMessage(err)}` };
  }
  const head = (await gitExec(["rev-parse", "HEAD"], { cwd: dir })).stdout.trim();
  if (head.toLowerCase() !== job.sha.toLowerCase()) return { ok: false, refused: "sha_mismatch", reason: `checkout is ${head || "unreadable"}, the job is for ${job.sha}`, sha: head };
  return { ok: true, dir, sha: head };
}

function defaultRunScript(dir: string, script: string, opts: { timeoutMs: number; env: Record<string, string>; onOutput: (chunk: string) => void; signal?: AbortSignal }): Promise<ScriptOutcome> {
  return new Promise((resolve) => {
    // #1489: detached on POSIX so the whole tree is one process group a cancel can kill (taskkill /T on Windows).
    const child = spawn(script, { cwd: dir, shell: true, windowsHide: true, detached: process.platform !== "win32", env: { ...process.env, ...opts.env } });
    const killTree = (): void => {
      if (child.pid) void killProcessTree(child.pid, { timeout: 10_000, group: true }).catch(() => { try { child.kill(); } catch { /* gone */ } });
      else child.kill();
    };
    if (opts.signal?.aborted) killTree();
    else opts.signal?.addEventListener("abort", killTree, { once: true });
    let output = "";
    let timedOut = false;
    const feed = (d: Buffer): void => { const s = d.toString("utf8"); output += s; opts.onOutput(s); };
    child.stdout?.on("data", feed);
    child.stderr?.on("data", feed);
    const timer = setTimeout(() => { timedOut = true; killTree(); }, opts.timeoutMs);
    timer.unref?.();
    child.on("error", (err) => { clearTimeout(timer); resolve({ exitCode: 1, timedOut, output: `${output}\n${String(err)}` }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ exitCode: code ?? 1, timedOut, output }); });
  });
}

function removeDir(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* locked; the startup sweep retries */ }
}

async function defaultCleanup(deps: VerifyRunnerDeps, job: VerifyJobFrame, dir: string): Promise<void> {
  const cacheDir = join(deps.workRoot, "repos", job.auth.projectId);
  await gitExec(["worktree", "remove", "--force", dir], { cwd: cacheDir }).catch(() => undefined);
  // #1479: `worktree remove` fails on a half-made or locked checkout and the dir then lived forever.
  if (existsSync(dir)) {
    removeDir(dir);
    await gitExec(["worktree", "prune"], { cwd: cacheDir }).catch(() => undefined);
  }
}

/**
 * #1479: remove every `<workRoot>/verify/<jobId>` that is not in `keep` (call at daemon start, when nothing runs),
 * then prune the clones' dangling worktree records. Returns the job ids reaped.
 */
export function sweepOrphanVerifyCheckouts(workRoot: string, keep: ReadonlySet<string> = new Set()): string[] {
  const root = join(workRoot, "verify");
  let names: string[];
  try { names = readdirSync(root); } catch { return []; }
  const reaped: string[] = [];
  for (const name of names) {
    if (keep.has(name)) continue;
    removeDir(join(root, name));
    reaped.push(name);
  }
  if (reaped.length > 0) {
    try {
      for (const repo of readdirSync(join(workRoot, "repos"))) void gitExec(["worktree", "prune"], { cwd: join(workRoot, "repos", repo) }).catch(() => undefined);
    } catch { /* no clones yet */ }
  }
  return reaped;
}

export function createDaemonVerifyRunner(deps: VerifyRunnerDeps): DaemonVerifyRunner {
  const prepare = deps.prepareCheckout ?? ((job: VerifyJobFrame) => defaultPrepareCheckout(deps, job));
  const run = deps.runScript ?? defaultRunScript;
  const cleanup = deps.cleanup ?? ((job: VerifyJobFrame, dir: string) => defaultCleanup(deps, job, dir));
  const running = new Set<string>();
  /** #1489: one controller per running job; aborting it kills the job's process tree. */
  const controllers = new Map<string, AbortController>();
  const connected = (): boolean => deps.isConnected?.() ?? true;
  /** Latest progress per running job, replayed on reconnect so the board knows the job is alive. */
  const lastProgress = new Map<string, WorkerToBoardMessage>();
  /** #1517: the same progress plus job identity, for `worker status` (the board frame carries no tier/sha). */
  const jobStatus = new Map<string, VerifyJobStatus>();
  /** Finished jobs whose frames may not have reached the board; replayed on every reconnect until retention. */
  const finished = new Map<string, StoredVerifyResult>();
  for (const { jobId, entry } of deps.store?.loadAll() ?? []) finished.set(jobId, entry);
  // #1479: nothing runs yet, so every `verify/<jobId>` on disk is an orphan of a previous daemon.
  const orphans = sweepOrphanVerifyCheckouts(deps.workRoot);
  if (orphans.length > 0) deps.log(`[worker] startup sweep removed ${orphans.length} orphaned verify checkout(s): ${orphans.join(", ")}`);

  const progress = (jobId: string, stage: VerifyStage, extra: { filesDone?: number; filesTotal?: number } = {}): void => {
    const frame: WorkerToBoardMessage = { type: "verify_progress", jobId, stage, ...extra };
    const known = jobStatus.get(jobId);
    if (known) { if (stage === "done") jobStatus.delete(jobId); else Object.assign(known, { stage }, extra); }
    if (stage === "done") lastProgress.delete(jobId); else lastProgress.set(jobId, frame);
    if (stage !== "verify" || extra.filesDone === undefined) deps.log(`[worker] verify job ${jobId} stage ${stage}`); // #1479 (verify ticks are too chatty)
    // While the socket is down the frame is dropped (the replay on reconnect carries the latest one).
    if (connected()) deps.sendToBoard(frame);
  };

  function pruneFinished(): void {
    for (const [jobId, entry] of finished) if (Date.now() - entry.finishedAt > VERIFY_RESULT_RETENTION_MS) { finished.delete(jobId); deps.store?.remove(jobId); }
  }

  // #1495: an idle worker never finishes another job, so retention also needs a clock of its own.
  const pruneTimer = setInterval(pruneFinished, VERIFY_RESULT_PRUNE_INTERVAL_MS);
  pruneTimer.unref?.();
  pruneFinished();

  function finish(job: VerifyJobFrame, started: number, r: Partial<VerifyResultFrame> & { sha: string }, log: string): void {
    // #1489: nobody waits for a cancelled job's verdict; buffering it would replay it on every reconnect.
    if (controllers.get(job.jobId)?.signal.aborted) return;
    deps.log(r.refused
      ? `[worker] verify job ${job.jobId} refused (${r.refused}): ${r.reason ?? ""}`
      : `[worker] verify job ${job.jobId} finished: ${r.passed ? "passed" : "failed"} (exit ${r.exitCode ?? 1}${r.timedOut ? ", timed out" : ""}) in ${Math.round((Date.now() - started) / 1000)}s, sha ${r.sha.slice(0, 9)}, ${connected() ? "sending" : "board socket down, buffered for reconnect"}`);
    const chunks = chunkVerifyLog(log);
    const frames: WorkerToBoardMessage[] = chunks.map((data, seq) => ({ type: "verify_log_chunk", jobId: job.jobId, seq, data }));
    frames.push({
      type: "verify_result",
      jobId: job.jobId,
      tier: job.tier,
      passed: false,
      exitCode: 1,
      timedOut: false,
      failingSuites: [],
      durationMs: Date.now() - started,
      logTail: log.slice(-VERIFY_LOG_TAIL_BYTES),
      logChunks: chunks.length,
      ...r,
    });
    // #1465: keep the verdict and log until the board has had a chance to take them, whatever the socket does.
    const entry: StoredVerifyResult = { finishedAt: Date.now(), frames };
    finished.set(job.jobId, entry);
    deps.store?.save(job.jobId, entry);
    pruneFinished();
    progress(job.jobId, "uploading");
    if (connected()) for (const f of frames) deps.sendToBoard(f);
  }

  async function execute(job: VerifyJobFrame): Promise<void> {
    const started = Date.now();
    const refuse = (refused: VerifyRefusal, reason: string, sha = ""): void =>
      finish(job, started, { sha, refused, reason }, `verify refused (${refused}): ${reason}`);
    if (running.size >= deps.slots) return refuse("no_free_slot", `this worker runs ${deps.slots} verify job(s) at a time`);
    running.add(job.jobId);
    jobStatus.set(job.jobId, { jobId: job.jobId, tier: job.tier, sha: job.sha, stage: "fetch", startedAt: new Date().toISOString() });
    deps.log(`[worker] verify job ${job.jobId} started: ${job.tier} @ ${job.sha.slice(0, 9)} (${running.size}/${deps.slots} slots busy)`);
    const ctl = new AbortController();
    controllers.set(job.jobId, ctl);
    let dir: string | null = null;
    let dataDir: string | null = null;
    try {
      // The board's gate sets AGENTIC_KANBAN_DIR to a temp dir on ITS disk (#231 isolation); on
      // this machine that path does not exist and every DB-backed suite died with ENOENT mkdir
      // (trains 2026-10-14-40/41: 219 suites). Keep the isolation, but on a dir of our own.
      const jobEnv = { ...(job.env ?? {}) };
      if (jobEnv.AGENTIC_KANBAN_DIR) {
        dataDir = mkdtempSync(join(tmpdir(), "kanban-verify-gate-"));
        jobEnv.AGENTIC_KANBAN_DIR = dataDir;
      }
      progress(job.jobId, "fetch");
      const co = await prepare(job);
      if (!co.ok) return refuse(co.refused, co.reason, co.sha);
      dir = co.dir;
      if (ctl.signal.aborted) return;
      progress(job.jobId, "install");
      const install = (job.setupScript ?? deriveFallbackSetupCommand(co.dir) ?? "").trim();
      let log = "";
      if (install) {
        const inst = await run(co.dir, install, { timeoutMs: Math.min(job.timeoutMs, 30 * 60 * 1000), env: jobEnv, onOutput: () => undefined, signal: ctl.signal });
        log += `$ ${install}\n${inst.output}\n`;
        if (ctl.signal.aborted) return;
        if (inst.exitCode !== 0 || inst.timedOut) return refuse("setup_failed", `\`${install}\` ${inst.timedOut ? "timed out" : `exited ${inst.exitCode}`}`, co.sha);
      }
      progress(job.jobId, "verify");
      let lastReport = 0;
      const tracker = createVerifyProgressTracker();
      const env = { ...jobEnv, ...(job.maxWorkers ? { KANBAN_TEST_MAX_WORKERS: String(job.maxWorkers) } : {}), ...(job.scope ? { KANBAN_RETRY_TEST_FILES: job.scope } : {}) };
      const out = await run(co.dir, job.script, {
        timeoutMs: job.timeoutMs,
        env,
        signal: ctl.signal,
        onOutput: (chunk) => {
          tracker.push(chunk);
          if (Date.now() - lastReport < 2000) return;
          lastReport = Date.now();
          progress(job.jobId, "verify", tracker.snapshot());
        },
      });
      log += out.output;
      progress(job.jobId, "verify", tracker.snapshot()); // the throttle may have swallowed the last ticks
      finish(job, started, {
        sha: co.sha,
        passed: out.exitCode === 0 && !out.timedOut,
        exitCode: out.exitCode,
        timedOut: out.timedOut,
        failingSuites: parseVerifyFailingSuites(out.output),
      }, log);
    } catch (err) {
      deps.log(`[worker] verify job ${job.jobId} errored: ${errorMessage(err)}`);
      refuse("fetch_failed", errorMessage(err));
    } finally {
      running.delete(job.jobId);
      controllers.delete(job.jobId);
      // #1479: a refused/half-made checkout never set `dir`, but the default path may exist on disk.
      const stray = dir ?? (existsSync(join(deps.workRoot, "verify", job.jobId)) ? join(deps.workRoot, "verify", job.jobId) : null);
      if (stray) await cleanup(job, stray).catch(() => undefined);
      if (dataDir) try { rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* temp dir, reaped later */ }
      progress(job.jobId, "done");
    }
  }

  return {
    handle(message) {
      if (message.type === "verify_cancel") { this.cancel((message as VerifyCancelFrame).jobId); return true; }
      if (message.type === "verify_live_jobs") { this.reapExcept((message as VerifyLiveJobsFrame).jobIds); return true; }
      if (message.type !== "verify_job") return false;
      const job = message as VerifyJobFrame;
      void execute(job).catch((err) => deps.log(`[worker] verify job ${job.jobId} crashed: ${errorMessage(err)}`));
      return true;
    },
    cancel(jobId) {
      const ctl = controllers.get(jobId);
      const buffered = finished.delete(jobId);
      if (buffered) deps.store?.remove(jobId);
      lastProgress.delete(jobId);
      if (!ctl) return buffered;
      deps.log(`[worker] verify job ${jobId} cancelled by the board: killing its process tree and removing its checkout`);
      ctl.abort();
      return true;
    },
    reapExcept(liveJobIds) {
      const live = new Set(liveJobIds);
      const gone = [...new Set([...controllers.keys(), ...finished.keys()])].filter((id) => !live.has(id));
      for (const id of gone) this.cancel(id);
      if (gone.length > 0) deps.log(`[worker] board no longer wants ${gone.length} verify job(s) (${gone.join(", ")}): reaped`);
      return gone;
    },
    jobs: () => [...jobStatus.values()].map((j) => ({ ...j })),
    capability: () => ({ slots: deps.slots, freeSlots: Math.max(0, deps.slots - running.size), ramGb: deps.ramGb, jobIds: [...running] }),
    onConnected() {
      pruneFinished();
      deps.log(`[worker] verify re-sync on connect: running [${[...running].join(", ")}], buffered verdicts [${[...finished.keys()].join(", ")}], ${Math.max(0, deps.slots - running.size)}/${deps.slots} slots free`);
      for (const jobId of running) { const f = lastProgress.get(jobId); if (f) deps.sendToBoard(f); }
      for (const entry of finished.values()) for (const f of entry.frames) deps.sendToBoard(f);
    },
  };
}

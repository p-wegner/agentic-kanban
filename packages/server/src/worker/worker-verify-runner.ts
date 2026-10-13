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
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { gitExec, gitExecOrThrow } from "@agentic-kanban/shared/lib/git-exec";
import { execSucceeded } from "@agentic-kanban/shared/lib/exec-result";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import type { WorkerToBoardMessage } from "@agentic-kanban/shared/lib/worker-protocol";
import {
  VERIFY_LOG_TAIL_BYTES,
  chunkVerifyLog,
  type VerifyJobFrame,
  type VerifyRefusal,
  type VerifyResultFrame,
  type VerifyStage,
  type WorkerVerifyCapability,
} from "@agentic-kanban/shared/lib/worker-verify-protocol";
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
  runScript?: (dir: string, script: string, opts: { timeoutMs: number; env: Record<string, string>; onOutput: (chunk: string) => void }) => Promise<ScriptOutcome>;
  /** Remove the throwaway checkout. Injectable for tests. */
  cleanup?: (job: VerifyJobFrame, dir: string) => Promise<void>;
}

export interface DaemonVerifyRunner {
  /** Takes a `verify_job` frame; true when the message was one (and is consumed). */
  handle(message: { type: string }): boolean;
  /** What this worker declares in its heartbeat. */
  capability(): WorkerVerifyCapability;
}

/** vitest pass/fail marker lines and its `Test Files  N passed (M)` summary, for progress. */
export function parseVerifyProgress(output: string): { filesDone: number; filesTotal?: number } {
  let done = 0;
  for (const line of output.split(/\r?\n/)) if (/^\s*(?:[\u2713\u221a\u00d7\u2717\u2718]|FAIL\b|\u276f)\s+\S+\.(?:test|spec)\.[cm]?[jt]sx?/.test(line)) done++;
  const summary = /Test Files\s+(?:(\d+) failed\s*\|\s*)?(\d+) passed(?:\s*\|[^()]*)?\s*\((\d+)\)/.exec(output);
  return summary ? { filesDone: Number(summary[3]), filesTotal: Number(summary[3]) } : { filesDone: done };
}

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

function defaultRunScript(dir: string, script: string, opts: { timeoutMs: number; env: Record<string, string>; onOutput: (chunk: string) => void }): Promise<ScriptOutcome> {
  return new Promise((resolve) => {
    const child = spawn(script, { cwd: dir, shell: true, windowsHide: true, env: { ...process.env, ...opts.env } });
    let output = "";
    let timedOut = false;
    const feed = (d: Buffer): void => { const s = d.toString("utf8"); output += s; opts.onOutput(s); };
    child.stdout?.on("data", feed);
    child.stderr?.on("data", feed);
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, opts.timeoutMs);
    timer.unref?.();
    child.on("error", (err) => { clearTimeout(timer); resolve({ exitCode: 1, timedOut, output: `${output}\n${String(err)}` }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ exitCode: code ?? 1, timedOut, output }); });
  });
}

async function defaultCleanup(deps: VerifyRunnerDeps, job: VerifyJobFrame, dir: string): Promise<void> {
  const cacheDir = join(deps.workRoot, "repos", job.auth.projectId);
  await gitExec(["worktree", "remove", "--force", dir], { cwd: cacheDir }).catch(() => undefined);
}

export function createDaemonVerifyRunner(deps: VerifyRunnerDeps): DaemonVerifyRunner {
  const prepare = deps.prepareCheckout ?? ((job: VerifyJobFrame) => defaultPrepareCheckout(deps, job));
  const run = deps.runScript ?? defaultRunScript;
  const cleanup = deps.cleanup ?? ((job: VerifyJobFrame, dir: string) => defaultCleanup(deps, job, dir));
  const running = new Set<string>();

  const progress = (jobId: string, stage: VerifyStage, extra: { filesDone?: number; filesTotal?: number } = {}): void =>
    deps.sendToBoard({ type: "verify_progress", jobId, stage, ...extra });

  function finish(job: VerifyJobFrame, started: number, r: Partial<VerifyResultFrame> & { sha: string }, log: string): void {
    const chunks = chunkVerifyLog(log);
    progress(job.jobId, "uploading");
    chunks.forEach((data, seq) => deps.sendToBoard({ type: "verify_log_chunk", jobId: job.jobId, seq, data }));
    deps.sendToBoard({
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
  }

  async function execute(job: VerifyJobFrame): Promise<void> {
    const started = Date.now();
    const refuse = (refused: VerifyRefusal, reason: string, sha = ""): void =>
      finish(job, started, { sha, refused, reason }, `verify refused (${refused}): ${reason}`);
    if (running.size >= deps.slots) return refuse("no_free_slot", `this worker runs ${deps.slots} verify job(s) at a time`);
    running.add(job.jobId);
    let dir: string | null = null;
    try {
      progress(job.jobId, "fetch");
      const co = await prepare(job);
      if (!co.ok) return refuse(co.refused, co.reason, co.sha);
      dir = co.dir;
      progress(job.jobId, "install");
      const install = (job.setupScript ?? deriveFallbackSetupCommand(co.dir) ?? "").trim();
      let log = "";
      if (install) {
        const inst = await run(co.dir, install, { timeoutMs: Math.min(job.timeoutMs, 30 * 60 * 1000), env: job.env ?? {}, onOutput: () => undefined });
        log += `$ ${install}\n${inst.output}\n`;
        if (inst.exitCode !== 0 || inst.timedOut) return refuse("setup_failed", `\`${install}\` ${inst.timedOut ? "timed out" : `exited ${inst.exitCode}`}`, co.sha);
      }
      progress(job.jobId, "verify");
      let lastReport = 0;
      let seen = "";
      const env = { ...(job.env ?? {}), ...(job.maxWorkers ? { KANBAN_TEST_MAX_WORKERS: String(job.maxWorkers) } : {}), ...(job.scope ? { KANBAN_RETRY_TEST_FILES: job.scope } : {}) };
      const out = await run(co.dir, job.script, {
        timeoutMs: job.timeoutMs,
        env,
        onOutput: (chunk) => {
          seen = (seen + chunk).slice(-64 * 1024);
          if (Date.now() - lastReport < 2000) return;
          lastReport = Date.now();
          progress(job.jobId, "verify", parseVerifyProgress(seen));
        },
      });
      log += out.output;
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
      if (dir) await cleanup(job, dir).catch(() => undefined);
      progress(job.jobId, "done");
    }
  }

  return {
    handle(message) {
      if (message.type !== "verify_job") return false;
      const job = message as VerifyJobFrame;
      void execute(job).catch((err) => deps.log(`[worker] verify job ${job.jobId} crashed: ${errorMessage(err)}`));
      return true;
    },
    capability: () => ({ slots: deps.slots, freeSlots: Math.max(0, deps.slots - running.size), ramGb: deps.ramGb }),
  };
}

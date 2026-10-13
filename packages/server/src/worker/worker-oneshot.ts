// Worker-side one-shot agent jobs (#1431): run ONE prompt through the provider CLI and answer
// with the text. The session runner (worker-agent-runner.ts) owns long-lived assignments; this is
// the short request/response sibling, kept out of it so that file does not grow.
//
// With `repo` the job runs in a fresh checkout of the requested branch (read-only review prompts,
// the merge-train fix agent); without it the job runs in a scratch directory, because a prompt
// with no repo context needs no checkout. An `allowEdits` job commits whatever the agent left and
// pushes HEAD to the request's incoming ref, which is how the board gets the fix back.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitExec, gitExecOrThrow } from "@agentic-kanban/shared/lib/git-exec";
import { execSucceeded } from "@agentic-kanban/shared/lib/exec-result";
import { sanitizeUtf8 } from "@agentic-kanban/shared/lib/sanitize-utf8";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import type {
  BoardToWorkerMessage,
  WorkerLaunchSpec,
  WorkerOneShotRequest,
  WorkerOneShotResult,
  WorkerToBoardMessage,
} from "@agentic-kanban/shared/lib/worker-protocol";
import { killProcessTree } from "../services/process-exec.js";
import { startSessionTemp, releaseSessionTemp } from "../lib/session-temp-dir.js";
import type { ProfileAlias } from "../lib/local-profile-discovery.js";
import { resolveSpecCommand } from "./worker-command-resolver.js";
import { applyProfileToSpec } from "./worker-profiles.js";
import { applyHarnessToSpec, type WorkerHarness } from "./worker-harness.js";
import {
  cleanupWorkerCheckout,
  defaultWorkerWorkRoot,
  provisionWorkerCheckout,
  pushWorkerResult,
  type WorkerCheckout,
} from "./worker-repo.js";
import { workerLog } from "./worker-updater.js";

/** Same ceiling the host's `execFile` had (`maxBuffer`): a reply past it is truncated, not fatal. */
const MAX_STDOUT_BYTES = 1024 * 1024;

export interface WorkerOneShotOptions {
  send: (message: WorkerToBoardMessage) => void;
  boardUrl?: string | (() => string);
  workRoot?: string;
  harness?: WorkerHarness;
  profileAliases?: ProfileAlias[];
  profileHome?: string;
  /** True while the daemon is draining for an update: it takes no new work. */
  isDraining?: () => boolean;
  /** Test seams for the git side. */
  repoOps?: {
    provision?: typeof provisionWorkerCheckout;
    push?: typeof pushWorkerResult;
    cleanup?: typeof cleanupWorkerCheckout;
  };
}

type Outcome = Pick<WorkerOneShotResult, "ok" | "text" | "error" | "launchFailed" | "pushedSha">;

/** Commit what the agent left uncommitted, then say which commit HEAD is if it moved past `startSha`. */
async function commitAndReadHead(cwd: string, startSha: string): Promise<string | null> {
  const status = await gitExec(["status", "--porcelain"], { cwd });
  if (execSucceeded(status) && status.stdout.trim()) {
    await gitExecOrThrow(["add", "-A"], { cwd });
    await gitExecOrThrow(["commit", "-m", "chore: one-shot agent changes"], { cwd });
  }
  const head = (await gitExecOrThrow(["rev-parse", "HEAD"], { cwd })).trim();
  return head === startSha ? null : head;
}

/** Spawn the agent, feed it the prompt, collect stdout. Resolves with the outcome; never rejects. */
function runAgentProcess(spec: WorkerLaunchSpec, request: WorkerOneShotRequest, cwd: string): Promise<Outcome> {
  const { job, requestId } = request;
  const launch = resolveSpecCommand(spec);
  const tempKey = `oneshot-${requestId}`;
  return new Promise<Outcome>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const env = {
      ...process.env,
      ...spec.env,
      // The cross-worktree write guard (#369) confines an editing agent to its own checkout.
      ...(job.allowEdits ? { KANBAN_WORKTREE_DIR: cwd } : {}),
      ...startSessionTemp(tempKey),
    };
    const done = (outcome: Outcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      releaseSessionTemp(tempKey);
      resolve(outcome);
    };
    const proc = spawn(launch.command, spec.args, {
      cwd, env, shell: launch.useShell, detached: process.platform !== "win32", windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      if (proc.pid) void killProcessTree(proc.pid, { timeout: 5000, signal: "SIGTERM", group: true }).catch(() => undefined);
    }, job.timeoutMs);
    proc.stdout?.on("data", (chunk: Buffer) => { if (stdout.length < MAX_STDOUT_BYTES) stdout += sanitizeUtf8(chunk.toString()); });
    proc.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + sanitizeUtf8(chunk.toString())).slice(-2048); });
    proc.stdin?.on("error", () => undefined); // EPIPE: the agent exited before reading its prompt
    proc.on("error", (err) => done({ ok: false, launchFailed: true, error: `could not start the agent: ${err.message}` }));
    proc.on("close", (code) => {
      if (timedOut) return done({ ok: false, error: `timed out after ${job.timeoutMs}ms (killed with SIGTERM)` });
      if (code === 0) return done({ ok: true, text: stdout });
      const tail = stderr.trim().split(/\r?\n/).filter(Boolean).slice(-5).join("\n");
      done({ ok: false, error: `exited ${code}${tail ? ` - stderr:\n${tail}` : ""}` });
    });
    try {
      proc.stdin?.end(job.prompt);
    } catch (err) {
      workerLog(`[worker] one-shot ${requestId}: could not write the prompt: ${errorMessage(err)}`);
    }
  });
}

export function createWorkerOneShotRunner(options: WorkerOneShotOptions) {
  const provision = options.repoOps?.provision ?? provisionWorkerCheckout;
  const push = options.repoOps?.push ?? pushWorkerResult;
  const cleanup = options.repoOps?.cleanup ?? cleanupWorkerCheckout;
  const boardUrl = (): string | undefined => (typeof options.boardUrl === "function" ? options.boardUrl() : options.boardUrl);
  const reply = (result: WorkerOneShotResult): void => {
    try { options.send({ type: "oneshot_result", result }); } catch (err) { workerLog(`[worker] one-shot reply failed: ${errorMessage(err)}`); }
  };

  /** Profile pin, harness and checkout resolved; null means the job could not be launched here. */
  function prepareSpec(request: WorkerOneShotRequest, cwd: string): { spec: WorkerLaunchSpec } | { error: string } {
    const { job } = request;
    const base: WorkerLaunchSpec = {
      command: job.command, args: job.args, env: job.env, cwd, stdinPrompt: job.prompt,
      ...(job.useShell ? { useShell: true } : {}), ...(job.intent ? { intent: job.intent } : {}),
    };
    const profiled = applyProfileToSpec(base, {
      log: (line) => workerLog(line),
      ...(options.profileAliases ? { aliases: options.profileAliases } : {}),
      ...(options.profileHome ? { home: options.profileHome } : {}),
    });
    if (!profiled.ok) return { error: profiled.error };
    return { spec: applyHarnessToSpec(profiled.spec, options.harness) };
  }

  async function execute(request: WorkerOneShotRequest): Promise<Outcome> {
    const { job, repo, requestId } = request;
    let checkout: WorkerCheckout | undefined;
    let scratch: string | undefined;
    try {
      if (repo) {
        const url = boardUrl();
        if (!url) return { ok: false, launchFailed: true, error: "worker has no board URL for git transport" };
        checkout = await provision(url, repo, `oneshot-${requestId}`, options.workRoot ?? defaultWorkerWorkRoot());
      } else if (!job.cwd) {
        scratch = mkdtempSync(join(tmpdir(), "kanban-oneshot-"));
      }
      const cwd = checkout?.cwd ?? scratch ?? job.cwd!;
      const prepared = prepareSpec(request, cwd);
      if ("error" in prepared) return { ok: false, launchFailed: true, error: prepared.error };
      const startSha = checkout ? (await gitExecOrThrow(["rev-parse", "HEAD"], { cwd })).trim() : "";
      const outcome = await runAgentProcess(prepared.spec, request, cwd);
      if (!outcome.ok || !job.allowEdits || !checkout || !repo) return outcome;
      const pushedSha = await commitAndReadHead(cwd, startSha);
      if (!pushedSha) return outcome;
      await push(boardUrl() ?? "", repo, checkout);
      return { ...outcome, pushedSha };
    } catch (err) {
      // Before the agent ran (provisioning) the job can be placed elsewhere; after it, the
      // failure is the push's, and the board must not re-run an agent that already edited.
      return { ok: false, launchFailed: checkout === undefined, error: errorMessage(err) };
    } finally {
      if (checkout) await cleanup(checkout).catch(() => undefined);
      if (scratch) rmSync(scratch, { recursive: true, force: true });
    }
  }

  /** Handle a board frame; true when it was a one-shot request (answered asynchronously). */
  function handle(message: BoardToWorkerMessage): boolean {
    if (message.type !== "oneshot") return false;
    const { requestId } = message;
    if (options.isDraining?.()) {
      reply({ requestId, phase: "done", ok: false, launchFailed: true, error: "worker is draining (self-update or shutdown in progress)" });
      return true;
    }
    reply({ requestId, phase: "accepted" });
    void execute(message).then((outcome) => {
      workerLog(`[worker] one-shot ${requestId} finished: ok=${outcome.ok}${outcome.pushedSha ? ` pushed=${outcome.pushedSha.slice(0, 8)}` : ""}`);
      reply({ requestId, phase: "done", ...outcome });
    });
    return true;
  }

  return { handle };
}

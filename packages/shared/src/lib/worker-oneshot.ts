// One-shot agent jobs on the fleet protocol (#1431).
//
// A session is a long-lived assignment: it streams events, may take follow-up turns and lands a
// branch. A one-shot is the opposite shape — ONE prompt in, ONE answer out (issue enhance,
// decompose, preflight, the merge-train fix agent, the train review). They used to run only on
// the board host (`claude-cli.service.ts`); the host should only coordinate, so they travel to a
// worker as their own sessionless request/response pair instead of pretending to be a session.
//
// Pure types + defensive parsers, no Node builtins (same rule as worker-protocol.ts). The repo
// transport and launch intent are parsed by worker-protocol.ts and passed IN, which keeps the
// import one-way.
import type { WorkerLaunchIntent, WorkerRepoTransport } from "./worker-protocol.js";

/** What the worker runs. Everything board-machine-shaped has already been turned into intent. */
export interface WorkerOneShotJob {
  /** Logical program (the worker resolves the executable from `intent` when present). */
  command: string;
  args: string[];
  /** Allowlisted, non-secret wiring merged over the worker's own environment. */
  env: Record<string, string>;
  useShell?: boolean;
  intent?: WorkerLaunchIntent;
  /** Written to the agent's stdin, which is then closed. */
  prompt: string;
  /** Kill the agent after this long. The board decides; the worker enforces. */
  timeoutMs: number;
  /**
   * The agent may edit the checkout. Needs `repo`: the worker commits any leftovers and pushes
   * HEAD to `repo.incomingRef`, and reports the sha as `pushedSha`.
   */
  allowEdits: boolean;
  /**
   * Working directory on a worker that SHARES the board's filesystem. Ignored when `repo` is
   * present (the checkout is the cwd) and, with neither, the worker uses a scratch directory:
   * a read-only prompt with no repo context needs no checkout at all.
   */
  cwd?: string;
}

/** A sessionless board request: run this job and answer with a {@link WorkerOneShotResult}. */
export interface WorkerOneShotRequest {
  type: "oneshot";
  requestId: string;
  job: WorkerOneShotJob;
  /** Present when the prompt needs repo context: the worker checks out `repo.branch` first. */
  repo?: WorkerRepoTransport;
}

/**
 * The worker's answer, correlated by `requestId`. Two frames per request:
 *  - `accepted` straight away, so the board can tell a worker that predates this frame (it
 *    drops it unanswered) from one that is merely working, and fall back to the host;
 *  - `done` with the outcome.
 */
export interface WorkerOneShotResult {
  requestId: string;
  phase: "accepted" | "done";
  /** `done` only. */
  ok?: boolean;
  /** `done` + ok: the agent's stdout. */
  text?: string;
  error?: string;
  /**
   * `done` + !ok: the job never ran (profile unknown here, checkout failed, spawn failed).
   * The board may place it elsewhere; a job that ran and failed is NOT retried on the host.
   */
  launchFailed?: boolean;
  /** `allowEdits` only: the commit the worker pushed to the incoming ref, when HEAD moved. */
  pushedSha?: string;
}

/** Shape-check a `oneshot` request; the caller supplies the already-parsed repo and intent. */
export function parseOneShotRequest(
  msg: Record<string, unknown>,
  parts: { repo: WorkerRepoTransport | null; intent: WorkerLaunchIntent | null },
): WorkerOneShotRequest | null {
  const job = msg.job;
  if (typeof msg.requestId !== "string" || !msg.requestId) return null;
  if (typeof job !== "object" || job === null) return null;
  const j = job as Record<string, unknown>;
  if (typeof j.command !== "string" || typeof j.prompt !== "string" || !Array.isArray(j.args)) return null;
  if (typeof j.timeoutMs !== "number" || !Number.isFinite(j.timeoutMs) || j.timeoutMs <= 0) return null;
  const env = typeof j.env === "object" && j.env !== null
    ? Object.fromEntries(Object.entries(j.env as Record<string, unknown>).filter(([, v]) => typeof v === "string")) as Record<string, string>
    : {};
  return {
    type: "oneshot",
    requestId: msg.requestId,
    job: {
      command: j.command,
      args: j.args.filter((a): a is string => typeof a === "string"),
      env,
      prompt: j.prompt,
      timeoutMs: j.timeoutMs,
      allowEdits: j.allowEdits === true,
      ...(j.useShell === true ? { useShell: true } : {}),
      ...(parts.intent ? { intent: parts.intent } : {}),
      ...(typeof j.cwd === "string" && j.cwd ? { cwd: j.cwd } : {}),
    },
    ...(parts.repo ? { repo: parts.repo } : {}),
  };
}

/** Shape-check a `oneshot_result` frame body. Null = drop it (the board then times out). */
export function parseOneShotResult(raw: unknown): WorkerOneShotResult | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.requestId !== "string" || !r.requestId) return null;
  if (r.phase !== "accepted" && r.phase !== "done") return null;
  return {
    requestId: r.requestId,
    phase: r.phase,
    ...(typeof r.ok === "boolean" ? { ok: r.ok } : {}),
    ...(typeof r.text === "string" ? { text: r.text } : {}),
    ...(typeof r.error === "string" ? { error: r.error } : {}),
    ...(r.launchFailed === true ? { launchFailed: true } : {}),
    ...(typeof r.pushedSha === "string" && r.pushedSha ? { pushedSha: r.pushedSha } : {}),
  };
}

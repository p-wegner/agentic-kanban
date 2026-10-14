// The fleet frames for running a VERIFY job on a worker (#1437): the board sends one `verify_job`,
// the worker answers with `verify_progress` (stage + vitest files done/total), then the full log as
// `verify_log_chunk`s, then ONE `verify_result`. Frames are sessionless — a verify job is not an
// agent session — and every one is correlated by `jobId`, the same id the board's request carries.
//
// Everything is OPTIONAL on the wire for an older peer: a worker that predates this drops the job as
// malformed (the board's wait then times out and the chain is refused, never trusted), and an older
// board never sends one. So there is no protocol-version bump.

/** Git transport for fetching the sha: the shape of a `WorkerRepoOpAuth` (declared here so the protocol module can import this one, not the reverse). */
export interface VerifyJobAuth {
  projectId: string;
  gitPort: number;
  gitToken: string;
  branch: string;
  incomingRef: string;
}

/** What a worker advertises in its heartbeat so the board can place a verify chain on it. */
export interface WorkerVerifyCapability {
  /** Concurrent verify jobs this worker accepts. */
  slots: number;
  /** Slots free right now (slots − running). */
  freeSlots: number;
  /** The worker's RAM in GB (total), so placement can prefer the roomier machine. */
  ramGb: number;
}

export type VerifyStage = "queued" | "fetch" | "checkout" | "install" | "verify" | "uploading" | "done";

export interface VerifyJobFrame {
  type: "verify_job";
  jobId: string;
  /** The exact tree to verify. The worker refuses when its checkout is not this sha. */
  sha: string;
  branch: string;
  kind: string;
  tier: string;
  /** Test scope for a retry (`KANBAN_RETRY_TEST_FILES`) or any other narrowing; carried in `env`. */
  scope?: string;
  /** The project's verify_script. */
  script: string;
  /** The project's setup_script; absent → `pnpm install -r` when the tree has a package.json. */
  setupScript?: string;
  timeoutMs: number;
  /** Bounded vitest workers for this run. */
  maxWorkers?: number;
  env?: Record<string, string>;
  /** Git transport for fetching the sha (the same scoped token an `assign` carries). */
  auth: VerifyJobAuth;
}

/**
 * #1489: the board no longer wants this job (its train was cancelled/abandoned, or the gate was
 * aborted): the worker kills the job's process tree and removes its checkout. Idempotent; an unknown
 * jobId is a no-op. An older worker drops it as an unknown frame (the job then runs to its own timeout).
 */
export interface VerifyCancelFrame {
  type: "verify_cancel";
  jobId: string;
}

/**
 * #1489: sent on every (re)connect: the verify job ids the board still has an owner waiting for on
 * this worker. The worker reaps every running job NOT in the set (the board restarted and lost them).
 */
export interface VerifyLiveJobsFrame {
  type: "verify_live_jobs";
  jobIds: string[];
}

export interface VerifyProgressFrame {
  type: "verify_progress";
  jobId: string;
  stage: VerifyStage;
  filesDone?: number;
  filesTotal?: number;
}

export interface VerifyLogChunkFrame {
  type: "verify_log_chunk";
  jobId: string;
  seq: number;
  data: string;
}

export type VerifyRefusal = "sha_mismatch" | "sha_unavailable" | "no_free_slot" | "fetch_failed" | "setup_failed";

export interface VerifyResultFrame {
  type: "verify_result";
  jobId: string;
  /** The sha the worker ACTUALLY checked out and verified (not an echo of the request). */
  sha: string;
  tier: string;
  passed: boolean;
  /** Set when the worker refused to run (nothing was verified); `passed` is then false. */
  refused?: VerifyRefusal;
  reason?: string;
  exitCode: number;
  timedOut: boolean;
  failingSuites: string[];
  durationMs: number;
  logTail: string;
  /** How many `verify_log_chunk`s precede this frame (the board waits for all of them). */
  logChunks: number;
}

/** Bytes of log per chunk frame, and the cap on what a worker uploads at all. */
export const VERIFY_LOG_CHUNK_BYTES = 48 * 1024;
export const VERIFY_LOG_MAX_BYTES = 8 * 1024 * 1024;
export const VERIFY_LOG_TAIL_BYTES = 8 * 1024;

const rec = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

const STAGES = new Set<string>(["queued", "fetch", "checkout", "install", "verify", "uploading", "done"]);
const REFUSALS = new Set<string>(["sha_mismatch", "sha_unavailable", "no_free_slot", "fetch_failed", "setup_failed"]);

function parseAuth(raw: unknown): VerifyJobAuth | null {
  const a = rec(raw);
  if (!a || !str(a.projectId) || !num(a.gitPort) || !str(a.gitToken) || !str(a.branch) || !str(a.incomingRef)) return null;
  return { projectId: a.projectId, gitPort: a.gitPort, gitToken: a.gitToken, branch: a.branch, incomingRef: a.incomingRef };
}

export function parseVerifyJobFrame(msg: Record<string, unknown>): VerifyJobFrame | null {
  const auth = parseAuth(msg.auth);
  if (!auth || !str(msg.jobId) || !str(msg.sha) || !str(msg.script) || !num(msg.timeoutMs)) return null;
  const env = rec(msg.env);
  return {
    type: "verify_job",
    jobId: msg.jobId,
    sha: msg.sha,
    branch: typeof msg.branch === "string" ? msg.branch : "",
    kind: typeof msg.kind === "string" ? msg.kind : "workspace-gate",
    tier: typeof msg.tier === "string" ? msg.tier : "full",
    ...(typeof msg.scope === "string" ? { scope: msg.scope } : {}),
    script: msg.script,
    ...(str(msg.setupScript) ? { setupScript: msg.setupScript } : {}),
    timeoutMs: msg.timeoutMs,
    ...(num(msg.maxWorkers) ? { maxWorkers: msg.maxWorkers } : {}),
    ...(env ? { env: Object.fromEntries(Object.entries(env).filter(([, v]) => typeof v === "string")) as Record<string, string> } : {}),
    auth,
  };
}

/** Board→worker `verify_cancel` / `verify_live_jobs` (#1489). Null = not one of them, or malformed: drop it. */
export function parseVerifyControlFrame(msg: Record<string, unknown>): VerifyCancelFrame | VerifyLiveJobsFrame | null {
  if (msg.type === "verify_cancel") return str(msg.jobId) ? { type: "verify_cancel", jobId: msg.jobId } : null;
  if (msg.type === "verify_live_jobs") return Array.isArray(msg.jobIds) ? { type: "verify_live_jobs", jobIds: msg.jobIds.filter(str) } : null;
  return null;
}

/** Worker→board verify frames. Null = not one of them (or malformed: drop it). */
export function parseVerifyWorkerFrame(msg: Record<string, unknown>): VerifyProgressFrame | VerifyLogChunkFrame | VerifyResultFrame | null {
  if (!str(msg.jobId)) return null;
  switch (msg.type) {
    case "verify_progress":
      if (typeof msg.stage !== "string" || !STAGES.has(msg.stage)) return null;
      return {
        type: "verify_progress",
        jobId: msg.jobId,
        stage: msg.stage as VerifyStage,
        ...(num(msg.filesDone) ? { filesDone: msg.filesDone } : {}),
        ...(num(msg.filesTotal) ? { filesTotal: msg.filesTotal } : {}),
      };
    case "verify_log_chunk":
      if (!num(msg.seq) || typeof msg.data !== "string") return null;
      return { type: "verify_log_chunk", jobId: msg.jobId, seq: msg.seq, data: msg.data };
    case "verify_result": {
      if (typeof msg.sha !== "string" || typeof msg.passed !== "boolean" || !num(msg.exitCode)) return null;
      const refused = typeof msg.refused === "string" && REFUSALS.has(msg.refused) ? (msg.refused as VerifyRefusal) : undefined;
      return {
        type: "verify_result",
        jobId: msg.jobId,
        sha: msg.sha,
        tier: typeof msg.tier === "string" ? msg.tier : "",
        // A refusal can never be a pass, whatever the frame claims.
        passed: msg.passed && !refused,
        ...(refused ? { refused } : {}),
        ...(typeof msg.reason === "string" ? { reason: msg.reason } : {}),
        exitCode: msg.exitCode,
        timedOut: msg.timedOut === true,
        failingSuites: Array.isArray(msg.failingSuites) ? msg.failingSuites.filter((s): s is string => typeof s === "string").slice(0, 200) : [],
        durationMs: num(msg.durationMs) ? msg.durationMs : 0,
        logTail: typeof msg.logTail === "string" ? msg.logTail : "",
        logChunks: num(msg.logChunks) ? msg.logChunks : 0,
      };
    }
    default:
      return null;
  }
}

/** Shape-check a verify capability blob off the wire. Absent/ill-typed = the worker offers none. */
export function parseWorkerVerifyCapability(raw: unknown): WorkerVerifyCapability | undefined {
  const r = rec(raw);
  if (!r || !num(r.slots) || r.slots < 1 || !num(r.freeSlots) || !num(r.ramGb)) return undefined;
  return { slots: Math.floor(r.slots), freeSlots: Math.max(0, Math.floor(r.freeSlots)), ramGb: r.ramGb };
}

/** Cut a full log into chunk payloads, keeping HEAD+TAIL when it exceeds the cap. */
export function chunkVerifyLog(log: string): string[] {
  const capped = log.length > VERIFY_LOG_MAX_BYTES
    ? `${log.slice(0, VERIFY_LOG_MAX_BYTES / 2)}\n...[log truncated]...\n${log.slice(-VERIFY_LOG_MAX_BYTES / 2)}`
    : log;
  const out: string[] = [];
  for (let i = 0; i < capped.length; i += VERIFY_LOG_CHUNK_BYTES) out.push(capped.slice(i, i + VERIFY_LOG_CHUNK_BYTES));
  return out;
}

// Repo-transport / repo-op / session-probe parsers split out of worker-protocol.ts (#1605); re-exported there.
import { parseWorkerCommitterIdentity } from "./worker-prerequisites.js";
import type { WorkerLaunchIntent, WorkerRepoOpAuth, WorkerRepoOpResult, WorkerRepoOpStatus, WorkerRepoTransport, WorkerSessionProbe, WorkerSessionProbeState } from "./worker-protocol.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/**
 * Shape-check a repo-op auth blob. Null = drop the whole message: a sync or push with a
 * missing port/token/ref cannot be attempted, and attempting it with defaults would aim a
 * force-push at a ref the board did not name.
 */
export function parseWorkerRepoOpAuth(raw: unknown): WorkerRepoOpAuth | null {
  const auth = asRecord(raw);
  if (!auth) return null;
  if (
    typeof auth.projectId !== "string" ||
    typeof auth.gitPort !== "number" ||
    typeof auth.gitToken !== "string" ||
    typeof auth.branch !== "string" ||
    typeof auth.incomingRef !== "string"
  ) {
    return null;
  }
  return {
    projectId: auth.projectId,
    gitPort: auth.gitPort,
    gitToken: auth.gitToken,
    branch: auth.branch,
    incomingRef: auth.incomingRef,
  };
}

const REPO_OP_STATUSES = new Set<string>([
  "updated", "unchanged", "pushed", "missing", "diverged", "dirty-held", "no-session", "error",
]);

/** Shape-check a repo-op result off the wire. Null = drop it (the board then times out). */
export function parseWorkerRepoOpResult(raw: unknown): WorkerRepoOpResult | null {
  const result = asRecord(raw);
  if (!result) return null;
  if (typeof result.requestId !== "string" || typeof result.ok !== "boolean") return null;
  if (result.op !== "sync" && result.op !== "push") return null;
  if (typeof result.status !== "string" || !REPO_OP_STATUSES.has(result.status)) return null;
  return {
    requestId: result.requestId,
    op: result.op,
    ok: result.ok,
    status: result.status as WorkerRepoOpStatus,
    ...(typeof result.sha === "string" ? { sha: result.sha } : {}),
    ...(typeof result.error === "string" ? { error: result.error } : {}),
  };
}

const PROBE_STATES = new Set<string>(["unknown", "running", "exited"]);

/**
 * Shape-check a session probe off the wire (#887). Null = drop it, and the board then
 * times out — which is the same outcome as an older worker that never answers, and is
 * deliberately NOT the same as `unknown`.
 */
export function parseWorkerSessionProbe(raw: unknown): WorkerSessionProbe | null {
  const probe = asRecord(raw);
  if (!probe) return null;
  if (typeof probe.requestId !== "string" || !probe.requestId) return null;
  if (typeof probe.state !== "string" || !PROBE_STATES.has(probe.state)) return null;
  const num = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const pid = num(probe.pid);
  const startedAtMs = num(probe.startedAtMs);
  const lastOutputAtMs = num(probe.lastOutputAtMs);
  const exitedAtMs = num(probe.exitedAtMs);
  return {
    requestId: probe.requestId,
    state: probe.state as WorkerSessionProbeState,
    ...(pid !== undefined ? { pid } : {}),
    ...(startedAtMs !== undefined ? { startedAtMs } : {}),
    ...(lastOutputAtMs !== undefined ? { lastOutputAtMs } : {}),
    // `null` is meaningful here (killed by signal), so it is kept while `undefined` is not.
    ...(probe.exitCode === null || num(probe.exitCode) !== undefined ? { exitCode: probe.exitCode as number | null } : {}),
    ...(exitedAtMs !== undefined ? { exitedAtMs } : {}),
    ...(typeof probe.stdinOpen === "boolean" ? { stdinOpen: probe.stdinOpen } : {}),
  };
}

/**
 * A name that can only ever land directly in the directory it is written to: no path
 * separator, no drive letter, no `.`/`..`. Shared by the board (which builds these names
 * with `basename`) and the worker (which must not trust them).
 */
export function isBareFileName(name: string): boolean {
  if (!name || name === "." || name === "..") return false;
  if (/[\/]/.test(name)) return false;
  if (/^[a-zA-Z]:/.test(name)) return false;
  return true;
}

export function parseLaunchIntent(raw: unknown): WorkerLaunchIntent | null {
  const intent = asRecord(raw);
  if (!intent) return null;
  if (typeof intent.provider !== "string" || typeof intent.program !== "string") return null;
  if (!intent.program.trim()) return null;
  // #1431: the pinned profile NAME must survive the parse, or a profile-restricted project's launch loses its pin.
  const profile = typeof intent.profile === "string" ? intent.profile.trim() : "";
  return { provider: intent.provider, program: intent.program, ...(profile ? { profile } : {}) };
}

export function parseRepoTransport(raw: unknown): WorkerRepoTransport | null {
  const repo = asRecord(raw);
  if (!repo) return null;
  if (
    typeof repo.projectId !== "string" ||
    typeof repo.gitPort !== "number" ||
    typeof repo.gitToken !== "string" ||
    typeof repo.branch !== "string" ||
    typeof repo.baseBranch !== "string" ||
    typeof repo.incomingRef !== "string"
  ) {
    return null;
  }
  const skills = Array.isArray(repo.skills)
    ? repo.skills
        .map((s) => asRecord(s))
        .filter((s): s is Record<string, unknown> => Boolean(s))
        .filter((s) => typeof s.name === "string" && typeof s.content === "string")
        .map((s) => ({
          name: s.name as string,
          // Optional on the wire: an older board sends none, and a skill without a
          // description still materializes (with an empty one) rather than being dropped.
          ...(typeof s.description === "string" ? { description: s.description } : {}),
          content: s.content as string,
        }))
    : undefined;
  const contextFiles = Array.isArray(repo.contextFiles)
    ? repo.contextFiles
        .map((f) => asRecord(f))
        .filter((f): f is Record<string, unknown> => Boolean(f))
        .filter((f) => typeof f.name === "string" && typeof f.content === "string")
        // A bare filename only: the board writes into the checkout ROOT, and a name
        // carrying a separator or `..` would escape it. Dropped, not sanitized — a
        // spec that asks for that is malformed, not merely untidy.
        .filter((f) => isBareFileName(f.name as string))
        .map((f) => ({ name: f.name as string, content: f.content as string }))
    : undefined;
  const committer = parseWorkerCommitterIdentity(repo.committer);
  return {
    projectId: repo.projectId,
    gitPort: repo.gitPort,
    gitToken: repo.gitToken,
    branch: repo.branch,
    baseBranch: repo.baseBranch,
    incomingRef: repo.incomingRef,
    setupScript: typeof repo.setupScript === "string" ? repo.setupScript : undefined,
    ...(committer ? { committer } : {}),
    ...(skills && skills.length > 0 ? { skills } : {}),
    ...(contextFiles && contextFiles.length > 0 ? { contextFiles } : {}),
    ...(typeof repo.boardMcpToken === "string" && repo.boardMcpToken.length > 0
      ? { boardMcpToken: repo.boardMcpToken }
      : {}),
  };
}


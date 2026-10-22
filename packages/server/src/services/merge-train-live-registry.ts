/**
 * #1181 — the in-process registry of merge-train jobs that are LIVE right now.
 *
 * A train's whole lifecycle is one async generator (`runTrainStrategy` in
 * `merge-queue-train.ts`) with no session row, PID or heartbeat of its own, so the only thing
 * that knows a `merge_trains` row still has a job behind it is the process running that job.
 * `merge-train-reconciler.ts` was built on the boot-time truth that "nothing can be live yet"
 * — correct at boot, and wrong on every periodic sweep after it: measured 2026-09-16, a
 * 14-member train 8 minutes into a 28-minute gate was abandoned as stranded, re-assembled,
 * and the re-assembly then died waiting on the repo lock the live job still held.
 *
 * This module is that missing liveness signal. A run registers its row when the row is minted
 * and clears it in a `finally`; the reconciler's sweep takes a snapshot and skips any row (or
 * any same-project sibling) it finds here. At boot the registry is empty by construction, so
 * the boot pass keeps its "nothing can be live" rule without a special case.
 *
 * Module-level state on purpose: it is a fact about THIS process, exactly like the periodic
 * sweep handles in `startup/`. `snapshotLiveMergeTrains` hands out a copy so the decision
 * that reads it can stay pure.
 */

export interface LiveMergeTrain {
  trainId: string;
  label: string;
  projectId: string;
  /** Epoch ms when the job registered — for the "live (age Nm)" log line. */
  registeredAtMs: number;
  /**
   * #1203 — the real cancellation token for this job. `runTrainStrategy` creates one when it
   * registers the row and passes its `signal` into `runMergeTrain`, so an operator cancel can
   * `.abort()` this controller and have the in-flight gate's child process killed and the
   * bisect driver refuse to start another attempt, instead of only marking the DB row
   * `abandoned` while the job keeps running to completion (the #1153 gap).
   */
  abortController: AbortController;
  /** #1513 — staging gates (whole-train, bisect halves, control arm) running for this job right now. */
  activeGates?: number;
  /** #1513 — epoch ms of the job's last gate start/end; what "idle with no job" is measured from. */
  lastActivityMs?: number;
  /** #1646 — epoch ms the oldest currently-running gate started; cleared when no gate is active. */
  gateStartedMs?: number;
  /** #1646 — epoch ms a verify worker's result for this job's gate reached the board (cleared when the gate ends). */
  gateResultAtMs?: number;
  /** #1679 — epoch ms of the last worker progress/heartbeat frame for the running gate; cleared when the gate ends. */
  lastProgressMs?: number;
}

/** Read-only view of the registry a sweep decides against. */
export type LiveMergeTrainSnapshot = ReadonlyMap<string, LiveMergeTrain>;

const live = new Map<string, LiveMergeTrain>();

/**
 * Register a train job as live. Idempotent for the same id (a re-register refreshes the entry
 * and mints a FRESH abort controller — a stale one from a previous registration of the same id
 * must never be reused, since its `abort()` may already have fired).
 */
export function registerLiveMergeTrain(entry: { trainId: string; label: string; projectId: string; nowMs?: number }): AbortController {
  const abortController = new AbortController();
  live.set(entry.trainId, {
    trainId: entry.trainId,
    label: entry.label,
    projectId: entry.projectId,
    registeredAtMs: entry.nowMs ?? Date.now(),
    abortController,
    activeGates: 0,
    lastActivityMs: entry.nowMs ?? Date.now(),
  });
  return abortController;
}

/** #1513 — a staging gate for this job started (true) or finished (false). No-op for an unregistered job. */
export function noteMergeTrainGateActivity(trainId: string, started: boolean, nowMs: number = Date.now()): void {
  const entry = live.get(trainId);
  if (!entry) return;
  entry.activeGates = Math.max(0, (entry.activeGates ?? 0) + (started ? 1 : -1));
  entry.lastActivityMs = nowMs;
  if (started && entry.gateStartedMs === undefined) entry.gateStartedMs = nowMs;
  if (entry.activeGates === 0) {
    entry.gateStartedMs = undefined;
    entry.gateResultAtMs = undefined;
    entry.lastProgressMs = undefined;
  }
}

/** #1646 — a verify worker's verdict for a train gate reached the board; the job should resume right after. */
export function noteMergeTrainGateResultReceived(projectId: string, nowMs: number = Date.now()): void {
  for (const entry of live.values()) {
    if (entry.projectId === projectId && (entry.activeGates ?? 0) > 0) entry.gateResultAtMs = nowMs;
  }
}

/** #1679 — the verify worker reported progress (stage / files / log chunk) or a heartbeat for this project's train gate. */
export function noteMergeTrainGateProgress(projectId: string, nowMs: number = Date.now()): void {
  for (const entry of live.values()) {
    if (entry.projectId === projectId && (entry.activeGates ?? 0) > 0) entry.lastProgressMs = nowMs;
  }
}

/** #1679 — verdict of {@link judgeMergeTrainGate}. */
export type GateJudgement =
  | { hung: false }
  | { hung: true; kind: "no-progress" | "age-ceiling"; ceilingMs: number; idleMs: number };

/**
 * #1679 — "hung" means NO PROGRESS, not "long". A gate whose worker reports progress
 * (`lastProgressMs`) is abandoned only when that signal went quiet for `noProgressMs`, or, as a
 * last resort, when it outlives `ceilingMs` (derived from the scope by the caller). A gate with
 * no progress signal at all (a local run) falls back to the age rule alone. Pure over the entry.
 */
export function judgeMergeTrainGate(
  entry: Pick<LiveMergeTrain, "activeGates" | "gateStartedMs" | "lastProgressMs" | "gateResultAtMs">,
  nowMs: number,
  limits: { ceilingMs: number; noProgressMs: number },
): GateJudgement {
  if ((entry.activeGates ?? 0) === 0 || entry.gateStartedMs === undefined) return { hung: false };
  const age = nowMs - entry.gateStartedMs;
  if (entry.lastProgressMs !== undefined) {
    const idleMs = nowMs - entry.lastProgressMs;
    if (idleMs >= limits.noProgressMs) return { hung: true, kind: "no-progress", ceilingMs: limits.ceilingMs, idleMs };
    if (age >= limits.ceilingMs) return { hung: true, kind: "age-ceiling", ceilingMs: limits.ceilingMs, idleMs };
    return { hung: false };
  }
  if (age >= limits.ceilingMs) return { hung: true, kind: entry.gateResultAtMs !== undefined ? "no-progress" : "age-ceiling", ceilingMs: limits.ceilingMs, idleMs: age };
  return { hung: false };
}

/**
 * #1646 — a gate that has been ACTIVE longer than `ceilingMs`: `activeGates > 0` hides it from
 * {@link isMergeTrainStalled}, so a job hung inside its gate (after the worker answered, say)
 * was never abandoned. Pure over the entry.
 */
export function isMergeTrainGateHung(entry: Pick<LiveMergeTrain, "activeGates" | "gateStartedMs">, nowMs: number, ceilingMs: number): boolean {
  return (entry.activeGates ?? 0) > 0 && entry.gateStartedMs !== undefined && nowMs - entry.gateStartedMs >= ceilingMs;
}

/** #1646 — the live gate state for the train panel / `train show`; null when no gate is active. */
export function describeLiveGate(trainId: string, nowMs: number = Date.now()): { state: "running" | "result-received-not-resumed"; text: string } | null {
  const entry = live.get(trainId);
  if (!entry || (entry.activeGates ?? 0) === 0) return null;
  if (entry.gateResultAtMs !== undefined) {
    return { state: "result-received-not-resumed", text: `gate result received at ${new Date(entry.gateResultAtMs).toISOString()}, train job not resumed` };
  }
  const mins = Math.round((nowMs - (entry.gateStartedMs ?? nowMs)) / 60_000);
  return { state: "running", text: `gate running for ${mins}m` };
}

/** #1513: bracket one staging gate, so a job with NO gate running can be told from one mid-verify. */
export async function withMergeTrainGateActivity<T>(trainId: string, run: () => Promise<T>): Promise<T> {
  noteMergeTrainGateActivity(trainId, true);
  try {
    return await run();
  } finally {
    noteMergeTrainGateActivity(trainId, false);
  }
}

/**
 * #1513 — a live job that has run NO gate for `stallMs`: it is registered (so the sweep skips it
 * as "live in this process") but nothing is verifying, bisecting or fixing, so nothing will ever
 * move it. Pure over the entry.
 */
export function isMergeTrainStalled(entry: Pick<LiveMergeTrain, "activeGates" | "lastActivityMs">, nowMs: number, stallMs: number): boolean {
  // An entry that never reported activity (a hand-built snapshot) is never judged stalled.
  return entry.activeGates === 0 && entry.lastActivityMs !== undefined && nowMs - entry.lastActivityMs >= stallMs;
}

/** Clear a train job. Idempotent — safe from a `finally` that may run after an explicit clear. */
export function unregisterLiveMergeTrain(trainId: string): void {
  live.delete(trainId);
}

/**
 * Ask a live train's job to stop (#1203). A no-op — never an error — when the job is not
 * registered in THIS process: the row may belong to a job on another process (not today's
 * architecture, but the safe read), or may already have finished between the caller's read of
 * the row and this call. Returns whether a live job was actually signalled, so the caller
 * (the cancel route) can report `stoppedAfter: "current-attempt"` vs `"immediately"`.
 */
export function abortLiveMergeTrain(trainId: string): boolean {
  const entry = live.get(trainId);
  if (!entry) return false;
  entry.abortController.abort();
  return true;
}

export function isMergeTrainLive(trainId: string): boolean {
  return live.has(trainId);
}

/**
 * Is a train job for this `label` running in THIS process? (#1150) The repo lock's holder
 * string is `merge-train:<label>` — the label is all the lock layer has on hand while it logs
 * a contended wait, and it has no DB access to map a label back to a row id.
 */
export function isMergeTrainLabelLive(label: string): boolean {
  for (const entry of live.values()) {
    if (entry.label === label) return true;
  }
  return false;
}

/** A copy of the registry as of now — what the reconciler's sweep decides against. */
export function snapshotLiveMergeTrains(): LiveMergeTrainSnapshot {
  return new Map(live);
}

/** The live train for a project, if this process is running one. Pure over the snapshot. */
export function findLiveMergeTrainForProject(
  snapshot: LiveMergeTrainSnapshot,
  projectId: string,
): LiveMergeTrain | undefined {
  for (const entry of snapshot.values()) {
    if (entry.projectId === projectId) return entry;
  }
  return undefined;
}

/** Test seam — forget every live job, as a fresh process would. */
export function resetLiveMergeTrainRegistryForTests(): void {
  live.clear();
}

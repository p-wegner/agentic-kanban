import { isInFlightStatusName, type BoardStatusIssue, BoardStatusResponse, MergeTrainRowDto, MergeTrainsResponse } from "@agentic-kanban/shared";
import { authExpiredProfileNames, credentialProblemProfiles, describeAuthExpired, describeWorkerProfiles } from "../lib/worker-profile-attestation.js";
import type { MergeTrainWindowResponse } from "@agentic-kanban/shared";
import { applyConsoleExtras, type ConsoleBaseHealth, type ConsoleChain, type ConsoleConnectCode, type ConsoleExtrasPayload, type ConsoleMergeHold, type ConsoleRc } from "./status-console-extras.js";

// `status --watch` as a one-screen operator console (#1421). `buildConsoleModel` turns the
// board's HTTP payloads into one plain model (also what `--json` prints); `renderConsole` draws
// it. Both are pure — no clock, no I/O — so the renderer is snapshot-testable with a fixed model.

export interface ConsoleWorkerTicket { issueNumber: number | null; status: string; startedAt: string | null; phase?: string | null }
export interface ConsoleWorker {
  name: string;
  os: string | null;
  status: string;
  load: number;
  maxConcurrency: number;
  build: string | null;
  heartbeatAt: string | null;
  tickets: ConsoleWorkerTicket[];
  /** #1437: verify jobs the board placed on this worker, e.g. `rc-sweep 1a2b3c4d5 (full) verify 12/340`. */
  verifyJobs?: string[];
  /** #1462: when each of `verifyJobs` started (same order), so the chain line can show elapsed. */
  verifyJobStartedAt?: Array<string | null>;
  /** Silent for more than a day: history, collapsed into one line and kept out of ATTENTION. */
  stale?: boolean;
  /** Reports a build sha that differs from the board's own. */
  buildStale?: boolean;
  /** #1460: the worker's own update report while it is updating, e.g. `update pending (worker code changed): waits for 2 session(s)`. */
  updatePending?: string;
  /** #1371: the toolchain install the board asked this worker for (pending / installing / failed / done). */
  toolchainInstall?: { state: string; toolchains: string[]; reason?: string };
  /** #1449: free RAM / disk the worker's heartbeat reports (GB). */
  freeRamGb?: number | null;
  freeDiskGb?: number | null;
  /** #1426: the claude login is dead — online but cannot run anything. */
  authExpired?: boolean;
  /** #1565: `anth ✓ · team5x filtered` - attested profiles and the discovered-but-unattested ones. */
  profiles?: string;
  /** #1443: settings keys the worker's start flags pin; `desiredPending` while the board's desired set is not yet applied. */
  pinned?: string[];
  desiredPending?: boolean;
  /** #1456: concurrency mode (auto/fixed/pinned) and, while auto back-off holds placement, why. */
  concurrencyMode?: string;
  concurrencyHold?: string;
}
export interface ConsoleHost {
  freeGb: number | null;
  floorGb: number;
  hold: boolean;
  reason: string | null;
  verifyActive: number;
  verifySlots: number;
  verifyQueued: number;
}
export interface ConsoleTrain {
  label: string;
  state: string;
  startedAt: string;
  finishedAt: string | null;
  members: number;
  landed: number;
  dropped: number;
  gateRuns: number;
  gateFailure: string | null;
  /** Red, but a later train of the same project landed: history, not attention. */
  superseded?: boolean;
  /** #1449: why each dropped member was dropped (`#1431: conflicts with #1435 ...`). */
  droppedDetail?: Array<{ ref: string; reason: string; deferred?: boolean }>;
  /** #1572: the shepherd line (session, worker, turns, last action), when a shepherd ran on this train. */
  shepherd?: string;
}

/** #1572: `shepherd 1a2b3c4d on worker-a · 3 turns · resolving conflict #12 vs #15`. Null without a shepherd. */
export function formatShepherdLine(ev: { shepherd?: { sessionId?: string; worker?: string; turns?: number; lastAction?: string; costUsd?: number } }): string | null {
  const s = ev.shepherd;
  if (!s || typeof s !== "object") return null;
  const turns = Number(s.turns ?? 0);
  return [
    `shepherd${s.sessionId ? ` ${String(s.sessionId).slice(0, 8)}` : ""}${s.worker ? ` on ${s.worker}` : ""}`,
    `${turns} turn${turns === 1 ? "" : "s"}`,
    ...(typeof s.costUsd === "number" ? [`$${s.costUsd.toFixed(2)}`] : []),
    String(s.lastAction ?? "idle"),
  ].join(" · ");
}
export interface ConsoleWindow { pending: number[]; firstSeenAt: string; maxWaitMs: number }
export interface ConsoleAttention { level: "red" | "yellow"; text: string }
export interface ConsoleIssue { issueNumber: number | null; title: string; statusName: string; column: ConsoleColumn }

export const CONSOLE_COLUMNS = ["Todo", "Build", "Review", "Merge"] as const;
export type ConsoleColumn = (typeof CONSOLE_COLUMNS)[number];

export interface ConsoleModel {
  project: string;
  generatedAt: string;
  boardVersion: string | null;
  /** The promoted tag (`stable-20261012-3`) and short commit the board runs from. */
  boardTag?: string | null;
  boardCommit?: string | null;
  openIssues: number;
  runningSessions: number;
  host: ConsoleHost | null;
  workers: ConsoleWorker[];
  trains: ConsoleTrain[];
  window: ConsoleWindow | null;
  issues: ConsoleIssue[];
  attention: ConsoleAttention[];
  mergedToday: number;
  /** #1449: every running and queued verify chain, host and worker. */
  chains?: ConsoleChain[];
  baseHealth?: ConsoleBaseHealth | null;
  /** Set while the auto-merge window holds work (`base_red`, `live_train`, ...), naming the held tickets. */
  mergeHold?: ConsoleMergeHold | null;
  rc?: ConsoleRc | null;
  /** Merges on master the running stable tag does not contain. */
  unpromoted?: number | null;
  placement?: { mode: string; workers: string[] } | null;
  connectCodes?: ConsoleConnectCode[];
  /** Set when a read failed; the frame says so instead of showing an empty fleet as healthy. */
  errors: string[];
}

export interface ConsolePayloads {
  status: BoardStatusResponse;
  workers?: { workers?: Array<Record<string, any>>; fleet?: { boardWorkerVersion?: string | null } } | null;
  host?: { freeGb: number | null; floorGb: number; hold: boolean; reason?: string; verify: { active: number; slots: number; queued: number }; boardCommit?: string | null; workerBuild?: string | null; boardTag?: string | null; mergedToday?: number | null; unpromotedMerges?: number | null } | null;
  /** #1449: `GET /api/workers/console` — chains, base verdict, rc, placement, stalls, connect codes. */
  extras?: ConsoleExtrasPayload | null;
  trains?: MergeTrainsResponse | null;
  window?: MergeTrainWindowResponse | null;
  boardVersion?: string | null;
  errors?: string[];
  nowMs: number;
}

export const STALE_WORKER_MS = 24 * 3600 * 1000;

/** The commit a worker build names: its `-dev.<sha>` stamp, else a bare hex id; null when it names none. */
export function workerBuildSha(version: unknown): string | null {
  if (typeof version !== "string") return null;
  const m = /(?:^|[-.])dev\.([0-9a-f]{7,40})$/i.exec(version.trim()) ?? /^([0-9a-f]{7,40})$/i.exec(version.trim());
  return m ? m[1]!.toLowerCase() : null;
}

/** Heartbeat age as a coarse human unit: `45s`, `12m`, `5h`, `48d`. */
export function formatAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/** ` (stable-20261012-3 2dcf8de)` when the board knows its tag/commit, else the package version. */
export function buildLabel(model: ConsoleModel): string {
  // #1620: the commit is the worker bundle's, not the tag's own, so say so.
  const id = [model.boardTag, model.boardCommit ? `worker ${model.boardCommit}` : null].filter(Boolean).join(" ");
  const label = id || model.boardVersion;
  return label ? ` (${label})` : "";
}

function columnOf(issue: BoardStatusIssue): ConsoleColumn {
  if (issue.mergeState?.bucket === "pending_merge") return "Merge";
  // An idle "In Review" ticket is built and waiting (under sprint there is no review session at all),
  // so its status, not only a running review session, puts it in Review.
  if (issue.workspace?.status === "reviewing" || issue.statusName === "In Review") return "Review";
  return isInFlightStatusName(issue.statusName) ? "Build" : "Todo";
}

function parseEvidence(row: MergeTrainRowDto, refOf: (workspaceId: string) => string = (id) => id.slice(0, 8)): { landed: number; dropped: number; gateRuns: number; members: number; gateFailure: string | null; droppedDetail: NonNullable<ConsoleTrain["droppedDetail"]>; shepherd?: string } {
  let ev: Record<string, any> = {};
  try { ev = row.gateEvidence ? JSON.parse(row.gateEvidence) : {}; } catch { ev = {}; }
  let members = 0;
  try { members = (JSON.parse(row.memberWorkspaceIds) as unknown[]).length; } catch { members = 0; }
  const shepherd = formatShepherdLine(ev);
  return {
    ...(shepherd ? { shepherd } : {}),
    members: ev.memberCount ?? members,
    landed: ev.landedCount ?? ev.landed?.length ?? 0,
    dropped: ev.uniqueDroppedCount ?? ev.dropped?.length ?? 0,
    gateRuns: ev.gateRuns ?? 0,
    gateFailure: ev.gateFailure ?? null,
    droppedDetail: Array.isArray(ev.dropped)
      ? ev.dropped.filter((d: any) => d && typeof d === "object").map((d: any) => ({ ref: refOf(String(d.workspaceId ?? "")), reason: String(d.reason ?? ""), ...(d.deferred ? { deferred: true } : {}) }))
      : [],
  };
}

/**
 * #1583: per red train, how many members are still stuck on it (ready for merge, not landed, not in
 * a newer train) and which are reworking (workspace present but sent back / new sha).
 */
function redTrainMemberStates(rows: MergeTrainRowDto[], issues: BoardStatusIssue[]): Map<string, { stuck: number; reworking: string[] }> {
  const ids = (json: string | null): string[] => { try { const v = JSON.parse(json ?? "[]"); return Array.isArray(v) ? v.map(String) : []; } catch { return []; } };
  const landed = new Set<string>();
  for (const r of rows) {
    try { for (const id of (JSON.parse(r.gateEvidence ?? "{}").landed ?? []) as unknown[]) landed.add(String(id)); } catch { /* unparseable evidence */ }
  }
  const out = new Map<string, { stuck: number; reworking: string[] }>();
  for (const r of rows) {
    if (r.state !== "red") continue;
    const startedMs = new Date(r.startedAt).getTime();
    const newer = new Set<string>();
    for (const o of rows) if (o !== r && new Date(o.startedAt).getTime() > startedMs) for (const id of ids(o.memberWorkspaceIds)) newer.add(id);
    if (ids(r.memberWorkspaceIds).length === 0) continue;
    let stuck = 0;
    const reworking: string[] = [];
    for (const id of ids(r.memberWorkspaceIds)) {
      if (landed.has(id) || newer.has(id)) continue;
      const issue = issues.find((i) => i.workspace?.id === id);
      if (!issue) continue;
      if (issue.workspace?.readyForMerge) stuck++;
      else reworking.push(issue.issueNumber != null ? `#${issue.issueNumber}` : id.slice(0, 8));
    }
    out.set(r.label, { stuck, reworking });
  }
  return out;
}

/** #1565: expired/missing credentials (not only a refused session) also leave an online worker with nothing to run. */
function pushCredentialProblem(w: Record<string, any>, workers: ConsoleWorker[], attention: ConsoleAttention[]): void {
  if (w.effectiveStatus !== "online") return;
  const bad = credentialProblemProfiles(w.profiles ?? w.attestedProfiles, "claude");
  if (bad.length === 0) return;
  const name = String(w.name ?? w.workerId ?? w.id ?? "?");
  const row = workers.find((x) => x.name === name);
  if (row) row.authExpired = true;
  attention.push({ level: "red", text: `${name}: claude credentials unusable (${bad.join(", ")}) - re-login or copy credentials` });
}

export function buildConsoleModel(p: ConsolePayloads): ConsoleModel {
  const { status, nowMs } = p;
  const dayStart = new Date(nowMs); dayStart.setHours(0, 0, 0, 0);
  const attention: ConsoleAttention[] = [];

  // #1460: compare against the worker-bundle build, not the board's HEAD (board-only commits are not stale).
  const boardCommit = (p.host?.workerBuild ?? p.host?.boardCommit)?.toLowerCase() ?? null;
  const workers: ConsoleWorker[] = (p.workers?.workers ?? []).map((w) => ({
    name: String(w.name ?? w.workerId ?? w.id ?? "?"),
    os: w.os ?? null,
    status: String(w.effectiveStatus ?? w.status ?? "unknown"),
    load: Number(w.load ?? w.assignments?.length ?? 0),
    maxConcurrency: Number(w.maxConcurrency ?? 0),
    build: workerBuildSha(w.workerVersion)?.slice(0, 7) ?? (typeof w.workerVersion === "string" ? w.workerVersion : null),
    buildStale: boardCommit != null && workerBuildSha(w.workerVersion) != null
      && !boardCommit.startsWith(workerBuildSha(w.workerVersion)!) && !workerBuildSha(w.workerVersion)!.startsWith(boardCommit),
    heartbeatAt: w.lastHeartbeatAt ?? null,
    ...(w.update?.state === "updating" ? { updatePending: String(w.update.reason ?? "updating") } : {}),
    freeRamGb: w.capacity?.freeRamGb ?? null,
    freeDiskGb: w.capacity?.freeDiskGb ?? null,
    pinned: w.settingsReport?.pinned ?? [],
    ...(typeof w.concurrency?.mode === "string" ? { concurrencyMode: w.concurrency.mode } : {}),
    ...(typeof w.concurrency?.hold === "string" ? { concurrencyHold: w.concurrency.hold } : {}),
    ...(describeWorkerProfiles(w.profiles ?? w.attestedProfiles, w.unattestedProfiles) ? { profiles: describeWorkerProfiles(w.profiles ?? w.attestedProfiles, w.unattestedProfiles) } : {}),
    desiredPending: w.desiredSettings != null && w.settingsReport?.appliedRev !== w.desiredSettings?.rev,
    ...(w.toolchainInstall && typeof w.toolchainInstall.state === "string"
      ? { toolchainInstall: { state: w.toolchainInstall.state, toolchains: w.toolchainInstall.toolchains ?? [], reason: w.toolchainInstall.reason } }
      : {}),
    ...(Array.isArray(w.verifyJobs) && w.verifyJobs.length > 0 ? { verifyJobStartedAt: w.verifyJobs.map((j: Record<string, any>) => (typeof j.startedAt === "string" ? j.startedAt : null)) } : {}),
    ...(Array.isArray(w.verifyJobs) && w.verifyJobs.length > 0 ? { verifyJobs: w.verifyJobs.map((j: Record<string, any>) => `${j.kind} ${String(j.sha).slice(0, 9)} (${j.tier}) ${j.stage}${j.filesTotal ? ` ${j.filesDone ?? 0}/${j.filesTotal}` : ""}${j.disconnectedAt ? " [worker disconnected, holding]" : j.reattached ? " [re-attached]" : ""}`) } : {}),
    tickets: (w.assignments ?? []).map((a: Record<string, any>) => ({
      issueNumber: a.issueNumber ?? null, status: String(a.status ?? ""), startedAt: a.startedAt ?? null, phase: a.phase ?? a.kind ?? null,
    })),
  }));
  for (const w of workers) {
    w.stale = w.status !== "online" && w.heartbeatAt != null && (nowMs - new Date(w.heartbeatAt).getTime() > STALE_WORKER_MS);
    if (w.stale) continue;
    if (w.status !== "online") attention.push({ level: "yellow", text: `${w.name}: ${w.status}` });
    const ti = w.toolchainInstall;
    if (ti && (ti.state === "failed" || ti.state === "pending")) {
      attention.push({ level: "yellow", text: `${w.name}: toolchain install ${ti.state} (${ti.toolchains.join(", ")})${ti.reason ? `: ${ti.reason}` : ""}` });
    }
  }

  // #1426: a worker whose claude login is dead is online and attests profiles, but cannot run anything.
  for (const w of p.workers?.workers ?? []) {
    const expired = authExpiredProfileNames((w.profiles ?? w.attestedProfiles), "claude");
    if (expired.length > 0) {
      const row = workers.find((x) => x.name === String(w.name ?? w.workerId ?? w.id ?? "?"));
      if (row) row.authExpired = true;
      attention.push({ level: "red", text: describeAuthExpired(String(w.name ?? w.id ?? "?"), "claude", expired) });
    } else pushCredentialProblem(w, workers, attention);
  }

  const refOf = (workspaceId: string): string => {
    const hit = status.issues.find((i) => i.workspace?.id === workspaceId);
    return hit?.issueNumber != null ? `#${hit.issueNumber}` : workspaceId.slice(0, 8);
  };
  const trains: ConsoleTrain[] = (p.trains?.trains ?? []).slice(0, 6).map((t) => ({
    label: t.label, state: t.state, startedAt: t.startedAt, finishedAt: t.finishedAt, ...parseEvidence(t, refOf),
  }));
  const latestLandedMs = Math.max(0, ...trains.filter((t) => t.state === "landed").map((t) => new Date(t.startedAt).getTime()));
  for (const t of trains) t.superseded = t.state === "red" && new Date(t.startedAt).getTime() < latestLandedMs;
  const redTrainMembers = redTrainMemberStates(p.trains?.trains ?? [], status.issues);
  for (const t of trains) {
    if (t.superseded) continue;
    if (t.state === "red") {
      // #1583: a red train is only actionable while one of its members is still waiting on it.
      const m = redTrainMembers.get(t.label);
      if (m && m.stuck === 0) {
        if (m.reworking.length > 0) attention.push({ level: "yellow", text: `${t.label} red, members reworking: ${m.reworking.join(" ")}` });
        continue;
      }
      attention.push({ level: "red", text: `${t.label} red${t.gateFailure ? `: ${t.gateFailure}` : ""}` });
    }
    else if (t.dropped > 0 && !t.finishedAt) attention.push({ level: "yellow", text: `${t.label}: ${t.dropped} member(s) dropped/deferred` });
  }
  const trainMergedToday = (p.trains?.trains ?? [])
    .filter((t) => t.state === "landed" && t.finishedAt && new Date(t.finishedAt).getTime() >= dayStart.getTime())
    .reduce((n, t) => n + parseEvidence(t).landed, 0);

  const host: ConsoleHost | null = p.host
    ? {
        freeGb: p.host.freeGb, floorGb: p.host.floorGb, hold: p.host.hold, reason: p.host.reason ?? null,
        verifyActive: p.host.verify.active, verifySlots: p.host.verify.slots, verifyQueued: p.host.verify.queued,
      }
    : null;
  if (host?.hold) attention.push({ level: "yellow", text: `host saturated: ${host.reason ?? "low memory"}` });

  const issues: ConsoleIssue[] = status.issues.map((i) => ({
    issueNumber: i.issueNumber, title: i.title, statusName: i.statusName, column: columnOf(i),
  }));
  for (const i of status.issues) {
    const n = i.issueNumber != null ? `#${i.issueNumber}` : "#?";
    if (i.attention) attention.push({ level: "red", text: `${n} ${i.attention.label}` });
    // #1566: a mid-session push is expected; unlanded work is attention only once the session has ended.
    if (i.remoteUnlanded && i.session?.status !== "running") attention.push({ level: "yellow", text: `${n} unlanded result on ${i.remoteUnlanded.workerId.slice(0, 8)}: ${i.remoteUnlanded.label}` });
    if (i.conflicts?.hasConflicts) attention.push({ level: "red", text: `${n} merge conflict: ${i.conflicts.conflictingFiles.slice(0, 2).join(", ")}` });
  }

  const remoteRunning = workers.reduce((n, w) => n + w.tickets.length, 0);
  const localRunning = status.issues.filter((i) => i.session?.status === "running" && !i.remoteUnlanded).length;

  const model: ConsoleModel = {
    project: status.project.name,
    generatedAt: new Date(nowMs).toISOString(),
    boardTag: p.host?.boardTag ?? null,
    boardCommit: boardCommit?.slice(0, 7) ?? null,
    boardVersion: p.boardVersion ?? p.workers?.fleet?.boardWorkerVersion ?? null,
    openIssues: status.issues.length,
    runningSessions: Math.max(remoteRunning + localRunning, 0),
    host,
    workers,
    trains,
    window: p.window?.window
      ? { pending: p.window.window.pending.map((m) => m.issueNumber ?? 0), firstSeenAt: p.window.window.firstSeenAt, maxWaitMs: p.window.window.config.maxWaitMs }
      : null,
    issues,
    attention,
    // git's own count of merges in the last 24 h when the board reports it; the train sum undercounts.
    mergedToday: p.host?.mergedToday ?? trainMergedToday,
    errors: p.errors ?? [],
  };
  applyConsoleExtras(model, p);
  return model;
}

// ---------------------------------------------------------------- fetching

export type JsonGet = (path: string) => Promise<unknown>;

/**
 * Read every payload the console needs through the board's own HTTP API. A failing endpoint
 * degrades to a visible `errors` entry rather than blanking the frame; only the status read is
 * fatal, because without it there is nothing to show.
 */
export async function fetchConsolePayloads(get: JsonGet, opts: { projectId?: string; all?: boolean; nowMs: number }): Promise<ConsolePayloads> {
  const errors: string[] = [];
  const soft = async <T>(label: string, path: string): Promise<T | null> => {
    try { return (await get(path)) as T; } catch (e) { errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`); return null; }
  };
  const pid = encodeURIComponent(opts.projectId ?? "active");
  const status = (await get(`/api/projects/${pid}/status${opts.all ? "?all=true" : ""}`)) as BoardStatusResponse;
  const projectId = status.project.id;
  const [workers, host, trains, window, extras] = await Promise.all([
    soft<ConsolePayloads["workers"]>("workers", "/api/workers"),
    soft<ConsolePayloads["host"]>("host", "/api/workers/host"),
    soft<MergeTrainsResponse>("trains", `/api/merge-queue/trains?projectId=${projectId}`),
    soft<MergeTrainWindowResponse>("window", `/api/merge-queue/window?projectId=${projectId}`),
    soft<ConsoleExtrasPayload>("console", `/api/workers/console?projectId=${projectId}`),
  ]);
  return { status, workers, host, trains, window, extras, errors, nowMs: opts.nowMs };
}

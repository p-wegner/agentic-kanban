/**
 * The rolling release candidate (#1631, decision 017 Amendment 2026-10-19).
 *
 * Under a posture whose `rcSweep` is `on-idle-after-landing` (`sprint`, `flow`) the board does
 * not wait for `pnpm promote` to pay the full sweep: once the merge queue is idle and master has
 * moved past the last swept candidate it fast-forwards (or cuts) the rc and sweeps it on a spare
 * verify slot, then records the verdict on the rc sha. `pnpm promote` finds a fresh green verdict
 * for the candidate and only builds, migrates, restarts and smokes.
 *
 *  - NOT a clock: the trigger is "landed + idle". At most one sweep is in flight per project; a
 *    landing during a sweep does nothing until it finishes, and the next tick then advances the rc.
 *  - The sweep runs at BACKGROUND priority (`requestBaseBranchReprobe`'s `background` option), so
 *    it yields to a train gate; a gate that is running at all defers the start (`queue_busy`).
 *  - A red verdict needs no code here: the probe's own `reconcileRcSweepAfterProbe` files the
 *    heal ticket the moment it records the row. This service only mirrors the verdict into the
 *    lifecycle file (`green`/`red`) so the delivery view, `status --watch` and `pnpm promote`
 *    read the same state a hand-run promotion would have written.
 *
 * `decideRollingRcSweep` is pure; `runRollingRcSweepTick` takes injected deps (the shape
 * `promote-cadence.service.ts` uses) so the tests drive it with no git, no db and no probe.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execSucceeded } from "@agentic-kanban/shared/lib/exec-result";
import { gitExec } from "@agentic-kanban/shared/lib/git-exec";
import type { RcSweepMode } from "@agentic-kanban/shared/types";
import type { Database } from "../db/index.js";
import { getAllPreferences, getPreference } from "../repositories/preferences.repository.js";
import { getProjectById } from "../repositories/project.repository.js";
import { getLatestBaseBranchHealth, decodeFailedSuites, isBaseHealthAnswer } from "../repositories/base-branch-health.repository.js";
import { listActiveMergeTrainsForProject } from "../repositories/merge-train.repository.js";
import { baseHealthProbeStartPrefKey } from "./base-branch-health.service.js";
import { requestBaseBranchReprobe, resolveGateBusy } from "./base-branch-health-reprobe.service.js";
import { resolveRiskPosture } from "./risk-posture.service.js";
import {
  DEFAULT_RC_CADENCE_MS,
  RC_STATE_RELPATH,
  isTerminalRcState,
  nextRcBranch,
  readRcState,
  resolveStableCheckoutFor,
  serializeRcState,
  sortRcBranches,
  upsertRcCandidate,
  type RcCandidate,
  type RcStateFile,
} from "./rc-state.js";

/** A `sweeping` candidate with no probe behind it is retried no sooner than this (a timed-out probe records no answer). */
export const ROLLING_RC_RETRY_MS = 30 * 60 * 1000;

export type RollingRcSkip =
  | "on_promote"
  | "queue_busy"
  | "sweep_in_flight"
  | "no_master_sha"
  | "already_green"
  | "rc_red"
  | "rc_ahead_of_master"
  | "retry_backoff";

export type RollingRcDecision =
  | { action: "skip"; reason: RollingRcSkip }
  /** Sweep the candidate as it stands (its tip is master's, or it carries its own heal commits). */
  | { action: "sweep"; branch: string; sha: string }
  /** Fast-forward the candidate to master's tip, then sweep it. */
  | { action: "advance"; branch: string; sha: string }
  /** Cut a fresh candidate from master's tip (retiring `abandon`), then sweep it. */
  | { action: "cut"; sha: string; abandon: string | null };

export interface RollingRcInput {
  mode: RcSweepMode;
  queueIdle: boolean;
  probeInFlight: boolean;
  masterSha: string | null;
  /** The newest in-flight candidate whose branch exists, with its CURRENT tip (a heal can move it). */
  candidate: (RcCandidate & { tipSha: string }) | null;
  /** Is the candidate's tip an ancestor of (or equal to) master's tip — i.e. a fast-forward is lossless? */
  tipIsAncestorOfMaster: boolean;
  /** Does the stable board already contain the candidate's tip? Such a candidate is superseded. */
  shipped: boolean;
  nowMs: number;
}

/**
 * Should a rolling sweep start, and on what? Pure. The order is the policy: mode, then the queue,
 * then the debounce, then what the candidate is owed.
 */
export function decideRollingRcSweep(input: RollingRcInput): RollingRcDecision {
  if (input.mode !== "on-idle-after-landing") return { action: "skip", reason: "on_promote" };
  if (!input.queueIdle) return { action: "skip", reason: "queue_busy" };
  if (input.probeInFlight) return { action: "skip", reason: "sweep_in_flight" };
  const master = input.masterSha;
  if (!master) return { action: "skip", reason: "no_master_sha" };
  const c = input.candidate;
  if (!c) return { action: "cut", sha: master, abandon: null };
  if (input.shipped) return { action: "cut", sha: master, abandon: c.branch };

  if (c.state === "red" || c.state === "healing") {
    const sinceMs = c.updatedAt ? Date.parse(c.updatedAt) : Number.NaN;
    const stuck = c.state === "red" && Number.isFinite(sinceMs) && input.nowMs - sinceMs > DEFAULT_RC_CADENCE_MS;
    // A red rc is healed ON the candidate (decision 019); cutting past it would orphan the heal.
    return stuck ? { action: "cut", sha: master, abandon: c.branch } : { action: "skip", reason: "rc_red" };
  }

  if (c.state === "green") {
    if (c.tipSha === master) return { action: "skip", reason: "already_green" };
    // A green rc that carries commits master lacks (a healed candidate) is promoted as it is.
    return input.tipIsAncestorOfMaster ? { action: "advance", branch: c.branch, sha: master } : { action: "skip", reason: "rc_ahead_of_master" };
  }

  // `cut` / `sweeping` with no probe running: the sweep is owed (or died without an answer).
  if (c.state === "sweeping") {
    const sinceMs = c.updatedAt ? Date.parse(c.updatedAt) : Number.NaN;
    if (Number.isFinite(sinceMs) && input.nowMs - sinceMs < ROLLING_RC_RETRY_MS && c.tipSha === master) {
      return { action: "skip", reason: "retry_backoff" };
    }
  }
  if (c.tipSha !== master && input.tipIsAncestorOfMaster) return { action: "advance", branch: c.branch, sha: master };
  return { action: "sweep", branch: c.branch, sha: c.tipSha };
}

export interface RollingRcProject {
  projectId: string;
  repoPath: string;
}

export interface RollingRcHealthRow {
  sha: string;
  outcome: string;
  failedSuites: string[];
}

export interface RollingRcSweepDeps {
  listProjects: () => Promise<RollingRcProject[]>;
  readMode: (projectId: string) => Promise<RcSweepMode>;
  isQueueIdle: (projectId: string) => Promise<boolean>;
  isProbeInFlight: (projectId: string) => Promise<boolean>;
  readMasterSha: (project: RollingRcProject) => Promise<string | null>;
  listRcBranches: (project: RollingRcProject) => Promise<string[]>;
  readBranchSha: (project: RollingRcProject, branch: string) => Promise<string | null>;
  isAncestor: (project: RollingRcProject, ancestor: string, descendant: string) => Promise<boolean>;
  /** Does the stable board's HEAD contain `sha`? */
  isShipped: (project: RollingRcProject, sha: string) => Promise<boolean>;
  /** `git branch <branch> <sha>`, or `git branch -f` when `force`. */
  pointBranch: (project: RollingRcProject, branch: string, sha: string, force: boolean) => Promise<void>;
  readState: (project: RollingRcProject) => RcStateFile;
  writeState: (project: RollingRcProject, state: RcStateFile) => void;
  readLatestRcHealth: (projectId: string, branch: string) => Promise<RollingRcHealthRow | null>;
  /** Start a background sweep of the branch; true when one actually started. */
  requestSweep: (projectId: string, branch: string) => Promise<{ started: boolean; reason: string }>;
  nowMs?: number;
}

export interface RollingRcResult {
  projectId: string;
  decision: RollingRcDecision;
  branch: string | null;
  /** True when a sweep was actually started this tick. */
  started: boolean;
  error?: string;
}

function stamp(nowMs: number): string {
  const d = new Date(nowMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

/** Newest non-terminal candidate whose branch still exists. */
function inFlightCandidate(state: RcStateFile, existing: readonly string[]): RcCandidate | null {
  const live = state.candidates.filter((c) => !isTerminalRcState(c.state) && existing.includes(c.branch)).map((c) => c.branch);
  const newest = sortRcBranches(live)[0];
  return newest ? state.candidates.find((c) => c.branch === newest) ?? null : null;
}

/**
 * One tick for one project: mirror any landed verdict into the lifecycle file, decide, act.
 * Never throws — a failure is the project's own result row.
 */
async function tickProject(project: RollingRcProject, deps: RollingRcSweepDeps, nowMs: number): Promise<RollingRcResult> {
  const { projectId } = project;
  const skip = (reason: RollingRcSkip, branch: string | null = null): RollingRcResult => ({ projectId, decision: { action: "skip", reason }, branch, started: false });
  const mode = await deps.readMode(projectId);
  if (mode !== "on-idle-after-landing") return skip("on_promote");

  const at = new Date(nowMs).toISOString();
  let state = deps.readState(project);
  const existing = await deps.listRcBranches(project);
  let candidate = inFlightCandidate(state, existing);
  let tipSha: string | null = candidate ? await deps.readBranchSha(project, candidate.branch) : null;

  // 1. Record the verdict that landed for the candidate's tip — green/red on the rc sha.
  if (candidate && tipSha && (candidate.state === "cut" || candidate.state === "sweeping")) {
    const row = await deps.readLatestRcHealth(projectId, candidate.branch);
    if (row && row.sha === tipSha && isBaseHealthAnswer(row.outcome)) {
      state = upsertRcCandidate(state, candidate.branch, { sha: tipSha, state: row.outcome === "green" ? "green" : "red", failedSuites: row.outcome === "green" ? [] : row.failedSuites, note: `rolling sweep: ${row.outcome}` }, at);
      deps.writeState(project, state);
      candidate = inFlightCandidate(state, existing);
    }
  }
  // A heal merged ONTO the rc moves its tip: the recorded verdict no longer describes it.
  if (candidate && tipSha && candidate.sha && candidate.sha !== tipSha && (candidate.state === "red" || candidate.state === "healing" || candidate.state === "green")) {
    state = upsertRcCandidate(state, candidate.branch, { sha: tipSha, state: "cut", failedSuites: [], note: "rc tip moved (a heal landed on the candidate) — re-sweep owed" }, at);
    deps.writeState(project, state);
    candidate = inFlightCandidate(state, existing);
  }

  // 2. Decide.
  const masterSha = await deps.readMasterSha(project);
  const decision = decideRollingRcSweep({
    mode,
    queueIdle: await deps.isQueueIdle(projectId),
    probeInFlight: await deps.isProbeInFlight(projectId),
    masterSha,
    candidate: candidate && tipSha ? { ...candidate, tipSha } : null,
    tipIsAncestorOfMaster: candidate && tipSha && masterSha ? await deps.isAncestor(project, tipSha, masterSha) : false,
    shipped: candidate && tipSha ? await deps.isShipped(project, tipSha) : false,
    nowMs,
  });
  if (decision.action === "skip") return { projectId, decision, branch: candidate?.branch ?? null, started: false };

  // 3. Act: make the branch point at the sha to sweep, record it, ask for the sweep.
  let branch: string;
  let sha: string;
  if (decision.action === "cut") {
    branch = nextRcBranch(stamp(nowMs), existing);
    sha = decision.sha;
    await deps.pointBranch(project, branch, sha, false);
    if (decision.abandon) state = upsertRcCandidate(state, decision.abandon, { state: "abandoned", note: "superseded by the rolling rc sweep (#1631)" }, at);
    state = upsertRcCandidate(state, branch, { sha, state: "cut", cutAt: at, failedSuites: [], note: "cut from master by the rolling rc sweep (#1631)" }, at);
  } else if (decision.action === "advance") {
    branch = decision.branch;
    sha = decision.sha;
    await deps.pointBranch(project, branch, sha, true);
    state = upsertRcCandidate(state, branch, { sha, state: "cut", failedSuites: [], note: "fast-forwarded to master by the rolling rc sweep (#1631)" }, at);
  } else {
    branch = decision.branch;
    sha = decision.sha;
  }
  deps.writeState(project, state);

  const asked = await deps.requestSweep(projectId, branch);
  if (asked.started) {
    state = upsertRcCandidate(state, branch, { sha, state: "sweeping" }, at);
    deps.writeState(project, state);
  }
  return { projectId, decision, branch, started: asked.started };
}

/** One scheduler tick over every project. */
export async function runRollingRcSweepTick(deps: RollingRcSweepDeps): Promise<RollingRcResult[]> {
  const nowMs = deps.nowMs ?? Date.now();
  const results: RollingRcResult[] = [];
  const list = await deps.listProjects().catch(() => [] as RollingRcProject[]);
  for (const project of list) {
    try {
      results.push(await tickProject(project, deps, nowMs));
    } catch (err) {
      results.push({ projectId: project.projectId, decision: { action: "skip", reason: "sweep_in_flight" }, branch: null, started: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}

// --- real deps -------------------------------------------------------------------------------

export function createRollingRcSweepDeps(database: Database, listProjects: RollingRcSweepDeps["listProjects"]): RollingRcSweepDeps {
  const git = async (project: RollingRcProject, args: string[]) => gitExec(args, { cwd: project.repoPath });
  const baseBranch = async (project: RollingRcProject): Promise<string> =>
    (await getProjectById(project.projectId, database).catch(() => null))?.defaultBranch || "master";
  return {
    listProjects,
    readMode: async (projectId) => {
      const prefs = await getAllPreferences(database);
      return resolveRiskPosture(new Map(prefs.map((p) => [p.key, p.value])), projectId).rcSweep;
    },
    isQueueIdle: async (projectId) => {
      const active = await listActiveMergeTrainsForProject(projectId, ["assembling", "gating"], database);
      return active.length === 0 && !resolveGateBusy();
    },
    isProbeInFlight: async (projectId) => {
      const started = await getPreference(baseHealthProbeStartPrefKey(projectId), database).catch(() => null);
      return Boolean(started && started.trim());
    },
    readMasterSha: async (project) => {
      const r = await git(project, ["rev-parse", await baseBranch(project)]);
      return r.error || !execSucceeded(r) ? null : r.stdout.trim() || null;
    },
    listRcBranches: async (project) => {
      const r = await git(project, ["for-each-ref", "--format=%(refname:short)", "refs/heads/rc/"]);
      return r.error ? [] : r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    },
    readBranchSha: async (project, branch) => {
      const r = await git(project, ["rev-parse", branch]);
      return r.error || !execSucceeded(r) ? null : r.stdout.trim() || null;
    },
    isAncestor: async (project, ancestor, descendant) => execSucceeded(await git(project, ["merge-base", "--is-ancestor", ancestor, descendant])),
    isShipped: async (project, sha) => {
      const stable = resolveStableCheckoutFor(project.repoPath);
      const head = await gitExec(["rev-parse", "HEAD"], { cwd: stable });
      if (head.error || !execSucceeded(head) || !head.stdout.trim()) return false;
      return execSucceeded(await git(project, ["merge-base", "--is-ancestor", sha, head.stdout.trim()]));
    },
    pointBranch: async (project, branch, sha, force) => {
      const r = await git(project, ["branch", ...(force ? ["-f"] : []), branch, sha]);
      if (r.error || !execSucceeded(r)) throw new Error(`git branch ${branch} ${sha} failed: ${r.stderr || r.error?.message}`);
    },
    readState: (project) => readRcState(resolveStableCheckoutFor(project.repoPath)),
    writeState: (project, state) => {
      const path = join(resolveStableCheckoutFor(project.repoPath), RC_STATE_RELPATH);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, serializeRcState(state), "utf8");
    },
    readLatestRcHealth: async (projectId, branch) => {
      const row = await getLatestBaseBranchHealth(projectId, database, { branch }).catch(() => null);
      return row ? { sha: row.sha, outcome: row.outcome, failedSuites: decodeFailedSuites(row.failedSuites) } : null;
    },
    requestSweep: async (projectId, branch) => {
      const verdict = await requestBaseBranchReprobe(projectId, database, undefined, undefined, { branch, background: true });
      return { started: verdict.due, reason: verdict.reason };
    },
  };
}

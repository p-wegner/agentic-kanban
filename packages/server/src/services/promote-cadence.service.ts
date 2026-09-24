/**
 * The promotion cadence (#1238, decision 019 part 4): "promotion is scheduled, not remembered".
 *
 * `promote_cadence_<projectId>` is `off` (default) or `daily@HH:MM` (local time). The server's
 * minute scheduler (`startup/scheduled-tasks.ts`) calls `runDuePromoteCadences` each tick; for
 * every project whose cadence is due it FIRES the same code path `pnpm promote` runs by hand —
 * cut `rc/<date>` from master's tip (or reuse the one in flight), sweep the rc, promote the rc
 * sha on green, record red with the failing suites and stop.
 *
 * Why the fire is a DETACHED `node scripts/promote.mjs --cadence` child and not an in-process
 * call: the run's last steps stop and restart the STABLE board — the very server whose scheduler
 * is ticking when the board is operated from its stable checkout. An in-process promotion would
 * kill itself between "fast-forwarded" and "smoke", leaving the checkout moved and nothing
 * proving it came up. A detached, headless child (`windowsHide`, no terminal, no agent session,
 * stdio to the board log) survives that restart exactly as the Conductor loop does; the promote
 * log under `<stable>/.kanban/` is where its record lands, the same file a hand run writes.
 *
 * The abandon rule ("an rc older than one cadence that is still red is abandoned and a fresh one
 * cut") is applied by the run itself through `planRcCandidate` (mirrored in `rc-state.ts`) with
 * `DEFAULT_RC_CADENCE_MS` — one day, the only cadence length `daily@HH:MM` can express — so a
 * hand run and a scheduled run make the same decision from the same file.
 *
 * Pure parse/due logic is exported for the tests and the delivery view; the side-effecting
 * orchestration takes injected deps, the shape `conductor-schedule.service.ts` uses.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { projectPref } from "@agentic-kanban/shared/lib/dynamic-preference-keys";
import { currentRcCandidate, readRcState, resolveStableCheckoutFor } from "./rc-state.js";

const promoteCadencePrefDef = projectPref("promote_cadence");
const promoteCadenceStatePrefDef = projectPref("promote_cadence_state");

export function promoteCadencePrefKey(projectId: string): string {
  return promoteCadencePrefDef.key(projectId);
}

export function promoteCadenceStatePrefKey(projectId: string): string {
  return promoteCadenceStatePrefDef.key(projectId);
}

export interface PromoteCadence {
  /** `off`, or `daily`. */
  kind: "off" | "daily";
  /** Local-time minute of day the daily tick fires at (0..1439); 0 when off. */
  minuteOfDay: number;
  /** The stored spelling, normalised (`off` | `daily@HH:MM`). */
  raw: string;
  /** Set when the stored value was not one of the two accepted shapes; the cadence then reads as off. */
  error: string | null;
}

/** `off` | `daily@HH:MM` → a cadence. Anything else is `off` with an `error`, never a throw. */
export function parsePromoteCadence(raw: string | null | undefined): PromoteCadence {
  const v = (raw ?? "").trim().toLowerCase();
  if (!v || v === "off") return { kind: "off", minuteOfDay: 0, raw: "off", error: null };
  const m = /^daily@(\d{1,2}):(\d{2})$/.exec(v);
  if (!m) {
    return { kind: "off", minuteOfDay: 0, raw: "off", error: `unrecognised cadence '${raw}' — expected 'off' or 'daily@HH:MM'` };
  }
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) {
    return { kind: "off", minuteOfDay: 0, raw: "off", error: `cadence '${raw}' is not a time of day` };
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return { kind: "daily", minuteOfDay: hh * 60 + mm, raw: `daily@${pad(hh)}:${pad(mm)}`, error: null };
}

/** The scheduler's own record, kept apart from the operator's setting so a save never clobbers it. */
export interface PromoteCadenceState {
  /** ISO time the scheduler last fired a promotion for this project, or null. */
  lastFiredAt: string | null;
  /** The pid of the detached run it spawned, for the log. */
  lastPid: number | null;
}

export function parsePromoteCadenceState(raw: string | null | undefined): PromoteCadenceState {
  if (!raw) return { lastFiredAt: null, lastPid: null };
  try {
    const parsed = JSON.parse(raw) as Partial<PromoteCadenceState>;
    return {
      lastFiredAt: typeof parsed.lastFiredAt === "string" && parsed.lastFiredAt ? parsed.lastFiredAt : null,
      lastPid: typeof parsed.lastPid === "number" ? parsed.lastPid : null,
    };
  } catch {
    return { lastFiredAt: null, lastPid: null };
  }
}

/**
 * Is the daily tick due? Pure: the cadence, the last fire, and the clock.
 *
 * Due when the scheduled minute of TODAY (local time) has passed and no fire has happened
 * since that minute. A server that was down at HH:MM fires on its first tick afterwards — a
 * missed release is exactly what the cadence exists to prevent — and one that fired already
 * today waits for tomorrow's minute. `nowMs`/`lastFiredAt` are compared in the local zone
 * because the operator wrote a local time.
 */
export function isPromoteCadenceDue(cadence: PromoteCadence, lastFiredAt: string | null, nowMs: number): { due: boolean; scheduledAtMs: number | null } {
  if (cadence.kind !== "daily") return { due: false, scheduledAtMs: null };
  const now = new Date(nowMs);
  const scheduled = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, cadence.minuteOfDay, 0, 0);
  const scheduledAtMs = scheduled.getTime();
  if (nowMs < scheduledAtMs) return { due: false, scheduledAtMs };
  const lastMs = lastFiredAt ? Date.parse(lastFiredAt) : Number.NaN;
  if (Number.isFinite(lastMs) && lastMs >= scheduledAtMs) return { due: false, scheduledAtMs };
  return { due: true, scheduledAtMs };
}

export interface PromoteCadenceProject {
  projectId: string;
  repoPath: string;
}

export interface PromoteCadenceFireResult {
  projectId: string;
  fired: boolean;
  skipped?: "off" | "not_due" | "invalid" | "run_in_flight" | "fire_failed";
  pid?: number | null;
  error?: string;
  /** What the run will find: the rc most recently touched, or null — printed so the tick's log line says why a cut or a reuse follows. */
  rcBranch?: string | null;
  rcState?: string | null;
}

export interface PromoteCadenceDeps {
  listProjects: () => Promise<PromoteCadenceProject[]>;
  getCadencePref: (projectId: string) => Promise<string | null>;
  getStatePref: (projectId: string) => Promise<string | null>;
  setStatePref: (projectId: string, value: string) => Promise<void>;
  /** Spawn the run; resolves with the child's pid. Injected so the tick is testable with no process. */
  fire: (project: PromoteCadenceProject) => Promise<{ pid: number | null }>;
  /** Is a run this scheduler spawned still alive? Prevents a second run stacking on a 40-minute wait. */
  isRunAlive?: (pid: number | null) => boolean;
  nowMs?: number;
}

/** One scheduler tick over every project. Never throws; a project's failure is its own result row. */
export async function runDuePromoteCadences(deps: PromoteCadenceDeps): Promise<PromoteCadenceFireResult[]> {
  const nowMs = deps.nowMs ?? Date.now();
  const results: PromoteCadenceFireResult[] = [];
  const projects = await deps.listProjects().catch(() => [] as PromoteCadenceProject[]);
  for (const project of projects) {
    const { projectId } = project;
    const cadence = parsePromoteCadence(await deps.getCadencePref(projectId).catch(() => null));
    if (cadence.error) {
      results.push({ projectId, fired: false, skipped: "invalid", error: cadence.error });
      continue;
    }
    if (cadence.kind === "off") {
      results.push({ projectId, fired: false, skipped: "off" });
      continue;
    }
    const state = parsePromoteCadenceState(await deps.getStatePref(projectId).catch(() => null));
    const due = isPromoteCadenceDue(cadence, state.lastFiredAt, nowMs);
    if (!due.due) {
      results.push({ projectId, fired: false, skipped: "not_due" });
      continue;
    }
    if (deps.isRunAlive && deps.isRunAlive(state.lastPid)) {
      results.push({ projectId, fired: false, skipped: "run_in_flight", pid: state.lastPid });
      continue;
    }
    const rc = currentRcCandidate(readRcState(resolveStableCheckoutFor(project.repoPath)));
    try {
      const { pid } = await deps.fire(project);
      await deps.setStatePref(projectId, JSON.stringify({ lastFiredAt: new Date(nowMs).toISOString(), lastPid: pid } satisfies PromoteCadenceState));
      results.push({ projectId, fired: true, pid, rcBranch: rc?.branch ?? null, rcState: rc?.state ?? null });
    } catch (err) {
      results.push({ projectId, fired: false, skipped: "fire_failed", error: err instanceof Error ? err.message : String(err), rcBranch: rc?.branch ?? null, rcState: rc?.state ?? null });
    }
  }
  return results;
}

/** `process.kill(pid, 0)` as a liveness probe — the same check the Conductor's status read uses. */
export function isPidAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The default `fire`: a detached, headless `node scripts/promote.mjs --cadence` in the project's
 * main checkout, its output appended to `<stable>/.kanban/board.log` (never `promote.log`, which
 * the run itself appends to and the Sentinel reads — two writers on it is what §8 of
 * `docs/two-boards.md` records losing a run's opening record to).
 */
export async function spawnPromoteCadenceRun(project: PromoteCadenceProject, env: NodeJS.ProcessEnv = process.env): Promise<{ pid: number | null }> {
  const script = join(project.repoPath, "scripts", "promote.mjs");
  if (!existsSync(script)) throw new Error(`no scripts/promote.mjs in ${project.repoPath} — this project cannot be promoted by cadence`);
  const stableCheckout = resolveStableCheckoutFor(project.repoPath, env);
  const logPath = join(stableCheckout, ".kanban", "board.log");
  mkdirSync(dirname(logPath), { recursive: true });
  const out = openSync(logPath, "a");
  const child = spawn(process.execPath, [script, "--cadence"], {
    cwd: project.repoPath,
    env,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  return { pid: child.pid ?? null };
}

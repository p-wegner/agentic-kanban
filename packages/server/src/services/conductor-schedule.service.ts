// Cron scheduling for the off-process board-monitor *Conductor*.
//
// The Conductor (scripts/board-monitor/loop.sh) normally runs as a continuous
// detached loop (startConductor / stopConductor in conductor-control.service.ts).
// This module adds the other half of ticket #841: instead of an always-on loop,
// a project can drive its off-process monitor on a CRON schedule — the server's
// minute scheduler fires exactly ONE off-process cycle at each scheduled tick.
//
// Config lives in a single per-project preference (`conductor_cron_<projectId>`)
// holding a JSON blob, so no schema migration is needed. The same blob carries
// `lastFiredAt`, written by the scheduler, so the next-fire computation and the
// "is it due now?" check are deterministic across server restarts.
//
// Pure resolve/parse/due logic is exported for the route + unit tests; the
// side-effecting orchestration (`runDueConductorCrons`) takes injected deps so it
// is testable without a DB or a real process spawn.

import { getNextCronRun, validateCronExpression, describeCronExpression } from "@agentic-kanban/shared/lib/cron-utils";

export type ConductorAgent = "claude" | "codex";

export interface ConductorSchedule {
  /** Whether the cron schedule should fire off-process cycles. */
  enabled: boolean;
  /** 5-field cron expression (minute hour dom month dow). "" = unset. */
  cron: string;
  /** Which harness each fired cycle runs. */
  agent: ConductorAgent;
  /** ISO timestamp the scheduler last fired a cycle for this project (null = never). */
  lastFiredAt: string | null;
}

export interface ResolvedConductorSchedule extends ConductorSchedule {
  /** Whether `cron` parses to a valid expression. */
  valid: boolean;
  /** Human-readable validation/config error, else null. */
  error: string | null;
  /** Human-readable cron description (e.g. "Every 30 minutes"), null when invalid/unset. */
  description: string | null;
  /** ISO timestamp of the next scheduled fire (from lastFiredAt or now), null when invalid/unset. */
  nextFireAt: string | null;
}

const DEFAULT_SCHEDULE: ConductorSchedule = { enabled: false, cron: "", agent: "claude", lastFiredAt: null };

export function conductorCronPrefKey(projectId: string): string {
  return `conductor_cron_${projectId}`;
}

/** Parse the stored JSON blob into a normalized schedule, tolerant of missing/garbage values. */
export function parseConductorSchedule(raw: string | null | undefined): ConductorSchedule {
  if (!raw) return { ...DEFAULT_SCHEDULE };
  try {
    const parsed = JSON.parse(raw) as Partial<ConductorSchedule>;
    return {
      enabled: parsed.enabled === true,
      cron: typeof parsed.cron === "string" ? parsed.cron.trim() : "",
      agent: parsed.agent === "codex" ? "codex" : "claude",
      lastFiredAt: typeof parsed.lastFiredAt === "string" && parsed.lastFiredAt ? parsed.lastFiredAt : null,
    };
  } catch {
    return { ...DEFAULT_SCHEDULE };
  }
}

export function serializeConductorSchedule(schedule: ConductorSchedule): string {
  return JSON.stringify(schedule);
}

/** Resolve a stored schedule into its display/validation shape (next fire, description, errors). */
export function resolveConductorSchedule(
  raw: string | null | undefined,
  opts: { now?: Date } = {},
): ResolvedConductorSchedule {
  const schedule = parseConductorSchedule(raw);
  const now = opts.now ?? new Date();

  let valid = false;
  let error: string | null = null;
  let description: string | null = null;
  let nextFireAt: string | null = null;

  if (!schedule.cron) {
    error = schedule.enabled ? "No cron expression set" : null;
  } else {
    const v = validateCronExpression(schedule.cron);
    valid = v.valid;
    if (!v.valid) {
      error = v.error ?? "Invalid cron expression";
    } else {
      description = describeCronExpression(schedule.cron);
      // For display, project forward from the last fire (or now if it never ran).
      const base = schedule.lastFiredAt ? new Date(schedule.lastFiredAt) : now;
      const anchor = Number.isNaN(base.getTime()) ? now : base;
      const next = getNextCronRun(schedule.cron, anchor);
      nextFireAt = next ? next.toISOString() : null;
    }
  }

  return { ...schedule, valid, error, description, nextFireAt };
}

/**
 * Whether the cron schedule is due to fire at `now`. Mirrors the scheduled-runs
 * scheduler (scheduled-tasks.ts): anchor on the last fire, or one minute back when
 * it has never fired, then fire if the next cron match has already arrived.
 */
export function isConductorCronDue(schedule: ConductorSchedule, now: Date): boolean {
  if (!schedule.enabled || !schedule.cron) return false;
  if (!validateCronExpression(schedule.cron).valid) return false;
  const base = schedule.lastFiredAt ? new Date(schedule.lastFiredAt) : new Date(now.getTime() - 60_000);
  if (Number.isNaN(base.getTime())) return false;
  const next = getNextCronRun(schedule.cron, base);
  return !!next && now.getTime() >= next.getTime();
}

export interface ConductorCronProject {
  projectId: string;
  repoPath: string;
}

export type ConductorCronSkip = "not_available" | "already_running" | "fire_failed";

export interface ConductorCronResult {
  projectId: string;
  fired: boolean;
  skipped?: ConductorCronSkip;
  pid?: number | null;
  error?: string;
}

export interface ConductorCronDeps {
  /** Override the clock (tests). */
  now?: Date;
  listProjects: () => Promise<ConductorCronProject[]>;
  getSchedulePref: (projectId: string) => Promise<string | null>;
  setSchedulePref: (projectId: string, value: string) => Promise<void>;
  /** Spawn exactly one off-process cycle. */
  fire: (repoPath: string, agent: ConductorAgent) => { ok: boolean; pid: number | null; error?: string };
  /** Whether the repo ships a Conductor loop at all. */
  isAvailable: (repoPath: string) => boolean;
  /** Whether a Conductor cycle/loop is already live (don't double-drive). */
  isAlive: (repoPath: string) => boolean;
}

/**
 * Fire one off-process cycle for every project whose cron schedule is due. Records the
 * fire time so a schedule advances deterministically. Skips projects with no loop on disk,
 * and skips (but still advances) projects whose Conductor is already running so two drivers
 * never collide.
 */
export async function runDueConductorCrons(deps: ConductorCronDeps): Promise<ConductorCronResult[]> {
  const now = deps.now ?? new Date();
  const projects = await deps.listProjects();
  const results: ConductorCronResult[] = [];

  for (const project of projects) {
    const schedule = parseConductorSchedule(await deps.getSchedulePref(project.projectId));
    if (!isConductorCronDue(schedule, now)) continue;

    if (!deps.isAvailable(project.repoPath)) {
      results.push({ projectId: project.projectId, fired: false, skipped: "not_available" });
      continue;
    }

    const advanced = serializeConductorSchedule({ ...schedule, lastFiredAt: now.toISOString() });

    if (deps.isAlive(project.repoPath)) {
      // A continuous loop or a still-running prior cycle owns the board — advance the
      // schedule so we don't re-evaluate every minute, but don't spawn a second driver.
      await deps.setSchedulePref(project.projectId, advanced);
      results.push({ projectId: project.projectId, fired: false, skipped: "already_running" });
      continue;
    }

    const res = deps.fire(project.repoPath, schedule.agent);
    await deps.setSchedulePref(project.projectId, advanced);
    results.push({
      projectId: project.projectId,
      fired: res.ok,
      skipped: res.ok ? undefined : "fire_failed",
      pid: res.pid,
      error: res.error,
    });
  }

  return results;
}

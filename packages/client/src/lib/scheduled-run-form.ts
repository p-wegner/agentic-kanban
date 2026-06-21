// Pure logic for the Schedule Settings UI (ScheduleSettings.tsx). Extracted so the
// payload-building, validity, and last-run-status derivation are independently
// unit-testable (repo convention) instead of buried inline in JSX. The create and
// edit forms shared this logic verbatim before extraction; this is the single source.

import { validateCronExpression, describeCronExpression } from "./cron-utils.js";

export type ScheduleMode = "interval" | "cron";

/**
 * The schedule-shape fields of a scheduled-run payload: either a cron expression
 * (with a fixed 60-min fallback interval) or a plain interval. `clearCronOnInterval`
 * preserves the historical difference between the two callers — the edit endpoint
 * explicitly clears `cronExpression` when switching back to interval mode, while the
 * create endpoint simply omits it.
 */
export function scheduleFields(
  mode: ScheduleMode,
  intervalMinutes: number,
  cron: string,
  opts: { clearCronOnInterval: boolean },
): Record<string, unknown> {
  if (mode === "cron") {
    return { cronExpression: cron.trim(), intervalMinutes: 60 };
  }
  return opts.clearCronOnInterval
    ? { intervalMinutes, cronExpression: "" }
    : { intervalMinutes };
}

/** Body for `POST /api/scheduled-runs` — creating a new run (includes projectId). */
export function buildCreateRunPayload(args: {
  name: string;
  prompt: string;
  projectId: string;
  mode: ScheduleMode;
  intervalMinutes: number;
  cron: string;
}): Record<string, unknown> {
  return {
    name: args.name.trim(),
    prompt: args.prompt.trim(),
    projectId: args.projectId,
    ...scheduleFields(args.mode, args.intervalMinutes, args.cron, { clearCronOnInterval: false }),
  };
}

/** Body for `PUT /api/scheduled-runs/:id` — editing an existing run's name/prompt/schedule. */
export function buildUpdateRunPayload(args: {
  name: string;
  prompt: string;
  mode: ScheduleMode;
  intervalMinutes: number;
  cron: string;
}): Record<string, unknown> {
  return {
    name: args.name.trim(),
    prompt: args.prompt.trim(),
    ...scheduleFields(args.mode, args.intervalMinutes, args.cron, { clearCronOnInterval: true }),
  };
}

/** Optimistic-update patch applied to the in-memory run after a successful edit save. */
export function runEditPatch(args: {
  name: string;
  prompt: string;
  mode: ScheduleMode;
  intervalMinutes: number;
  cron: string;
  existingIntervalMinutes: number;
}): { name: string; prompt: string; intervalMinutes: number; cronExpression: string | null } {
  return {
    name: args.name.trim(),
    prompt: args.prompt.trim(),
    intervalMinutes: args.mode === "interval" ? args.intervalMinutes : args.existingIntervalMinutes,
    cronExpression: args.mode === "cron" ? args.cron.trim() : null,
  };
}

/** True when the edit form's Save button must stay disabled. */
export function isUpdateRunDisabled(args: {
  name: string;
  saving: boolean;
  mode: ScheduleMode;
  cron: string;
}): boolean {
  return !args.name.trim()
    || args.saving
    || (args.mode === "cron" && (!args.cron.trim() || !validateCronExpression(args.cron).valid));
}

/** True when the create form's Add button must stay disabled. */
export function isCreateRunDisabled(args: {
  name: string;
  prompt: string;
  saving: boolean;
  projectId: string | null | undefined;
  mode: ScheduleMode;
  cron: string;
}): boolean {
  return !args.name.trim()
    || !args.prompt.trim()
    || args.saving
    || !args.projectId
    || (args.mode === "cron" && (!args.cron.trim() || !validateCronExpression(args.cron).valid));
}

export interface CronFieldHint {
  /** Whether to render a hint at all (only once the field is non-empty). */
  show: boolean;
  valid: boolean;
  /** Human description when valid, or the validation error when not. */
  message: string;
}

/** Drives the green-description / red-error line under a cron input. */
export function cronFieldHint(cron: string): CronFieldHint {
  if (!cron.trim()) return { show: false, valid: false, message: "" };
  const result = validateCronExpression(cron);
  return result.valid
    ? { show: true, valid: true, message: describeCronExpression(cron) }
    : { show: true, valid: false, message: result.error ?? "" };
}

export interface LastRunDisplay {
  status: string;
  icon: string;
  colorClass: string;
}

/** Icon + colour for a run's last-run status badge. */
export function deriveLastRunDisplay(lastRunStatus: string | null | undefined): LastRunDisplay {
  const status = lastRunStatus ?? "unknown";
  const isRunning = status === "running";
  const isSuccess = status === "success" || status === "completed";
  return {
    status,
    icon: isRunning ? "●" : isSuccess ? "✓" : "✗",
    colorClass: isRunning ? "text-blue-500" : isSuccess ? "text-green-600" : "text-red-600",
  };
}

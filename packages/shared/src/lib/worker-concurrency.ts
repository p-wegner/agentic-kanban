/**
 * Worker concurrency as a first-class setting (#1456): `maxConcurrency: "auto"` sizes a worker's
 * slots from its own hardware instead of an operator guess.
 *
 * Pure policy, no DB, no node: `WorkerSettings` + the worker's heartbeat `capacity` in, a verdict
 * out — the mode (auto/fixed/pinned), the derived slot count, the reason, and (live back-off) a
 * placement hold. A hold only stops NEW placements; running sessions are never touched.
 */
import type { WorkerSettings } from "./worker-settings.js";
import type { WorkerCapacityInfo } from "./worker-protocol.js";

export const AUTO_CONCURRENCY = "auto" as const;

export const DEFAULT_MIN_SLOTS = 1;
export const DEFAULT_MAX_SLOTS = 4;
/** RAM one TS builder session (agent + vitest) needs. */
export const DEFAULT_SESSION_RAM_GB = 4;
/** What the machine's owner keeps: a quarter of RAM, never less than this. */
export const MIN_RESERVE_GB = 4;
export const RESERVE_FRACTION = 0.25;
/** One slot per this many cores / free disk GB (disk only bounds when it is known). */
export const CORES_PER_SLOT = 2;
export const DISK_GB_PER_SLOT = 5;

/** Per-session RAM by stack: JVM/Gradle builds are far hungrier than a TS builder. */
export const STACK_SESSION_RAM_GB: Readonly<Record<string, number>> = {
  node: 4,
  typescript: 4,
  python: 3,
  go: 3,
  rust: 6,
  java: 8,
  jvm: 8,
  gradle: 8,
  maven: 8,
  kotlin: 8,
  dotnet: 6,
};

/** Per-session RAM budget: an explicit override wins, then the stack's table entry, then the default. */
export function resolveSessionRamGb(stack?: string | null, override?: number): number {
  if (override !== undefined && Number.isFinite(override) && override > 0) return override;
  const key = (stack ?? "").trim().toLowerCase();
  return STACK_SESSION_RAM_GB[key] ?? DEFAULT_SESSION_RAM_GB;
}

/** The RAM kept free for the machine's owner. */
export function reserveGbFor(totalRamGb: number): number {
  return Math.max(MIN_RESERVE_GB, totalRamGb * RESERVE_FRACTION);
}

export interface AutoSlotInput {
  totalRamGb: number;
  cores?: number;
  freeDiskGb?: number;
  sessionRamGb?: number;
  minSlots?: number;
  maxSlots?: number;
}

/** Normalised `minSlots`/`maxSlots`: whole numbers, min >= 1, max >= min. */
export function slotBounds(minSlots?: number, maxSlots?: number): { min: number; max: number } {
  const min = Math.max(1, Math.floor(minSlots ?? DEFAULT_MIN_SLOTS));
  const max = Math.max(min, Math.floor(maxSlots ?? DEFAULT_MAX_SLOTS));
  return { min, max };
}

/** Slots the hardware supports, clamped to the bounds. The tightest of RAM, cores and disk wins. */
export function deriveAutoSlots(input: AutoSlotInput): number {
  const { min, max } = slotBounds(input.minSlots, input.maxSlots);
  const perSession = resolveSessionRamGb(null, input.sessionRamGb);
  const byRam = Math.floor((input.totalRamGb - reserveGbFor(input.totalRamGb)) / perSession);
  const limits = [byRam];
  if (input.cores !== undefined && input.cores > 0) limits.push(Math.floor(input.cores / CORES_PER_SLOT));
  if (input.freeDiskGb !== undefined) limits.push(Math.floor(input.freeDiskGb / DISK_GB_PER_SLOT));
  return Math.min(max, Math.max(min, Math.min(...limits)));
}

export type WorkerConcurrencyMode = "auto" | "fixed" | "pinned";

export interface WorkerConcurrencyVerdict {
  mode: WorkerConcurrencyMode;
  /** The slot count placement uses. */
  slots: number;
  /** Auto only: the ceiling the slots were derived under. */
  maxSlots?: number;
  minSlots?: number;
  /** Human reason, shown on every surface. */
  reason: string;
  /** Auto only: set while live back-off stops NEW placements; the text says why. */
  hold?: string;
}

const GB1 = (n: number): string => n.toFixed(1);

export interface WorkerConcurrencyContext {
  /** The slot count the worker/row itself declares (`workers.max_concurrency`). */
  declaredSlots: number;
  /** `settingsReport.pinned` includes `maxConcurrency`: a start flag fixes it on the worker. */
  pinned: boolean;
  capacity?: WorkerCapacityInfo;
  /** The worker's own `maxConcurrency` setting as the board stores it. */
  settings?: WorkerSettings;
  /** Stack-derived default for `sessionRamGb` when the settings carry none. */
  stack?: string | null;
}

/**
 * The mode, derived slots and reason for one worker. A pinned flag or a board-set fixed number
 * wins over auto; the board's `"auto"` only applies when nothing pins it. Live back-off sets
 * `hold` when `thrashing` is above none, or free RAM is under the reserve.
 */
export function evaluateWorkerConcurrency(ctx: WorkerConcurrencyContext): WorkerConcurrencyVerdict {
  const setting = ctx.settings?.maxConcurrency;
  if (ctx.pinned) {
    return { mode: "pinned", slots: ctx.declaredSlots, reason: `pinned: ${ctx.declaredSlots} slot(s) from the worker's --max-concurrency flag` };
  }
  if (setting !== AUTO_CONCURRENCY) {
    const slots = typeof setting === "number" ? setting : ctx.declaredSlots;
    return { mode: "fixed", slots, reason: `fixed: ${slots} slot(s) set by an operator` };
  }

  const { min, max } = slotBounds(ctx.settings?.minSlots, ctx.settings?.maxSlots);
  const cap = ctx.capacity;
  if (!cap || cap.totalRamGb === undefined) {
    return { mode: "auto", slots: min, minSlots: min, maxSlots: max, reason: `auto: ${min} of ${max} slots (hardware not reported yet)` };
  }
  const sessionRamGb = resolveSessionRamGb(ctx.stack, ctx.settings?.sessionRamGb);
  const cores = cap.totalCores ?? undefined;
  const slots = deriveAutoSlots({
    totalRamGb: cap.totalRamGb, cores, freeDiskGb: cap.freeDiskGb, sessionRamGb, minSlots: min, maxSlots: max,
  });
  const reserve = reserveGbFor(cap.totalRamGb);
  const head = `auto: ${slots} of ${max} slots`;
  let hold: string | undefined;
  if (cap.thrashing && cap.thrashing !== "none") {
    hold = `${head}, machine is thrashing (${cap.thrashing}); no new placements until it clears`;
  } else if (cap.freeRamGb < reserve) {
    hold = `${head}, free RAM ${GB1(cap.freeRamGb)} GB under reserve ${GB1(reserve)} GB`;
  }
  const detail = `${GB1(cap.totalRamGb)} GB RAM, reserve ${GB1(reserve)} GB, ${GB1(sessionRamGb)} GB/session` +
    (cores !== undefined ? `, ${cores} cores` : "") +
    (cap.freeDiskGb !== undefined ? `, ${GB1(cap.freeDiskGb)} GB disk free` : "");
  return {
    mode: "auto", slots, minSlots: min, maxSlots: max,
    reason: hold ?? `${head} (${detail})`,
    ...(hold ? { hold } : {}),
  };
}

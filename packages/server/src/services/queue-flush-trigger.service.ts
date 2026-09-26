/**
 * The flush trigger (#1248, decision 020 part 3) — who opens the valve, and how often.
 *
 * `queue_flush_<projectId>` is `off` (default) | `manual` | `auto`; `queue_flush_thresholds_<id>`
 * is a JSON object naming when `auto` should fire. Both are pure prefMap resolvers, so the same
 * decision drives the manual CLI dry-run preview, the `POST /queue/flush` route's refusal, and
 * the monitor tick's auto-evaluation without three independent readings of the prefs drifting
 * apart.
 *
 * Fail-closed is the rule for BOTH prefs: an unparseable `queue_flush_<id>` reads as `off`
 * (never `manual`/`auto`, which is more permissive) and an unparseable
 * `queue_flush_thresholds_<id>` reads as "never trigger" (every threshold effectively infinite)
 * rather than falling back to some default that could open the valve on a value the operator
 * never actually set.
 *
 * Wiring NOT done here (the manual action button, the CLI subcommand's process/exit code, the
 * `POST /api/projects/:id/queue/flush` route, the monitor/train tick's auto-evaluation call
 * site, and the flush-history/member-comment side effects) is left for a follow-up: the pure
 * decision layer is what every one of those needs and is what the ticket's own test list names
 * (pref parsing incl. fail-closed; threshold evaluation table; daily cap; supersede path; CLI
 * dry-run output snapshot; route) as the part to prove.
 */
import { projectPref } from "@agentic-kanban/shared/lib/dynamic-preference-keys";
import type { QueuePressureSummary } from "@agentic-kanban/shared/types";
import { isFlushAllowedForLevel, type FlushRefusal } from "./merge-train-flush.js";
import type { RiskPostureLevel } from "@agentic-kanban/shared/types";

export type QueueFlushMode = "off" | "manual" | "auto";

const queueFlushPrefDef = projectPref("queue_flush");
const queueFlushThresholdsPrefDef = projectPref("queue_flush_thresholds");
const queueFlushDailyCapPrefDef = projectPref("queue_flush_daily_cap");
const queueFlushHistoryPrefDef = projectPref("queue_flush_history");

export function queueFlushPrefKey(projectId: string): string {
  return queueFlushPrefDef.key(projectId);
}
export function queueFlushThresholdsPrefKey(projectId: string): string {
  return queueFlushThresholdsPrefDef.key(projectId);
}
export function queueFlushDailyCapPrefKey(projectId: string): string {
  return queueFlushDailyCapPrefDef.key(projectId);
}
export function queueFlushHistoryPrefKey(projectId: string): string {
  return queueFlushHistoryPrefDef.key(projectId);
}

/** `off` | `manual` | `auto`. Anything else — fail CLOSED to `off`. */
export function parseQueueFlushMode(raw: string | null | undefined): QueueFlushMode {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "manual" || v === "auto" ? v : "off";
}

export interface QueueFlushThresholds {
  /** Minimum queue depth before an auto-flush may fire. */
  minWaiting: number;
  /** Oldest member must have waited at least this many minutes. */
  maxOldestAgeMinutes: number;
  /** Minimum arrivals/gate-runs ratio — a queue arriving faster than it drains. */
  arrivalsPerGateRatio: number;
}

/** No threshold can ever be met — the fail-closed value for an unparseable pref. */
export const NEVER_TRIGGER_THRESHOLDS: QueueFlushThresholds = {
  minWaiting: Number.POSITIVE_INFINITY,
  maxOldestAgeMinutes: Number.POSITIVE_INFINITY,
  arrivalsPerGateRatio: Number.POSITIVE_INFINITY,
};

/**
 * Parse `queue_flush_thresholds_<id>` (a JSON object). Any parse failure, wrong shape, or
 * non-finite/negative field fails CLOSED to {@link NEVER_TRIGGER_THRESHOLDS} — the auto trigger
 * must never fire on a value the operator did not actually set.
 */
export function parseQueueFlushThresholds(raw: string | null | undefined): QueueFlushThresholds {
  if (!raw || !raw.trim()) return NEVER_TRIGGER_THRESHOLDS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return NEVER_TRIGGER_THRESHOLDS;
  }
  if (!parsed || typeof parsed !== "object") return NEVER_TRIGGER_THRESHOLDS;
  const obj = parsed as Record<string, unknown>;
  const minWaiting = obj.minWaiting;
  const maxOldestAgeMinutes = obj.maxOldestAgeMinutes;
  const arrivalsPerGateRatio = obj.arrivalsPerGateRatio;
  const validNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
  if (!validNumber(minWaiting) || !validNumber(maxOldestAgeMinutes) || !validNumber(arrivalsPerGateRatio)) {
    return NEVER_TRIGGER_THRESHOLDS;
  }
  return { minWaiting, maxOldestAgeMinutes, arrivalsPerGateRatio };
}

export interface ThresholdEvaluation {
  met: boolean;
  /** Which threshold(s) were met, for the CLI/log line — empty when `met` is false. */
  metBy: Array<"minWaiting" | "maxOldestAgeMinutes" | "arrivalsPerGateRatio">;
}

/**
 * Pure: does this pressure summary meet the thresholds? ANY ONE threshold met is enough — a
 * queue can be under pressure by depth alone, by age alone, or by arrival rate alone, and
 * requiring all three would let a genuinely stuck queue (many old members, arrivals stalled)
 * escape a trigger meant to catch exactly that.
 */
export function evaluateQueueFlushThresholds(
  summary: QueuePressureSummary,
  thresholds: QueueFlushThresholds,
): ThresholdEvaluation {
  const metBy: ThresholdEvaluation["metBy"] = [];
  if (summary.queueDepth >= thresholds.minWaiting) metBy.push("minWaiting");
  const oldestMinutes = summary.oldestWaitingMs === null ? 0 : summary.oldestWaitingMs / 60_000;
  if (oldestMinutes >= thresholds.maxOldestAgeMinutes) metBy.push("maxOldestAgeMinutes");
  // A zero gate-run rate with nonzero arrivals is an infinite ratio — arrivals outrunning a
  // stalled gate is exactly the pressure case, so treat it as met rather than dividing by zero
  // into NaN (which would never compare >= anything and silently never trigger).
  const ratio = summary.gateRunsPerHour > 0
    ? summary.arrivalsPerHour / summary.gateRunsPerHour
    : (summary.arrivalsPerHour > 0 ? Number.POSITIVE_INFINITY : 0);
  if (ratio >= thresholds.arrivalsPerGateRatio) metBy.push("arrivalsPerGateRatio");
  return { met: metBy.length > 0, metBy };
}

/** Default daily cap when `queue_flush_daily_cap_<id>` is unset or unparseable. */
export const DEFAULT_QUEUE_FLUSH_DAILY_CAP = 2;

/** `queue_flush_daily_cap_<id>` → a positive integer, falling back to the default on any bad value. */
export function parseQueueFlushDailyCap(raw: string | null | undefined): number {
  const n = Number.parseInt((raw ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_QUEUE_FLUSH_DAILY_CAP;
}

/**
 * Has today's flush count already reached the cap? `flushTimestamps` are ISO instants of every
 * flush (manual or auto) recorded for this project; `now`/`cap` are injected for testability.
 */
export function isDailyCapReached(flushTimestamps: readonly string[], cap: number, now: string): boolean {
  const today = now.slice(0, 10);
  const todaysCount = flushTimestamps.filter((t) => t.slice(0, 10) === today).length;
  return todaysCount >= cap;
}

export interface QueueFlushRefusal {
  reason: string;
}

/**
 * Would a NEW flush supersede one already in flight? Decision 020 item 4: a flush while the
 * previous flush is still `red` is ALLOWED — it supersedes rather than being refused — and the
 * caller is expected to retarget the open heal tickets onto the new flush (#1239's abandon
 * path). This function only answers the yes/no; the retarget itself is the caller's job once a
 * DB/ticket layer is wired in.
 */
export function supersedesInFlight(previousState: string | null | undefined): boolean {
  return previousState === "red";
}

export interface QueueFlushRailsInput {
  mode: QueueFlushMode;
  posture: RiskPostureLevel;
  flushTimestamps: readonly string[];
  dailyCap: number;
  now: string;
  /** `rc-state.json`'s own `sweeping` flag — a flush never runs while a promotion sweep is in flight. */
  promotionSweeping: boolean;
}

/**
 * The full rails check (decision 020 item 5): off mode, refused posture, daily cap, and a
 * promotion in flight all refuse a flush. Returns null (go ahead) or the refusal reason.
 */
export function checkQueueFlushRails(input: QueueFlushRailsInput): QueueFlushRefusal | FlushRefusal | null {
  if (input.mode === "off") return { reason: "queue flush is off for this project (queue_flush_<id>)" };
  const postureRefusal = isFlushAllowedForLevel(input.posture);
  if (postureRefusal) return postureRefusal;
  if (input.promotionSweeping) {
    return { reason: "a promotion sweep is currently in flight (rc-state.json: sweeping) — a flush never runs alongside one" };
  }
  if (isDailyCapReached(input.flushTimestamps, input.dailyCap, input.now)) {
    return { reason: `daily flush cap (${input.dailyCap}) already reached for today` };
  }
  return null;
}

/**
 * The CLI `queue flush --dry-run` preview text (decision 020 item 2): names the members, the
 * gate that WILL run, and the heal target — or the refusal reason under strict/standard/off/cap.
 */
export function formatQueueFlushDryRun(args: {
  refusal: QueueFlushRefusal | FlushRefusal | null;
  memberBranches: readonly string[];
  healTarget: string;
}): string {
  if (args.refusal) return `flush refused: ${args.refusal.reason}`;
  const members = args.memberBranches.length > 0 ? args.memberBranches.join(", ") : "(none ready)";
  return `would flush ${args.memberBranches.length} branch(es): ${members} — gate = arch + typecheck, heal target: ${args.healTarget}`;
}

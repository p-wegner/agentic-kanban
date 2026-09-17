/**
 * Merge train batching window (#905).
 *
 * The 30s auto-merge orchestrator tick used to land whatever was ready on the very tick it
 * became ready — a train of size 1 whenever candidates trickled in one at a time, which is
 * `trainEligible`'s floor (`order.length >= 2`) failing on almost every tick and the queue
 * falling back to the per-ticket path it exists to amortize away. This module is the pure
 * decision of WHEN to stop collecting and release what has accumulated so far as one train:
 * once it reaches `train_max_size_<projectId>` (default 4) or has been waiting
 * `train_max_wait_ms_<projectId>` (default 10 min), whichever comes first.
 *
 * Kept pure and synchronous per the `decision function` kind (#585) — the accumulator state
 * it reads (how many are waiting, since when) is assembled by the orchestrator from the DB;
 * this function only judges it.
 */
import { projectPref } from "@agentic-kanban/shared/lib/dynamic-preference-keys";
import { resolveRiskPosture, type RiskPosture } from "./risk-posture.service.js";

const trainMaxSizePref = projectPref("train_max_size");
const trainMaxWaitMsPref = projectPref("train_max_wait_ms");

export interface MergeTrainWindowState {
  /** Ready workspace ids currently held back, waiting for the window to close. */
  pendingIds: string[];
  /** ISO timestamp the FIRST of the current pending set became ready. */
  firstSeenAt: string;
}

/**
 * The record persisted per project (#1186) — `MergeTrainWindowState` plus the last verdict the
 * orchestrator computed for it, so a restart restores both "what is pending" and "why it hasn't
 * left yet" instead of only the accumulator. `decidedAt` is the tick's `now`, not `Date.now()`,
 * so it stays reproducible in tests.
 */
export interface PersistedMergeTrainWindow {
  pendingIds: string[];
  firstSeenAt: string;
  lastVerdict: MergeTrainWindowVerdict;
  decidedAt: string;
}

/** Parse a `merge_train_window_<projectId>` pref value; null for absent/corrupt input (fail open — never throw into a tick). */
export function parsePersistedTrainWindow(raw: string | null | undefined): PersistedMergeTrainWindow | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedMergeTrainWindow>;
    if (!Array.isArray(parsed.pendingIds) || typeof parsed.firstSeenAt !== "string") return null;
    if (!parsed.lastVerdict || typeof parsed.lastVerdict !== "object" || typeof (parsed.lastVerdict as { release?: unknown }).release !== "boolean") return null;
    return {
      pendingIds: parsed.pendingIds,
      firstSeenAt: parsed.firstSeenAt,
      lastVerdict: parsed.lastVerdict as MergeTrainWindowVerdict,
      decidedAt: typeof parsed.decidedAt === "string" ? parsed.decidedAt : parsed.firstSeenAt,
    };
  } catch {
    return null;
  }
}

export function serializePersistedTrainWindow(record: PersistedMergeTrainWindow): string {
  return JSON.stringify(record);
}

export interface MergeTrainWindowConfig {
  /** `train_max_size_<projectId>` — release as soon as the pending set reaches this size. */
  maxSize: number;
  /** `train_max_wait_ms_<projectId>` — release once the oldest pending member has waited this long, regardless of size. */
  maxWaitMs: number;
}

export type MergeTrainWindowVerdict =
  | { release: true; reason: "max_size" | "max_wait" | "gate_busy_grace_elapsed" }
  | { release: false; reason: "accumulating" | "gate_busy" | "operator_hold" };

/**
 * The batching-window default size (#905's `standard` risk-posture row). `trainEligible`
 * additionally requires >=2 members, so 1 would never actually release a train — but a batch
 * of exactly 1 is deliberately allowed to accumulate here rather than being special-cased,
 * since a size-1 "train" degrades to the existing sequential path with no change needed.
 */
export const DEFAULT_TRAIN_MAX_SIZE = 4;

/** `standard` risk-posture default (docs/proposals/2026-08-25-risk-posture-and-merge-train.md §3). */
export const DEFAULT_TRAIN_MAX_WAIT_MS = 10 * 60 * 1000;

/**
 * How long a release may be held back for a sibling verify chain already in flight (#1138),
 * on top of whatever `maxWaitMs` says. Independent of the posture's own train window: a
 * `standard`/`iterate` project's `trainMaxWaitMs: 0` means "never artificially delay a merge
 * for BATCHING purposes", which is a different question from "don't release a singleton
 * straight into a gate slot another workspace's gate is about to hold for 20-40 minutes,
 * guaranteeing the #243 discard once it finishes and the base has moved". Short enough that an
 * idle box never notices it (the grace only ever engages while `gateBusy` is true, i.e. a real
 * verify chain is already running) and short enough that it can never itself become the
 * multi-hour livelock it exists to prevent — a released batch that misses this window merges
 * anyway and simply risks the same discard it would have taken without the grace at all.
 */
export const DEFAULT_GATE_BUSY_GRACE_MS = 60 * 1000;

/**
 * Should the batching window release its pending set as one train right now?
 *
 * `nowMs` is injected (not `Date.now()`) so this stays a pure, clock-independent decision —
 * see the root CLAUDE.md's time-injection convention.
 *
 * `gateBusy` (#1138) says whether a verify chain — this project's or another's, the semaphore
 * is process-wide — is active RIGHT NOW. A release that would otherwise fire on `max_size`
 * (most commonly a singleton batch under the `standard`/`iterate` default of `trainMaxSize: 1`)
 * is held for up to {@link DEFAULT_GATE_BUSY_GRACE_MS} instead: releasing a lone ready
 * workspace straight into an already-running 20-40 minute gate does not make it merge any
 * sooner (the box has exactly one verify slot), it only guarantees that whatever finishes
 * gating next has its verdict discarded the moment THIS release lands and moves the base
 * (#243). Held back, the sibling gate has a chance to finish and either land first (so this
 * release's own gate then runs against a settled base) or the grace elapses and this release
 * goes ahead regardless — the grace can delay a merge by at most
 * {@link DEFAULT_GATE_BUSY_GRACE_MS}, never withhold it indefinitely. A `max_wait` release
 * (the batch has already waited past `maxWaitMs` for OTHER reasons) is not eligible for this
 * hold — a batch that already timed out on its own accumulation window must not be held
 * further on top of that.
 */
/**
 * The batching window's config as a pure prefMap resolver (#937), routed through
 * `resolveRiskPosture` (#911, decision 017) — the same shape as `resolveProjectContentionMode`
 * and `resolveGateTier`.
 *
 * Explicit `train_max_size_<projectId>` / `train_max_wait_ms_<projectId>` still win when set,
 * INDEPENDENTLY of each other: an operator who pinned only the size keeps the posture's wait.
 *
 * **Two different defaults, deliberately, and this is the subtle part.** `standard`'s posture
 * row is `trainMaxSize: 1, trainMaxWaitMs: 0` — "today's behaviour exactly", i.e. the
 * SEQUENTIAL path, which is what `resolveProjectTrainMaxSize`'s `> 1` opt-in signal means by
 * its own default of 1. But the ORCHESTRATOR's window has always defaulted to
 * `DEFAULT_TRAIN_MAX_SIZE`/`DEFAULT_TRAIN_MAX_WAIT_MS` (#905), and a posture may only make a
 * project FASTER or STRICTER than its dial says — never silently retune a window an operator
 * never touched. So `standard` (and `strict`, whose row is the same numbers for the opposite
 * reason) keeps the shipped window defaults, and only a posture that ASKS for batching —
 * `fast`/`sprint`, whose `trainMaxSize > 1` — overrides them.
 */
export function resolveTrainWindowConfig(
  prefMap: Map<string, string>,
  projectId: string,
): MergeTrainWindowConfig & { posture: RiskPosture; batchingFromPosture: boolean } {
  const posture = resolveRiskPosture(prefMap, projectId);
  // `trainMaxSize > 1` is the posture ASKING for batching; 1 means "leave the window alone".
  const batchingFromPosture = posture.trainMaxSize > 1;
  const explicitSize = readPositiveInt(prefMap.get(trainMaxSizePref.key(projectId)));
  const explicitWait = readNonNegativeInt(prefMap.get(trainMaxWaitMsPref.key(projectId)));
  return {
    maxSize: explicitSize ?? (batchingFromPosture ? posture.trainMaxSize : DEFAULT_TRAIN_MAX_SIZE),
    maxWaitMs: explicitWait ?? (batchingFromPosture ? posture.trainMaxWaitMs : DEFAULT_TRAIN_MAX_WAIT_MS),
    posture,
    batchingFromPosture,
  };
}

/**
 * The merge QUEUE's opt-in signal (#904): `> 1` means "this project wants an eligible
 * independent batch to take the train strategy". Distinct from the window above — that one
 * decides WHEN to stop collecting, this one decides WHETHER the queue batches at all — and
 * distinct in its default too: absent everything it is 1 (sequential, today's behaviour),
 * never `DEFAULT_TRAIN_MAX_SIZE`.
 *
 * Explicit `train_max_size_<projectId>` wins; otherwise the posture's `trainMaxSize`, which is
 * exactly 1 for `standard`/`strict` — so a project that has never touched either knob stays on
 * the sequential path, unchanged.
 */
export function resolveTrainOptInSize(prefMap: Map<string, string>, projectId: string): number {
  return (
    readPositiveInt(prefMap.get(trainMaxSizePref.key(projectId)))
    ?? resolveRiskPosture(prefMap, projectId).trainMaxSize
  );
}

function readPositiveInt(raw: string | undefined): number | null {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function readNonNegativeInt(raw: string | undefined): number | null {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function decideMergeTrainRelease(
  state: MergeTrainWindowState,
  config: MergeTrainWindowConfig,
  nowMs: number,
  opts?: { gateBusy?: boolean; gateBusyGraceMs?: number; holdUntilMs?: number | null },
): MergeTrainWindowVerdict {
  // Operator hold (#1186, `POST /api/merge-queue/window/hold`) wins over every other signal —
  // an explicit "hold the door" must not be overridden by max_size/max_wait firing on the same
  // tick, or the control would be decorative.
  if (opts?.holdUntilMs != null && nowMs < opts.holdUntilMs) {
    return { release: false, reason: "operator_hold" };
  }
  const waitedMs = nowMs - new Date(state.firstSeenAt).getTime();
  if (state.pendingIds.length >= config.maxSize) {
    if (opts?.gateBusy && waitedMs < (opts.gateBusyGraceMs ?? DEFAULT_GATE_BUSY_GRACE_MS)) {
      return { release: false, reason: "gate_busy" };
    }
    return {
      release: true,
      reason: opts?.gateBusy ? "gate_busy_grace_elapsed" : "max_size",
    };
  }
  if (waitedMs >= config.maxWaitMs) {
    return { release: true, reason: "max_wait" };
  }
  return { release: false, reason: "accumulating" };
}

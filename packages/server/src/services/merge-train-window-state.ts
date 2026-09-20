/**
 * Persistence for the merge-train batching window (#1186).
 *
 * `decideMergeTrainRelease` (merge-train-window.ts) stays pure; the orchestrator used to keep
 * the accumulator it judges in memory only, so a restart lost `firstSeenAt` and silently
 * re-armed the max-wait clock, and nothing could show an operator WHY nine ready tickets were
 * being held. This module is the one place that record is read, written and cleared: a
 * per-project JSON preference `train_window_<projectId>` (no migration), written on every tick
 * where it changes, restored on boot, deleted when the window releases.
 *
 * The same record carries the two operator controls the routes write —
 * `heldUntil` (hold the door) and `releaseRequestedAt` (depart now) — so the orchestrator
 * picks them up on its next tick by re-reading the pref, and there is exactly one struct
 * behind the log line, the API and the verdict.
 */
import type { MergeTrainWindowVerdictDto, PersistedMergeTrainWindow } from "@agentic-kanban/shared";
import { projectPref } from "@agentic-kanban/shared/lib/dynamic-preference-keys";
import type { Database } from "../db/index.js";
import { db } from "../db/index.js";
import { deletePreferences, getPreference, setPreference } from "../repositories/preferences.repository.js";

export type { PersistedMergeTrainWindow };

export const trainWindowPref = projectPref("train_window");

const RELEASE_REASONS = new Set(["max_size", "max_wait", "gate_busy_grace_elapsed", "operator_release"]);
const HOLD_REASONS = new Set(["accumulating", "gate_busy", "held", "live_train", "base_red"]);

function isIsoString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Number.isFinite(new Date(value).getTime());
}

function parseVerdict(value: unknown): MergeTrainWindowVerdictDto | null {
  if (!value || typeof value !== "object") return null;
  const v = value as { release?: unknown; reason?: unknown };
  if (typeof v.release !== "boolean" || typeof v.reason !== "string") return null;
  if (v.release && RELEASE_REASONS.has(v.reason)) return { release: true, reason: v.reason as never };
  if (!v.release && HOLD_REASONS.has(v.reason)) return { release: false, reason: v.reason as never };
  return null;
}

/**
 * Parse one stored value. Defensive on purpose: the pref table is writable through the
 * settings route, and a malformed record must degrade to "no window" (a fresh accumulator on
 * the next tick) rather than throw inside the orchestrator loop.
 */
export function parseTrainWindow(raw: string | null | undefined): PersistedMergeTrainWindow | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;
  if (!Array.isArray(p.pendingIds) || !p.pendingIds.every((id) => typeof id === "string")) return null;
  if (!isIsoString(p.firstSeenAt) || !isIsoString(p.lastEvaluatedAt)) return null;
  const lastVerdict = parseVerdict(p.lastVerdict);
  if (!lastVerdict) return null;
  const window: PersistedMergeTrainWindow = {
    pendingIds: [...(p.pendingIds as string[])],
    firstSeenAt: p.firstSeenAt,
    lastVerdict,
    lastEvaluatedAt: p.lastEvaluatedAt,
  };
  if (isIsoString(p.heldUntil)) window.heldUntil = p.heldUntil;
  if (isIsoString(p.releaseRequestedAt)) window.releaseRequestedAt = p.releaseRequestedAt;
  return window;
}

/** Structural equality — the "written on every tick where it CHANGES" test. */
export function sameTrainWindow(
  a: PersistedMergeTrainWindow | null | undefined,
  b: PersistedMergeTrainWindow | null | undefined,
): boolean {
  if (!a || !b) return a == null && b == null;
  return (
    a.firstSeenAt === b.firstSeenAt
    && a.lastEvaluatedAt === b.lastEvaluatedAt
    && a.lastVerdict.release === b.lastVerdict.release
    && a.lastVerdict.reason === b.lastVerdict.reason
    && (a.heldUntil ?? null) === (b.heldUntil ?? null)
    && (a.releaseRequestedAt ?? null) === (b.releaseRequestedAt ?? null)
    && a.pendingIds.length === b.pendingIds.length
    && a.pendingIds.every((id, i) => id === b.pendingIds[i])
  );
}

/**
 * Every persisted window in a prefMap, keyed by projectId — the boot-time restore, read from
 * the same cached full-table scan the orchestrator already does per tick.
 */
export function readTrainWindowsFromPrefMap(prefMap: ReadonlyMap<string, string>): Map<string, PersistedMergeTrainWindow> {
  const out = new Map<string, PersistedMergeTrainWindow>();
  for (const [key, value] of prefMap) {
    const projectId = trainWindowPref.projectIdOf(key);
    if (!projectId) continue;
    const window = parseTrainWindow(value);
    if (window) out.set(projectId, window);
  }
  return out;
}

export async function readTrainWindow(projectId: string, database: Database = db): Promise<PersistedMergeTrainWindow | null> {
  return parseTrainWindow(await getPreference(trainWindowPref.key(projectId), database));
}

export async function writeTrainWindow(projectId: string, window: PersistedMergeTrainWindow, database: Database = db): Promise<void> {
  await setPreference(trainWindowPref.key(projectId), JSON.stringify(window), database);
}

export async function clearTrainWindow(projectId: string, database: Database = db): Promise<void> {
  await deletePreferences([trainWindowPref.key(projectId)], database);
}

/**
 * Operator "depart now" (`POST /api/merge-queue/window/release`): stamps `releaseRequestedAt`
 * so the next orchestrator tick releases with reason `operator_release`. Returns null when
 * the project has no open window — there is nothing to depart, and inventing a record here
 * would give the orchestrator a `firstSeenAt` nothing ever became ready at.
 *
 * `now?: string` (ISO) because the value is persisted — root CLAUDE.md's spelling rule.
 */
export async function requestTrainWindowRelease(
  projectId: string,
  database: Database = db,
  now?: string,
): Promise<PersistedMergeTrainWindow | null> {
  const existing = await readTrainWindow(projectId, database);
  if (!existing || existing.pendingIds.length === 0) return null;
  const next: PersistedMergeTrainWindow = { ...existing, releaseRequestedAt: now ?? new Date().toISOString() };
  await writeTrainWindow(projectId, next, database);
  return next;
}

/**
 * Operator "hold the door" (`POST /api/merge-queue/window/hold`): `heldUntil = now + minutes`.
 * `minutes === 0` clears the hold. A hold placed before anything is ready creates a
 * control-only record (empty `pendingIds`); the orchestrator treats an empty pending set as
 * "no accumulator yet" and stamps `firstSeenAt` when the first member arrives, so the
 * placeholder's own `firstSeenAt` never starts a max-wait clock.
 */
export async function holdTrainWindow(
  projectId: string,
  minutes: number,
  database: Database = db,
  now?: string,
): Promise<PersistedMergeTrainWindow | null> {
  const nowIso = now ?? new Date().toISOString();
  const existing = await readTrainWindow(projectId, database);
  if (minutes <= 0) {
    if (!existing) return null;
    if (existing.pendingIds.length === 0) {
      // A control-only record whose one purpose was the hold: nothing left to keep.
      await clearTrainWindow(projectId, database);
      return null;
    }
    const { heldUntil: _dropped, ...rest } = existing;
    const next: PersistedMergeTrainWindow = { ...rest };
    await writeTrainWindow(projectId, next, database);
    return next;
  }
  const heldUntil = new Date(new Date(nowIso).getTime() + minutes * 60_000).toISOString();
  const next: PersistedMergeTrainWindow = existing
    ? { ...existing, heldUntil }
    : {
      pendingIds: [],
      firstSeenAt: nowIso,
      lastVerdict: { release: false, reason: "held" },
      lastEvaluatedAt: nowIso,
      heldUntil,
    };
  await writeTrainWindow(projectId, next, database);
  return next;
}

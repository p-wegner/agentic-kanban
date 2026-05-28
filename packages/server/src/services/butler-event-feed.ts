/**
 * Butler event feed (AK-75) — pushes critical board events into the warm butler
 * session as tagged `[system event]` turns, so the butler is informed about
 * merge failures, agent crashes, stuck workspaces, etc. and can react when asked.
 *
 * Opt-in via `butler_event_feed` global preference (default false), with
 * per-project override `butler_event_feed_<projectId>` ("true" / "false" / unset).
 *
 * Rate-limited to 1 turn per 30s per project; bursts collapse into one summary
 * line so the butler isn't spammed by every retry.
 */
import { db } from "../db/index.js";
import { getPreference } from "../repositories/preferences.repository.js";
import { sendButlerTurn, getButlerSession } from "./butler-sdk.service.js";

export type ButlerSystemEventKind =
  | "merge_failed"
  | "workspace_error"
  | "session_failed"
  | "stuck_agent"
  | "permission_pending"
  | "merge_retry";

export interface ButlerSystemEvent {
  projectId: string;
  kind: ButlerSystemEventKind;
  text: string;
  issueNumber?: number;
  workspaceId?: string;
  ts: number;
}

const DEFAULT_MIN_INTERVAL_MS = 30_000;

interface ProjectState {
  lastSentAt: number;
  pending: ButlerSystemEvent[];
  timer?: NodeJS.Timeout;
}

const state = new Map<string, ProjectState>();

async function isFeedEnabled(projectId: string): Promise<boolean> {
  const projectOverride = await getPreference(`butler_event_feed_${projectId}`);
  if (projectOverride === "true") return true;
  if (projectOverride === "false") return false;
  const global = await getPreference("butler_event_feed");
  return global === "true";
}

function flushBurst(projectId: string): void {
  const st = state.get(projectId);
  if (!st || st.pending.length === 0) return;
  const events = st.pending;
  st.pending = [];
  st.timer = undefined;

  const counts: Record<string, number> = {};
  for (const ev of events) counts[ev.kind] = (counts[ev.kind] || 0) + 1;
  const summary = Object.entries(counts).map(([k, n]) => `${n}× ${k}`).join(", ");
  const text = `[system event] ${events.length} board event(s) suppressed in burst window: ${summary}`;

  if (getButlerSession(projectId).active) {
    sendButlerTurn(projectId, text);
    st.lastSentAt = Date.now();
  }
}

function deliver(event: ButlerSystemEvent, intervalMs: number): void {
  const st = state.get(event.projectId) ?? { lastSentAt: 0, pending: [] };
  state.set(event.projectId, st);

  const now = Date.now();
  const elapsed = now - st.lastSentAt;

  if (elapsed >= intervalMs) {
    if (getButlerSession(event.projectId).active) {
      sendButlerTurn(event.projectId, `[system event] ${event.text}`);
      st.lastSentAt = now;
    }
    return;
  }

  st.pending.push(event);
  if (!st.timer) {
    const delay = intervalMs - elapsed;
    st.timer = setTimeout(() => flushBurst(event.projectId), delay);
    st.timer.unref?.();
  }
}

/**
 * Public entry point — called from event emitters (merge-workflow, exit-workflow,
 * monitor-cycle, approvals, workspace-crud). Fire-and-forget; errors are logged
 * but never propagated to callers.
 */
export function emitButlerSystemEvent(input: Omit<ButlerSystemEvent, "ts"> & { ts?: number }): void {
  const event: ButlerSystemEvent = { ...input, ts: input.ts ?? Date.now() };
  void (async () => {
    try {
      if (!(await isFeedEnabled(event.projectId))) return;
      if (!getButlerSession(event.projectId).active) return;
      const rawInterval = await getPreference("butler_event_feed_min_interval_ms");
      const intervalMs = rawInterval && /^\d+$/.test(rawInterval) ? Number(rawInterval) : DEFAULT_MIN_INTERVAL_MS;
      deliver(event, intervalMs);
    } catch (err) {
      console.warn(`[butler-event-feed] emit failed: project=${event.projectId} kind=${event.kind}`, err);
    }
  })();
}

/** For tests. */
export function _resetButlerEventFeedState(): void {
  for (const st of state.values()) {
    if (st.timer) clearTimeout(st.timer);
  }
  state.clear();
}

// Keep db reference live so tree-shaking doesn't drop the import — getPreference uses the default db.
void db;

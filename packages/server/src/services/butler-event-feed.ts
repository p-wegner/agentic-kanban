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

/**
 * The collaborators the feed needs, injected once at startup (#561).
 *
 * This module used to import the global `db` and the butler-session registry
 * directly, which cost it a `void db;` tree-shaking hack, a `_reset…State()` test
 * backdoor, and a `vi.mock` in every one of the 15 test files that merely happened
 * to run code emitting an event. Injection makes an UNATTACHED feed inert, so those
 * tests need no knowledge of it at all.
 *
 * (The ticket sketched routing this through `boardEvents` instead. Rejected: 5 of
 * the 11 emitting modules — the session-manager trio, `merge-backoff.service`,
 * `provider-auth-recovery` — hold no `boardEvents`, so that route would have had to
 * thread a new dependency through them rather than remove one.)
 */
export interface ButlerEventFeedRuntime {
  readPreference: (key: string) => Promise<string | null | undefined>;
  /** Whether project's DEFAULT butler session is warm. A cold session drops the event. */
  isButlerActive: (projectId: string) => boolean;
  sendTurn: (projectId: string, text: string) => void;
}

let runtime: ButlerEventFeedRuntime | null = null;

/** Wire the feed to its collaborators. Called once from `server-start.ts`. */
export function attachButlerEventFeed(next: ButlerEventFeedRuntime): void {
  runtime = next;
}

/**
 * Detach and forget all per-project rate-limit state. An unattached feed silently
 * drops every event, which is what makes it inert in tests and after shutdown.
 */
export function detachButlerEventFeed(): void {
  for (const st of state.values()) {
    if (st.timer) clearTimeout(st.timer);
  }
  state.clear();
  runtime = null;
}

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

async function isFeedEnabled(rt: ButlerEventFeedRuntime, projectId: string): Promise<boolean> {
  const projectOverride = await rt.readPreference(`butler_event_feed_${projectId}`);
  if (projectOverride === "true") return true;
  if (projectOverride === "false") return false;
  const global = await rt.readPreference("butler_event_feed");
  return global === "true";
}

function flushBurst(rt: ButlerEventFeedRuntime, projectId: string): void {
  const st = state.get(projectId);
  if (!st || st.pending.length === 0) return;
  const events = st.pending;
  st.pending = [];
  st.timer = undefined;

  const counts: Record<string, number> = {};
  for (const ev of events) counts[ev.kind] = (counts[ev.kind] || 0) + 1;
  const summary = Object.entries(counts).map(([k, n]) => `${n}× ${k}`).join(", ");
  const text = `[system event] ${events.length} board event(s) suppressed in burst window: ${summary}`;

  if (rt.isButlerActive(projectId)) {
    rt.sendTurn(projectId, text);
    st.lastSentAt = Date.now();
  }
}

function deliver(rt: ButlerEventFeedRuntime, event: ButlerSystemEvent, intervalMs: number): void {
  const st = state.get(event.projectId) ?? { lastSentAt: 0, pending: [] };
  state.set(event.projectId, st);

  const now = Date.now();
  const elapsed = now - st.lastSentAt;

  if (elapsed >= intervalMs) {
    if (rt.isButlerActive(event.projectId)) {
      rt.sendTurn(event.projectId, `[system event] ${event.text}`);
      st.lastSentAt = now;
    }
    return;
  }

  st.pending.push(event);
  if (!st.timer) {
    const delay = intervalMs - elapsed;
    st.timer = setTimeout(() => flushBurst(rt, event.projectId), delay);
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
      const rt = runtime;
      if (!rt) return;
      if (!(await isFeedEnabled(rt, event.projectId))) return;
      if (!rt.isButlerActive(event.projectId)) return;
      const rawInterval = await rt.readPreference("butler_event_feed_min_interval_ms");
      const intervalMs = rawInterval && /^\d+$/.test(rawInterval) ? Number(rawInterval) : DEFAULT_MIN_INTERVAL_MS;
      deliver(rt, event, intervalMs);
    } catch (err) {
      console.warn(`[butler-event-feed] emit failed: project=${event.projectId} kind=${event.kind}`, err);
    }
  })();
}


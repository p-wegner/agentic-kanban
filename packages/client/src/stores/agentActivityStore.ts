// Client board store — live agent-activity slice (#86).
//
// Tracks, per issue, the timestamp of the most recent session_activity/session_stats
// delta plus a short ring of the most recent tool-call signatures. The board's live
// handlers (useBoardLiveHandlers) write here as WS events stream in; the agent views
// (AgentGrid, AllWorkspacesPanel) read it and feed it to `detectAgentStall` to badge
// stalled/looping agents.
//
// Kept as a standalone store rather than threaded through BoardPage → BoardPageView →
// BoardSecondaryViews → AgentGrid because the same signal is consumed by two unrelated
// surfaces; a store avoids drilling one more prop through every layer.
//
// The raw un-deduped stream is required for loop detection: `sessionActivityRaw` in the
// realtime controller collapses consecutive identical activity strings, which would
// erase exactly the repeated-tool pattern we want to catch. So `recordActivity` here is
// called for EVERY activity event, before that dedup.
import { create } from "zustand";

/** How many recent tool-call signatures to retain per issue (loop window + slack). */
const RING_SIZE = 8;

export interface AgentActivityMeta {
  /** Epoch ms of the last activity/stats delta observed for this issue. */
  lastActivityAt: number;
  /** Recent tool-call signatures, oldest→newest, capped at RING_SIZE. */
  recentTools: string[];
}

interface AgentActivityState {
  byIssue: Record<string, AgentActivityMeta>;
  /** Record a tool-call activity (non-empty signature) at time `at` (epoch ms). */
  recordActivity: (issueId: string, tool: string, at: number) => void;
  /** Record a stats delta (token/tool-use update) at time `at` (epoch ms). */
  recordStats: (issueId: string, at: number) => void;
  /** Drop entries for issues that are no longer live (keep returns false ⇒ removed). */
  prune: (keep: (issueId: string) => boolean) => void;
  clear: () => void;
}

export const useAgentActivityStore = create<AgentActivityState>((set, get) => ({
  byIssue: {},

  recordActivity: (issueId, tool, at) => {
    if (!tool) return;
    const prev = get().byIssue[issueId];
    const recentTools = [...(prev?.recentTools ?? []), tool].slice(-RING_SIZE);
    set({ byIssue: { ...get().byIssue, [issueId]: { lastActivityAt: at, recentTools } } });
  },

  recordStats: (issueId, at) => {
    const prev = get().byIssue[issueId];
    set({
      byIssue: {
        ...get().byIssue,
        [issueId]: { lastActivityAt: at, recentTools: prev?.recentTools ?? [] },
      },
    });
  },

  prune: (keep) => {
    const cur = get().byIssue;
    let changed = false;
    const next: Record<string, AgentActivityMeta> = {};
    for (const [id, meta] of Object.entries(cur)) {
      if (keep(id)) next[id] = meta;
      else changed = true;
    }
    if (changed) set({ byIssue: next });
  },

  clear: () => set({ byIssue: {} }),
}));

/**
 * Non-reactive access for the live handlers / prune effect, which write the store
 * from outside React render (mirrors boardBulkSelectionActions).
 */
export const agentActivityActions = {
  recordActivity: (issueId: string, tool: string, at: number) =>
    useAgentActivityStore.getState().recordActivity(issueId, tool, at),
  recordStats: (issueId: string, at: number) =>
    useAgentActivityStore.getState().recordStats(issueId, at),
  prune: (keep: (issueId: string) => boolean) => useAgentActivityStore.getState().prune(keep),
};

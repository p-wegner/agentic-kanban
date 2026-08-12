import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../lib/api.js";
import { requestProjectSelection, requestViewNavigation } from "../lib/navigateView.js";
import { usePluginViewStore } from "../stores/pluginViewStore.js";

/** GET /api/inbox (#302) — everything blocked on a human, across ALL projects. */
export interface InboxItem {
  kind: "plugin-gate" | "plugin-merge" | "agent-question" | "tool-approval";
  projectId: string;
  projectName: string;
  title: string;
  detail: string | null;
  link: {
    view: "plugin-views" | "butler" | "board";
    pluginId?: string;
    pluginSlug?: string;
    loopName?: string;
    workspaceId?: string;
    issueNumber?: number | null;
  };
  createdAt: string | null;
}

export const INBOX_KIND_MARK: Record<InboxItem["kind"], string> = {
  "plugin-gate": "✋",
  // #440: a builder finished but its merge never landed — a different wait from a
  // gate, and one that sat invisible here for over a week on two projects.
  "plugin-merge": "⏳",
  "agent-question": "❓",
  "tool-approval": "🔐",
};

/**
 * ONE poll for the whole app (#411). The inbox is now read by three places — the bell
 * badge + dropdown, the header "waiting on you" chip, and the project switcher's
 * per-project dots — and a hook that fetched per consumer would have tripled a 60s
 * poll that already sweeps every project's loop surfaces server-side. Subscribers
 * share this module-level cache; the interval runs only while at least one is mounted.
 */
let items: InboxItem[] | null = null;
let inFlight: Promise<void> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
const subscribers = new Set<(next: InboxItem[] | null) => void>();

/** Force a re-read — e.g. when the bell opens, so a resolved gate vanishes at once. */
export function refreshInbox(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = apiFetch<{ items: InboxItem[] }>("/api/inbox")
    .then((res) => { items = res.items; })
    // Keep the last good list on a transient failure; only an initial failure
    // resolves `null` → `[]` so consumers stop rendering their loading state.
    .catch(() => { items = items ?? []; })
    .finally(() => {
      inFlight = null;
      for (const notify of subscribers) notify(items);
    });
  return inFlight;
}

export function useInbox(): { items: InboxItem[] | null; count: number } {
  const [snapshot, setSnapshot] = useState<InboxItem[] | null>(items);

  useEffect(() => {
    subscribers.add(setSnapshot);
    void refreshInbox();
    if (!timer) timer = setInterval(() => { void refreshInbox(); }, 60_000);
    return () => {
      subscribers.delete(setSnapshot);
      if (subscribers.size === 0 && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
  }, []);

  return { items: snapshot, count: snapshot?.length ?? 0 };
}

/** How many items wait on a human, per project id (#411 — switcher badges). */
export function inboxCountsByProject(list: InboxItem[] | null): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of list ?? []) counts.set(item.projectId, (counts.get(item.projectId) ?? 0) + 1);
  return counts;
}

export function useInboxCountsByProject(): Map<string, number> {
  const { items: list } = useInbox();
  return useMemo(() => inboxCountsByProject(list), [list]);
}

/**
 * Navigate to whatever an inbox item is waiting on. Shared by the bell and the header
 * chip so a decision is reached the same way wherever it is discovered.
 *
 * #323: an item may belong to ANOTHER project — switch first, then navigate. The
 * loopFocus request survives the project switch, so the loop pane picks it up once
 * the target project's plugin surface loads.
 */
export function openInboxItem(item: InboxItem): void {
  requestProjectSelection(item.projectId);
  if (item.link.view === "plugin-views") {
    if (item.link.pluginSlug && item.link.loopName) {
      usePluginViewStore.getState().focusLoop(item.link.pluginSlug, item.link.loopName);
    }
    requestViewNavigation("plugin-views");
  } else if (item.link.view === "butler") {
    requestViewNavigation("butler");
  } else {
    requestViewNavigation("kanban");
  }
}

/** Test-only: drop the shared cache so cases don't leak state into each other. */
export function __resetInboxCacheForTests(): void {
  items = null;
  inFlight = null;
  if (timer) clearInterval(timer);
  timer = null;
  subscribers.clear();
}

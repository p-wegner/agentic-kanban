import { useCallback, useEffect, useRef, useState } from "react";

export type NotificationEventType =
  | "workspace_merged"
  | "workspace_ready_for_merge"
  | "session_completed"
  | "session_failed"
  | "session_launched"
  | "workflow_error"
  | "workflow_transition"
  | "approval_requested"
  | "project_completed";

export interface NotificationEvent {
  id: string;
  type: NotificationEventType;
  issueId?: string;
  issueNumber?: number;
  issueTitle?: string;
  workspaceId?: string;
  timestamp: string;
}

const MAX_EVENTS = 50;

function storageKey(projectId: string) {
  return `board-activity-events-${projectId}`;
}

function readStored(projectId: string): NotificationEvent[] {
  try {
    const raw = localStorage.getItem(storageKey(projectId));
    if (!raw) return [];
    return JSON.parse(raw) as NotificationEvent[];
  } catch {
    return [];
  }
}

function writeStored(projectId: string, events: NotificationEvent[]) {
  try {
    localStorage.setItem(storageKey(projectId), JSON.stringify(events.slice(0, MAX_EVENTS)));
  } catch {
    // ignore storage errors
  }
}

function readLastRead(projectId: string): string | null {
  try {
    return localStorage.getItem(`board-activity-last-read-${projectId}`);
  } catch {
    return null;
  }
}

function writeLastRead(projectId: string, ts: string) {
  try {
    localStorage.setItem(`board-activity-last-read-${projectId}`, ts);
  } catch {
    // ignore
  }
}

const RELEVANT_REASONS = new Set<string>([
  "workspace_merged",
  "workspace_ready_for_merge",
  "session_completed",
  "session_launched",
  "workflow_error",
  "workflow_transition",
  "project_completed",
]);

interface IssueSnapshot {
  id: string;
  issueNumber?: number;
  title?: string;
  workspaceId?: string;
}

export function useActivityNotifications(projectId: string | null) {
  const [events, setEvents] = useState<NotificationEvent[]>([]);
  const [lastReadAt, setLastReadAt] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const prevProjectId = useRef<string | null>(null);

  // Load persisted state when projectId changes
  useEffect(() => {
    if (!projectId) return;
    if (prevProjectId.current !== projectId) {
      prevProjectId.current = projectId;
      setEvents(readStored(projectId));
      setLastReadAt(readLastRead(projectId));
      setIsOpen(false);
    }
  }, [projectId]);

  const addBoardEvent = useCallback(
    (reason: string, issueSnapshot?: IssueSnapshot) => {
      if (!projectId) return;
      if (!RELEVANT_REASONS.has(reason)) return;

      const type = reason as NotificationEventType;
      const ts = new Date().toISOString();
      const id = `${reason}-${ts}-${Math.random().toString(36).slice(2)}`;

      const event: NotificationEvent = {
        id,
        type,
        timestamp: ts,
        ...(issueSnapshot
          ? {
              issueId: issueSnapshot.id,
              issueNumber: issueSnapshot.issueNumber,
              issueTitle: issueSnapshot.title,
              workspaceId: issueSnapshot.workspaceId,
            }
          : {}),
      };

      setEvents((prev) => {
        const next = [event, ...prev].slice(0, MAX_EVENTS);
        writeStored(projectId, next);
        return next;
      });
    },
    [projectId],
  );

  const addApprovalEvent = useCallback(
    (workspaceId: string, issueSnapshot?: IssueSnapshot) => {
      if (!projectId) return;
      const ts = new Date().toISOString();
      const id = `approval_requested-${ts}-${workspaceId}`;

      const event: NotificationEvent = {
        id,
        type: "approval_requested",
        timestamp: ts,
        workspaceId,
        ...(issueSnapshot
          ? {
              issueId: issueSnapshot.id,
              issueNumber: issueSnapshot.issueNumber,
              issueTitle: issueSnapshot.title,
            }
          : {}),
      };

      setEvents((prev) => {
        // Deduplicate: don't add another approval event for same workspaceId
        // within 60s (the agent may re-request if the user dismisses)
        const recentDupe = prev.find(
          (e) =>
            e.type === "approval_requested" &&
            e.workspaceId === workspaceId &&
            Date.now() - new Date(e.timestamp).getTime() < 60_000,
        );
        if (recentDupe) return prev;

        const next = [event, ...prev].slice(0, MAX_EVENTS);
        writeStored(projectId, next);
        return next;
      });
    },
    [projectId],
  );

  const markRead = useCallback(() => {
    if (!projectId) return;
    const now = new Date().toISOString();
    setLastReadAt(now);
    writeLastRead(projectId, now);
  }, [projectId]);

  const openDropdown = useCallback(() => {
    setIsOpen(true);
  }, []);

  const closeDropdown = useCallback(() => {
    setIsOpen(false);
  }, []);

  const unreadCount = events.filter(
    (e) => !lastReadAt || e.timestamp > lastReadAt,
  ).length;

  return {
    events,
    unreadCount,
    isOpen,
    openDropdown,
    closeDropdown,
    markRead,
    addBoardEvent,
    addApprovalEvent,
  };
}

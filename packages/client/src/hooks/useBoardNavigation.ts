import { useCallback, useMemo } from "react";
import { useTicketTrail } from "./useTicketTrail.js";
import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";

export function useBoardNavigation(
  columns: StatusWithIssues[],
  setSelectedIssue: (issue: IssueWithStatus | null) => void,
) {
  const ticketTrail = useTicketTrail();

  const openIssueById = useCallback(
    (issueId: string): boolean => {
      for (const col of columns) {
        const found = col.issues.find((i) => i.id === issueId);
        if (found) {
          setSelectedIssue(found);
          return true;
        }
      }
      return false;
    },
    [columns, setSelectedIssue],
  );

  const navigateTrail = useCallback(
    (entry: { id: string } | null) => {
      if (!entry) {
        setSelectedIssue(null);
        return;
      }
      if (!openIssueById(entry.id)) {
        ticketTrail.remove(entry.id);
        setSelectedIssue(null);
      }
    },
    [openIssueById, ticketTrail, setSelectedIssue],
  );

  const trailControls = useMemo(
    () => ({
      entries: ticketTrail.entries,
      activeId: ticketTrail.activeId,
      canGoBack: ticketTrail.canGoBack,
      canGoForward: ticketTrail.canGoForward,
      onBack: () => navigateTrail(ticketTrail.goBack()),
      onForward: () => navigateTrail(ticketTrail.goForward()),
      onSelect: (id: string) => navigateTrail(ticketTrail.goTo(id)),
      onRemove: (id: string) => {
        const wasActive = ticketTrail.activeId === id;
        const next = ticketTrail.remove(id);
        if (wasActive) navigateTrail(next);
      },
    }),
    [ticketTrail, navigateTrail],
  );

  return { openIssueById, navigateTrail, trailControls, ticketTrail };
}

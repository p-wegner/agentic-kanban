export const WORKFLOW_HISTORY_LIMIT = 50;

export interface WorkflowHistoryState<TSnapshot> {
  past: TSnapshot[];
  future: TSnapshot[];
}

export function emptyWorkflowHistory<TSnapshot>(): WorkflowHistoryState<TSnapshot> {
  return { past: [], future: [] };
}

export function pushWorkflowHistory<TSnapshot>(
  history: WorkflowHistoryState<TSnapshot>,
  snapshot: TSnapshot,
  limit = WORKFLOW_HISTORY_LIMIT,
): WorkflowHistoryState<TSnapshot> {
  return {
    past: [...history.past, snapshot].slice(-limit),
    future: [],
  };
}

export function undoWorkflowHistory<TSnapshot>(
  history: WorkflowHistoryState<TSnapshot>,
  current: TSnapshot,
): { history: WorkflowHistoryState<TSnapshot>; snapshot: TSnapshot | null } {
  const snapshot = history.past.at(-1) ?? null;
  if (!snapshot) return { history, snapshot: null };

  return {
    snapshot,
    history: {
      past: history.past.slice(0, -1),
      future: [current, ...history.future],
    },
  };
}

export function redoWorkflowHistory<TSnapshot>(
  history: WorkflowHistoryState<TSnapshot>,
  current: TSnapshot,
): { history: WorkflowHistoryState<TSnapshot>; snapshot: TSnapshot | null } {
  const snapshot = history.future[0] ?? null;
  if (!snapshot) return { history, snapshot: null };

  return {
    snapshot,
    history: {
      past: [...history.past, current].slice(-WORKFLOW_HISTORY_LIMIT),
      future: history.future.slice(1),
    },
  };
}

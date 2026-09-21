// Compact board-tracker wire-contract types (pure DTOs). See ../api.ts barrel.
// Deliberately narrower than BoardStatusResponse (./board.ts) — this is the payload
// a terminal dashboard (ak-1128) polls/streams at short intervals, so it carries
// counts and a short active-agent list rather than full per-issue detail.

export interface TrackerSnapshotActiveWorkspace {
  issueNumber: number | null;
  title: string;
  statusName: string;
  workspaceStatus: string;
  branch: string;
  lastActivity: string | null;
}

export interface TrackerSnapshot {
  project: { id: string; name: string };
  generatedAt: string;
  /** Open-issue counts keyed by status name, in board column order. */
  statusCounts: Record<string, number>;
  wip: { current: number; limit: number };
  /** Open issues whose dependencies are not yet resolved (see dependency-wave.service.ts). */
  blockedCount: number;
  activeWorkspaces: TrackerSnapshotActiveWorkspace[];
  /** Most recent activity timestamp across all active workspaces/sessions, if any. */
  lastActivityAt: string | null;
}

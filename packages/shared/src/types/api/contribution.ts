// Wire contract of GET /api/projects/:id/contributions (#1264) — who contributed how much.

export type ContributionGroupBy = "provider" | "profile" | "model" | "author";

/** One actor's row. A `null` metric means "not recorded" and must render as "–", never 0. */
export interface ContributionActorRow {
  /** The grouped value (provider name, profile, model or git author); the placeholder when unset. */
  actor: string;
  /** True when the actor is the "(unset)" bucket rather than a real value. */
  unset: boolean;
  doneIssues: number;
  mergedIssues: number;
  workspaces: number;
  sessions: number;
  failedSessions: number;
  abortedSessions: number;
  mergedCommits: number | null;
  linesAdded: number | null;
  linesRemoved: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  /** Sum of session durations in ms; null when no session recorded one. */
  activeMs: number | null;
}

export interface ContributionsResponse {
  projectId: string;
  groupBy: ContributionGroupBy;
  /** The effective window (ISO), null = unbounded on that side. */
  from: string | null;
  to: string | null;
  actors: ContributionActorRow[];
}

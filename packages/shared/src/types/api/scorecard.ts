/**
 * Workspace-scorecard wire types (#569) — declared in the service AND re-declared in
 * `client/src/components/WorkspaceCard.tsx`.
 */

export interface ScorecardDimension {
  name: string;
  score: number;
  maxScore: number;
  signal: string;
}

export interface ScorecardResult {
  total: number;
  dimensions: ScorecardDimension[];
  computedAt: string;
}

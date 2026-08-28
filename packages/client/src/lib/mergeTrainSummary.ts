/**
 * Pure view-model for the "Merge train" summary (#906) — aboard / waiting / last gate /
 * red-debt delta, derived from `GET /api/merge-queue/trains?projectId=` history. Kept pure
 * per `lib/<feature>.ts` (#589) so the derivation is testable without a component.
 */

export type MergeTrainState = "assembling" | "gating" | "landing" | "landed" | "red" | "abandoned";

export interface MergeTrainGateEvidence {
  gateRuns?: number;
  gateFailure?: string | null;
  landed?: string[];
  dropped?: Array<{ workspaceId: string; reason: string }>;
  mergeSha?: string | null;
}

export interface MergeTrainRowDto {
  id: string;
  projectId: string;
  label: string;
  memberWorkspaceIds: string;
  state: MergeTrainState;
  gateEvidence: string | null;
  bisectResult: string | null;
  reconciledReason: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface MergeTrainSummary {
  /** Currently in flight (assembling/gating/landing), most recent first. */
  aboard: MergeTrainRowDto[];
  /** Member count of the currently-aboard train, if any. */
  aboardMemberCount: number;
  /** Terminal rows (landed/red/abandoned) still in the fetched history. */
  waitingCount: number;
  /** The most recently finished (or currently running) train's gate outcome, if any. */
  lastGate: {
    trainId: string;
    state: MergeTrainState;
    gateRuns: number | null;
    finishedAt: string | null;
  } | null;
  /**
   * Red-debt delta: members dropped or gate-rejected across the most recent trains, minus
   * members that landed — a rough measure of whether the train is bleeding members or
   * clearing them. Positive means debt is growing.
   */
  redDebtDelta: number;
}

function parseMemberIds(row: MergeTrainRowDto): string[] {
  try {
    const parsed: unknown = JSON.parse(row.memberWorkspaceIds);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function parseGateEvidence(row: MergeTrainRowDto): MergeTrainGateEvidence | null {
  if (!row.gateEvidence) return null;
  try {
    return JSON.parse(row.gateEvidence) as MergeTrainGateEvidence;
  } catch {
    return null;
  }
}

const ABOARD_STATES: readonly MergeTrainState[] = ["assembling", "gating", "landing"];

export function summarizeMergeTrains(rows: MergeTrainRowDto[]): MergeTrainSummary {
  const sorted = [...rows].sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

  const aboard = sorted.filter((row) => ABOARD_STATES.includes(row.state));
  const aboardMemberCount = aboard.reduce((sum, row) => sum + parseMemberIds(row).length, 0);
  const waitingCount = sorted.filter((row) => !ABOARD_STATES.includes(row.state)).length;

  const mostRecent = sorted[0] ?? null;
  const lastGate = mostRecent
    ? {
        trainId: mostRecent.id,
        state: mostRecent.state,
        gateRuns: parseGateEvidence(mostRecent)?.gateRuns ?? null,
        finishedAt: mostRecent.finishedAt,
      }
    : null;

  // Look at the last 10 terminal trains for the red-debt trend.
  const recentTerminal = sorted.filter((row) => row.state === "landed" || row.state === "red").slice(0, 10);
  let redDebtDelta = 0;
  for (const row of recentTerminal) {
    const evidence = parseGateEvidence(row);
    const dropped = evidence?.dropped?.length ?? 0;
    const landed = evidence?.landed?.length ?? 0;
    redDebtDelta += dropped - landed;
  }

  return { aboard, aboardMemberCount, waitingCount, lastGate, redDebtDelta };
}

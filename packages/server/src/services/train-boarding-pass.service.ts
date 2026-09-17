/**
 * Project a `merge_trains` row onto the "boarding pass" chip fact set (#1188) — car position,
 * phase, and (once terminal) the outcome, per workspace. Kept as a pure-ish helper over an
 * already-fetched train row + issue-number map so the projection is testable without a DB;
 * the DB read (issue numbers for co-members) lives in `buildTrainBoardingPasses`, the batch
 * entry point `buildWorkspaceSummaryMap` calls.
 */
import type { Database } from "../db/index.js";
import { db } from "../db/index.js";
import type { MergeTrainGateEvidenceDto, TrainBoardingPassDto } from "@agentic-kanban/shared";
import {
  findRecentMergeTrainsForWorkspaces,
  getIssueNumbersByWorkspaceIds,
  getProjectIdsByWorkspaceIds,
  type MergeTrainRow,
} from "../repositories/merge-train.repository.js";

const RUNNING_STATE_TO_PHASE: Partial<Record<MergeTrainRow["state"], TrainBoardingPassDto["phase"]>> = {
  assembling: "assembling",
  gating: "gating",
  landing: "landing",
};

function parseMemberIds(row: MergeTrainRow): string[] {
  try {
    const parsed: unknown = JSON.parse(row.memberWorkspaceIds);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function parseGateEvidence(row: MergeTrainRow): MergeTrainGateEvidenceDto | null {
  if (!row.gateEvidence) return null;
  try {
    return JSON.parse(row.gateEvidence) as MergeTrainGateEvidenceDto;
  } catch {
    return null;
  }
}

/**
 * The outcome for ONE member of a terminal train, given the parsed gate evidence. `null` for a
 * row still running (car position/phase is what a card shows instead).
 */
function deriveOutcome(
  workspaceId: string,
  evidence: MergeTrainGateEvidenceDto | null,
  issueNumberByWorkspaceId: Map<string, number>,
): TrainBoardingPassDto["outcome"] {
  if (!evidence) return { kind: "unresolved" };
  if (evidence.landed?.includes(workspaceId)) {
    const withIssueNumbers = (evidence.landed ?? [])
      .filter((id) => id !== workspaceId)
      .map((id) => issueNumberByWorkspaceId.get(id))
      .filter((n): n is number => n !== undefined);
    return { kind: "landed", withIssueNumbers };
  }
  const dropped = evidence.dropped?.find((d) => d.workspaceId === workspaceId);
  if (dropped) return { kind: "dropped", reason: dropped.reason };
  // gateRejected members are NOT in `landed`/`dropped` — buildTrainGateEvidence records them
  // only in the `bisectResult` column, which this projection does not read (the row's own
  // gateEvidence has no rejected-reason list); the card still needs a distinct label for that
  // case, so a member unresolved-but-outside `unresolved` reads as bisected-out. See the
  // `unresolved` list (#1154): a member absent from landed/dropped AND absent from `unresolved`
  // is exactly the individually-gate-rejected case.
  if (evidence.unresolved?.includes(workspaceId)) return { kind: "unresolved" };
  return { kind: "bisected-out", reason: evidence.gateFailure ?? "gate failed for this branch alone" };
}

/** Pure projection: one train row + this workspace's position in it -> a boarding-pass DTO. */
export function projectTrainBoardingPass(
  row: MergeTrainRow,
  workspaceId: string,
  issueNumberByWorkspaceId: Map<string, number>,
): TrainBoardingPassDto | null {
  const members = parseMemberIds(row);
  const carPosition = members.indexOf(workspaceId);
  if (carPosition === -1) return null;

  const isTerminal = row.state === "landed" || row.state === "red" || row.state === "abandoned";
  const evidence = isTerminal ? parseGateEvidence(row) : null;

  return {
    trainId: row.id,
    label: row.label,
    carPosition: carPosition + 1,
    memberCount: members.length,
    phase: isTerminal ? null : (RUNNING_STATE_TO_PHASE[row.state] ?? "assembling"),
    boardedAt: row.startedAt,
    outcome: isTerminal ? deriveOutcome(workspaceId, evidence, issueNumberByWorkspaceId) : null,
  };
}

/**
 * Batch entry point: given the trains a project's workspaces are aboard/recently terminal in
 * (already looked up via `findRecentMergeTrainsForWorkspaces`), resolve co-member issue numbers
 * (needed only for a `landed` outcome's "landed with #N #M") and project each into its DTO.
 */
export async function buildTrainBoardingPasses(
  trainsByWorkspaceId: Map<string, MergeTrainRow>,
  database: Database = db,
): Promise<Map<string, TrainBoardingPassDto>> {
  const result = new Map<string, TrainBoardingPassDto>();
  if (trainsByWorkspaceId.size === 0) return result;

  const allMemberWorkspaceIds = new Set<string>();
  for (const row of trainsByWorkspaceId.values()) {
    for (const id of parseMemberIds(row)) allMemberWorkspaceIds.add(id);
  }

  const issueNumberByWorkspaceId = allMemberWorkspaceIds.size > 0
    ? await getIssueNumbersByWorkspaceIds([...allMemberWorkspaceIds], database)
    : new Map<string, number>();

  for (const [workspaceId, row] of trainsByWorkspaceId) {
    const dto = projectTrainBoardingPass(row, workspaceId, issueNumberByWorkspaceId);
    if (dto) result.set(workspaceId, dto);
  }
  return result;
}

/**
 * Board-build entry point: given the main workspace ids a rebuild is about to render, resolve
 * each one's project (a card lookup has no project id handy — the summary map is keyed by
 * issue), find its recent train per project, and project every hit into a chip DTO. Best-effort
 * by construction (a lookup failure here must never break the board build) — callers wrap it,
 * this function itself throws on a bad query rather than swallowing, so a caller cannot forget
 * the guard silently.
 */
export async function resolveTrainBoardingPasses(
  mainWorkspaceIds: string[],
  database: Database = db,
): Promise<Map<string, TrainBoardingPassDto>> {
  if (mainWorkspaceIds.length === 0) return new Map();

  const projectIdByWorkspaceId = await getProjectIdsByWorkspaceIds(mainWorkspaceIds, database);

  const workspaceIdsByProject = new Map<string, string[]>();
  for (const [workspaceId, projectId] of projectIdByWorkspaceId) {
    const list = workspaceIdsByProject.get(projectId) ?? [];
    list.push(workspaceId);
    workspaceIdsByProject.set(projectId, list);
  }

  const trainsByWorkspaceId = new Map<string, MergeTrainRow>();
  for (const [projectId, ids] of workspaceIdsByProject) {
    const found = await findRecentMergeTrainsForWorkspaces(projectId, ids, database);
    for (const [workspaceId, row] of found) trainsByWorkspaceId.set(workspaceId, row);
  }

  return buildTrainBoardingPasses(trainsByWorkspaceId, database);
}

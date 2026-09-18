/**
 * Pure view-model for the "Merge train" summary (#906, headline metric #1184) — aboard /
 * finished / last gate / red-debt delta / gate-runs-per-landed, derived from
 * `GET /api/merge-queue/trains?projectId=` history. Kept pure per `lib/<feature>.ts` (#589) so
 * the derivation is testable without a component.
 */

import type {
  MergeTrainState,
  MergeTrainRowDto,
  MergeTrainGateEvidenceDto,
  MergeTrainSidingDto,
  MergeTrainAttemptDto,
  MergeTrainReviewEvidenceDto,
} from "@agentic-kanban/shared";

export type { MergeTrainState, MergeTrainRowDto, MergeTrainSidingDto };

/**
 * The parsed `gateEvidence` blob. The shared DTO is the one declaration (#569's ratchet):
 * this module used to carry a five-field subset, which #1197 would have had to grow into a
 * second copy of the wire shape.
 */
export type MergeTrainGateEvidence = MergeTrainGateEvidenceDto;

export interface MergeTrainSummary {
  /** Currently in flight (assembling/gating/landing), most recent first. */
  aboard: MergeTrainRowDto[];
  /** Member count of the currently-aboard train, if any. */
  aboardMemberCount: number;
  /** Terminal rows (landed/red/abandoned) in the fetched history. Replaces the old "waiting" — nothing in this count is waiting. */
  finishedCount: number;
  /** The most recently finished (or currently running) train's gate outcome, if any. */
  lastGate: {
    trainId: string;
    state: MergeTrainState;
    gateRuns: number | null;
    finishedAt: string | null;
    /** Unresolved (unattributed) member count for THIS train — see `MergeTrainGateEvidence.unresolved`. */
    unresolvedCount: number;
  } | null;
  /**
   * Red-debt delta: unique members dropped or gate-rejected across the most recent trains,
   * minus unique members that landed — a rough measure of whether the train is bleeding
   * members or clearing them. Positive means debt is growing. Deduplicated by workspace id
   * (see `gateRunsPerLanded`'s doc) so a bisect's repeated re-recording of the same conflict
   * does not inflate it.
   */
  redDebtDelta: number;
  /**
   * The amortization headline (#1184): total gate runs spent, and how many members actually
   * landed, over the last `windowSize` FINISHED (landed/red) trains. A train exists to gate N
   * tickets once instead of N times — this is whether that promise held. `gateRuns` sums each
   * train's own `gateRuns` (including bisect re-gates); `landedMembers` counts UNIQUE landed
   * workspace ids across the window (a workspace cannot land twice, so this needs no dedup,
   * but is named for symmetry with the ratio).
   */
  gateRunsPerLanded: {
    gateRuns: number;
    landedMembers: number;
    /** `gateRuns / landedMembers`, or null when nothing landed in the window (division by zero). */
    ratio: number | null;
    windowSize: number;
  };
}

function parseMemberIds(row: MergeTrainRowDto): string[] {
  try {
    const parsed: unknown = JSON.parse(row.memberWorkspaceIds);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function parseGateEvidence(row: MergeTrainRowDto): MergeTrainGateEvidence | null {
  if (!row.gateEvidence) return null;
  try {
    return JSON.parse(row.gateEvidence) as MergeTrainGateEvidence;
  } catch {
    return null;
  }
}

/** `bisectResult` is its own column: `{ gateRejected: [{ workspaceId, reason }] }` or null. */
function parseGateRejected(row: MergeTrainRowDto): Array<{ workspaceId: string; reason: string }> {
  if (!row.bisectResult) return [];
  try {
    const parsed: unknown = JSON.parse(row.bisectResult);
    const list = (parsed as { gateRejected?: unknown } | null)?.gateRejected;
    return Array.isArray(list)
      ? list.filter((e): e is { workspaceId: string; reason: string } =>
          typeof e === "object" && e !== null && typeof (e as { workspaceId?: unknown }).workspaceId === "string")
      : [];
  } catch {
    return [];
  }
}

const ABOARD_STATES: readonly MergeTrainState[] = ["assembling", "gating", "landing"];

/** How many finished trains the rolling headline/red-debt metrics look back over. */
const TRAIN_WINDOW_SIZE = 10;

/**
 * Unique workspace ids across a train's `dropped` and `gateRejected` evidence (#1184's fix for
 * the bisect-inflation defect: every sub-attempt re-assembles from scratch and re-records the
 * SAME conflict for a member that never moved between halves, so summing array lengths counts
 * one dropped member several times).
 */
function uniqueDroppedOrRejectedIds(
  evidence: MergeTrainGateEvidence | null,
  bisect: Array<{ workspaceId: string; reason: string }>,
): Set<string> {
  const ids = new Set<string>();
  for (const d of evidence?.dropped ?? []) ids.add(d.workspaceId);
  for (const r of bisect) ids.add(r.workspaceId);
  return ids;
}

/**
 * How one member fared on one train (#1197). `deferred` is the member-vs-member case (#1191):
 * the member collided with ANOTHER member and waits for the next train, whereas `dropped`
 * collided with the base and needs a rebase. `sided` is a train review's finding (#1194).
 * `aboard` is a member of a still-running train the evidence has not placed yet.
 */
export type TrainMemberOutcome = "aboard" | "landed" | "deferred" | "dropped" | "gate_rejected" | "sided" | "unresolved";

export interface TrainMemberView {
  workspaceId: string;
  outcome: TrainMemberOutcome;
  reason: string | null;
  /**
   * #1198 — the member's live siding state (#1192), when it has one: dropped for a BASE
   * conflict, sent a rebase turn, and held out until its tip moves. Distinct from `sided`,
   * which is a train REVIEW's finding (#1194): a member can in principle carry both (sided
   * by review on this train, still on a rebase siding from an earlier one), so the two are
   * separate fields rather than one outcome.
   */
  siding?: { attempts: number; capped: boolean };
}

/**
 * Every member of a train with its outcome, in the train's member order; ids the evidence
 * names but the member list does not (a row written by a runner that re-assembled) are
 * appended so nothing the train did is hidden.
 */
export function describeTrainMembers(row: MergeTrainRowDto, sidings: readonly MergeTrainSidingDto[] = []): TrainMemberView[] {
  const evidence = parseGateEvidence(row);
  const sidingByWorkspace = new Map(sidings.map((s) => [s.workspaceId, s]));
  const withSiding = (view: TrainMemberView): TrainMemberView => {
    const siding = sidingByWorkspace.get(view.workspaceId);
    return siding ? { ...view, siding: { attempts: siding.sidings, capped: Boolean(siding.cappedAt) } } : view;
  };
  const landed = new Set(evidence?.landed ?? []);
  const dropped = new Map((evidence?.dropped ?? []).map((d) => [d.workspaceId, d]));
  const sided = new Map((evidence?.sided ?? []).map((s) => [s.workspaceId, s]));
  const gateRejected = new Map(parseGateRejected(row).map((r) => [r.workspaceId, r]));
  const unresolved = new Set(evidence?.unresolved ?? []);
  const inFlight = ABOARD_STATES.includes(row.state);

  const ids = parseMemberIds(row);
  const seen = new Set(ids);
  for (const id of [...landed, ...dropped.keys(), ...sided.keys(), ...gateRejected.keys(), ...unresolved]) {
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }

  return ids.map((workspaceId): TrainMemberView => {
    if (landed.has(workspaceId)) return { workspaceId, outcome: "landed", reason: null };
    const drop = dropped.get(workspaceId);
    if (drop) return withSiding({ workspaceId, outcome: drop.deferred ? "deferred" : "dropped", reason: drop.reason });
    const side = sided.get(workspaceId);
    if (side) return withSiding({ workspaceId, outcome: "sided", reason: side.reason });
    const rejected = gateRejected.get(workspaceId);
    if (rejected) return withSiding({ workspaceId, outcome: "gate_rejected", reason: rejected.reason });
    if (unresolved.has(workspaceId) || !inFlight) return withSiding({ workspaceId, outcome: "unresolved", reason: null });
    return withSiding({ workspaceId, outcome: "aboard", reason: null });
  });
}

/**
 * The train-scoped review's verdict (#1194) as one line, or null when the row predates it.
 * `skipped`/`failed` are stated rather than hidden: a train that landed unreviewed must
 * look different from one whose review found nothing.
 */
export function describeTrainReview(row: MergeTrainRowDto): { status: MergeTrainReviewEvidenceDto["status"]; text: string; blocking: boolean } | null {
  const review = parseGateEvidence(row)?.review;
  if (!review || typeof review !== "object") return null;
  switch (review.status) {
    case "skipped":
      return { status: "skipped", text: `skipped: ${review.reason}`, blocking: false };
    case "failed":
      return { status: "failed", text: `failed to run: ${review.error}`, blocking: false };
    case "ran": {
      const findings = `${review.findingCount} finding${review.findingCount === 1 ? "" : "s"}`;
      const blocking = review.blockingCount > 0 ? `, ${review.blockingCount} blocking` : "";
      const sided = review.sidedWorkspaceIds.length > 0 ? `, ${review.sidedWorkspaceIds.length} sided` : "";
      return { status: "ran", text: `${findings}${blocking}${sided}`, blocking: review.blocking };
    }
    default:
      return null;
  }
}

/** One node of the bisect tree as the panel draws it (#1193, #1198). */
export interface TrainAttemptView {
  label: string;
  verdict: MergeTrainAttemptDto["verdict"];
  includedCount: number;
  /** Sibling labels this node gated concurrently with (#1193); empty when it gated alone. */
  concurrentWith: string[];
  /** Gate duration in ms, or null when no gate ran / the row is still gating. */
  gateMs: number | null;
  failureHead: string | null;
}

/**
 * The attempts (#1189) in the order they finished, with #1193's concurrency annotation and
 * the saving it bought, so the panel can show "q1a || q1b, saved 8 min" instead of nothing.
 * `savedMs` is 0 for a sequential tree and for rows written before #1193.
 */
export function describeTrainAttempts(row: MergeTrainRowDto): { attempts: TrainAttemptView[]; savedMs: number } {
  const evidence = parseGateEvidence(row);
  const list = Array.isArray(evidence?.attempts) ? evidence.attempts : [];
  const attempts = list
    .filter((a): a is MergeTrainAttemptDto => typeof a === "object" && a !== null && typeof (a as { label?: unknown }).label === "string")
    .map((a): TrainAttemptView => {
      const start = a.gateStartedAt ? new Date(a.gateStartedAt).getTime() : NaN;
      const end = a.gateFinishedAt ? new Date(a.gateFinishedAt).getTime() : NaN;
      return {
        label: a.label,
        verdict: a.verdict,
        includedCount: Array.isArray(a.included) ? a.included.length : 0,
        concurrentWith: Array.isArray(a.concurrentWith) ? a.concurrentWith.filter((l): l is string => typeof l === "string") : [],
        gateMs: Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null,
        failureHead: typeof a.failureHead === "string" ? a.failureHead : null,
      };
    });
  const savedMs = typeof evidence?.concurrentGateSavedMs === "number" && evidence.concurrentGateSavedMs > 0 ? evidence.concurrentGateSavedMs : 0;
  return { attempts, savedMs };
}

/** `8 min`, `45 s`, `1.5 h` — for gate durations and the concurrency saving. */
export function formatDurationShort(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  return `${(ms / 3_600_000).toFixed(1)} h`;
}

/** One member-vs-member conflict cluster (#1191), attributed to the newest train that recorded it. */
export interface TrainConflictCluster {
  trainId: string;
  trainLabel: string;
  workspaceIds: string[];
}

/**
 * The distinct conflict clusters recorded across the newest `limit` trains — the same window
 * `POST /api/issues/group-scan` mode `train-conflicts` reads (#1191), so what the panel shows
 * is what the scan would propose. A cluster seen on several trains is listed once, under the
 * newest of them.
 */
export function collectConflictClusters(rows: MergeTrainRowDto[], limit = 10): TrainConflictCluster[] {
  const sorted = [...rows].sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()).slice(0, limit);
  const out: TrainConflictCluster[] = [];
  const seen = new Set<string>();
  for (const row of sorted) {
    for (const cluster of parseGateEvidence(row)?.conflictClusters ?? []) {
      const workspaceIds = Array.isArray(cluster?.workspaceIds)
        ? cluster.workspaceIds.filter((id): id is string => typeof id === "string")
        : [];
      if (workspaceIds.length < 2) continue;
      const key = [...workspaceIds].sort().join(" ");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ trainId: row.id, trainLabel: row.label, workspaceIds });
    }
  }
  return out;
}

export function summarizeMergeTrains(rows: MergeTrainRowDto[]): MergeTrainSummary {
  const sorted = [...rows].sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

  const aboard = sorted.filter((row) => ABOARD_STATES.includes(row.state));
  const aboardMemberCount = aboard.reduce((sum, row) => sum + parseMemberIds(row).length, 0);
  const finishedCount = sorted.filter((row) => !ABOARD_STATES.includes(row.state)).length;

  const mostRecent = sorted[0] ?? null;
  const lastGate = mostRecent
    ? {
        trainId: mostRecent.id,
        state: mostRecent.state,
        gateRuns: parseGateEvidence(mostRecent)?.gateRuns ?? null,
        finishedAt: mostRecent.finishedAt,
        unresolvedCount: parseGateEvidence(mostRecent)?.unresolved?.length ?? 0,
      }
    : null;

  // Look at the last N terminal trains for the red-debt trend and the amortization headline.
  const recentTerminal = sorted.filter((row) => row.state === "landed" || row.state === "red").slice(0, TRAIN_WINDOW_SIZE);
  let redDebtDelta = 0;
  let gateRuns = 0;
  let landedMembers = 0;
  for (const row of recentTerminal) {
    const evidence = parseGateEvidence(row);
    const bisectRejected = parseGateRejected(row);
    const droppedOrRejected = uniqueDroppedOrRejectedIds(evidence, bisectRejected);
    const landed = evidence?.landed?.length ?? 0;
    redDebtDelta += droppedOrRejected.size - landed;
    gateRuns += evidence?.gateRuns ?? 0;
    landedMembers += landed;
  }

  return {
    aboard,
    aboardMemberCount,
    finishedCount,
    lastGate,
    redDebtDelta,
    gateRunsPerLanded: {
      gateRuns,
      landedMembers,
      ratio: landedMembers > 0 ? gateRuns / landedMembers : null,
      windowSize: recentTerminal.length,
    },
  };
}

/**
 * The three headline strings the summary bar renders, as a pure function of the summary —
 * pulled out of the component (#726's branch-count ceiling) so the label formatting is
 * testable without rendering.
 */
export function formatMergeTrainSummaryLabels(summary: MergeTrainSummary): { aboardLabel: string; lastGateLabel: string; headlineLabel: string } {
  const aboardLabel = summary.aboard.length === 0
    ? "none"
    : `${summary.aboard.length} (${summary.aboardMemberCount} member${summary.aboardMemberCount === 1 ? "" : "s"})`;

  const lastGateLabel = summary.lastGate
    ? `${summary.lastGate.state}${summary.lastGate.gateRuns != null ? ` (${summary.lastGate.gateRuns} run${summary.lastGate.gateRuns === 1 ? "" : "s"})` : ""}` +
      (summary.lastGate.unresolvedCount > 0 ? `, ${summary.lastGate.unresolvedCount} unresolved` : "")
    : "none yet";

  const { gateRunsPerLanded } = summary;
  const headlineLabel = gateRunsPerLanded.windowSize === 0
    ? "no finished trains yet"
    : `${gateRunsPerLanded.gateRuns} run${gateRunsPerLanded.gateRuns === 1 ? "" : "s"} / ${gateRunsPerLanded.landedMembers} landed` +
      (gateRunsPerLanded.ratio != null ? ` (${gateRunsPerLanded.ratio.toFixed(1)}x)` : "");

  return { aboardLabel, lastGateLabel, headlineLabel };
}

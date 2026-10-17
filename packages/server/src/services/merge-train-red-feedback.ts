/**
 * A red merge train goes back to its members' builders (#1298; the single-workspace gate is #1293,
 * `gate-red-feedback.ts`).
 *
 * Two shapes, both sending the SAME one-turn feedback (cap, prompt, infra-class exclusion all live
 * in `sendGateRedFeedback`):
 *  - a member the bisect or the suite-owner shortcut rejected, with the suites that rejected it;
 *  - under `agent-fix`, a whole train that stayed red after the fix agent: the failing suites are
 *    attributed to the members that touched them (the suite-owner idea, but any number of owners),
 *    and when no member did, EVERY member gets the full failure.
 *
 * This never merges and never changes a member's readiness: it only talks to the builder.
 */
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { sendGateRedFeedback } from "./gate-red-feedback.js";
import type { TrainMember } from "./merge-train-assembly.js";
import type { TrainRunResult } from "./merge-train.service.js";

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
/** #1573: output shapes that mean the HOST failed, not any member's code. */
const ENVIRONMENT_SIGNATURES: readonly RegExp[] = [
  /\.git\/config[^\n]*Permission denied|Permission denied[^\n]*\.git\/config/i,
  /Test timed out in \d+ms|Hook timed out in \d+ms|\btimed out after \d+\s*(?:ms|s)\b/i,
];

function cleanOutput(output: string | undefined): string {
  return (output ?? "").replace(ANSI, "").replace(/\\/g, "/");
}

/** The slice of `output` that belongs to `suite`: from its first mention to the next other suite's. */
function suiteOutput(suite: string, others: readonly string[], output: string): string {
  const start = output.indexOf(suite);
  if (start < 0) return "";
  const ends = others.map((o) => output.indexOf(o, start + suite.length)).filter((i) => i > 0);
  return output.slice(start, ends.length > 0 ? Math.min(...ends) : undefined);
}

/** Pure: split failing suites into those whose output carries an environment signature and the rest. */
export function splitEnvironmentSuites(failedSuites: readonly string[], output: string | undefined): { environment: string[]; owned: string[] } {
  const text = cleanOutput(output);
  const environment: string[] = [];
  const owned: string[] = [];
  for (const suite of failedSuites) {
    const slice = suiteOutput(normalizePath(suite), failedSuites.filter((o) => o !== suite).map(normalizePath), text);
    (ENVIRONMENT_SIGNATURES.some((re) => re.test(slice)) ? environment : owned).push(suite);
  }
  return { environment, owned };
}

/**
 * Pure: which members a red train's failing suites implicate. A member owns a suite it changed, or
 * a file the failing output names (#1573: guard ratchets are never in a diff, but say who broke
 * them). Falls back to all of `members`.
 */
export function attributeTrainRedToMembers<M extends TrainMember>(failedSuites: readonly string[], members: readonly M[], output?: string): M[] {
  const suites = new Set(failedSuites.map(normalizePath).filter(Boolean));
  const text = cleanOutput(output);
  const owners = members.filter((m) => (m.changedFiles ?? []).some((f) => {
    const file = normalizePath(f);
    return suites.has(file) || (file.length > 0 && text.includes(file));
  }));
  return owners.length > 0 ? owners : [...members];
}

export interface TrainRedFeedbackTarget {
  member: TrainMember;
  failedSuites: readonly string[];
}

/** Pure: who gets a turn for this result. Empty when nothing is the builders' to fix. */
export function decideTrainRedFeedbackTargets(result: TrainRunResult, members: readonly TrainMember[]): TrainRedFeedbackTarget[] {
  const targets: TrainRedFeedbackTarget[] = [];
  const seen = new Set<string>();
  for (const r of result.gateRejected) {
    if (!r.failedSuites?.length || seen.has(r.member.workspaceId)) continue;
    seen.add(r.member.workspaceId);
    targets.push({ member: r.member, failedSuites: r.failedSuites });
  }
  // A final-red agent-fix train: nothing landed, nobody was individually rejected, suites named.
  if (result.redStrategy === "agent-fix" && result.landed.length === 0 && result.gateRejected.length === 0 && result.failedSuites?.length) {
    // #1573: environment failures have no owner; only the rest is the builders' to fix.
    const { owned } = splitEnvironmentSuites(result.failedSuites, result.gateFailure);
    if (owned.length === 0) return targets;
    const out = new Set([...result.dropped.map((d) => d.member.workspaceId), ...result.sided.map((s) => s.member.workspaceId)]);
    const aboard = members.filter((m) => !out.has(m.workspaceId));
    for (const member of attributeTrainRedToMembers(owned, aboard, result.gateFailure)) {
      if (seen.has(member.workspaceId)) continue;
      seen.add(member.workspaceId);
      targets.push({ member, failedSuites: owned });
    }
  }
  return targets;
}

/**
 * #1191: the member-vs-member conflict clusters are persisted in the train evidence; the
 * deterministic `group-scan` mode `train-conflicts` (`propose_ticket_groups`) reads them back as
 * candidate `coupled_with` groups — proposed, never auto-applied, since coupling two tickets is
 * an operator's call (decision 015). Moved here from `merge-queue-train.ts` (god-module ceiling).
 */
export function logTrainConflictClusters(label: string, result: Pick<TrainRunResult, "conflictClusters">): void {
  if (result.conflictClusters && result.conflictClusters.length > 0) {
    console.log(`[merge-train] ${label}: ${result.conflictClusters.length} member-vs-member conflict cluster(s) recorded — ` +
      `run propose_ticket_groups mode=train-conflicts to review them as candidate ticket groups`);
  }
}

/**
 * Send each target its one turn. Never throws. #1298: a bisected-out member, or every implicated
 * member of an agent-fix train that stayed red, gets the same one builder turn a single-workspace
 * gate red does (#1293).
 */
export async function sendTrainRedFeedback(
  result: TrainRunResult,
  members: readonly TrainMember[],
  deps: { sendTurn: (workspaceId: string, content: string) => Promise<unknown>; headSha: (branch: string) => Promise<string | null> },
): Promise<void> {
  if (result.redStrategy === "agent-fix" && result.failedSuites?.length) {
    const { environment } = splitEnvironmentSuites(result.failedSuites, result.gateFailure);
    if (environment.length > 0) console.log(`[merge-train] red train: no owner, environment: ${environment.join(", ")}`);
  }
  for (const { member, failedSuites } of decideTrainRedFeedbackTargets(result, members)) {
    try {
      const headSha = await deps.headSha(member.branch).catch(() => null);
      await sendGateRedFeedback(
        { workspaceId: member.workspaceId, headSha, failedSuites, guardFailure: false },
        { sendBuilderTurn: deps.sendTurn },
      );
    } catch (err) {
      console.warn(`[merge-train] red-train feedback for ${member.workspaceId} failed: ${errorMessage(err)}`);
    }
  }
}

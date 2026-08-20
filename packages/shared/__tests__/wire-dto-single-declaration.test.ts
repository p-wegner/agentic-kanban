// @gate:always-run — walks the client, server and mcp-server source trees; imports nothing it checks.
/**
 * A wire DTO is declared ONCE (#569).
 *
 * `packages/shared/src/types/api.ts` opens by calling itself "the hand-authored WIRE
 * CONTRACT". It was not: 90 type names existed in BOTH the client and a server package
 * and in neither case in shared, and the pairs had drifted in exactly the ways two
 * hand-maintained copies drift — `staleness` required on one side and optional on the
 * other, `PreflightVerdict` a precise template-literal union on one side and `string` on
 * the other, `IssueComment.kind` widened to `string` on both although the repository has
 * had a six-member union all along.
 *
 * This is a RATCHET, not a ban. The remaining pairs are grandfathered below and the list
 * may only SHRINK: moving one into `shared/src/types/api/` and deleting the copies is a
 * one-line edit here. A NEW duplicated name fails, which is the point — the drift was
 * never introduced deliberately, it accumulated one component at a time.
 *
 * A name that is genuinely local on both sides (a `Listener` in a client hook and an
 * unrelated `Listener` in a server service) belongs in GENUINELY_LOCAL, with a reason.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { walkPackageSources } from "./helpers/guard-scan.js";
import { fileURLToPath } from "node:url";

const packagesRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Same name on both sides, but two unrelated concepts — moving them would be wrong. */
const GENUINELY_LOCAL: Record<string, string> = {
  Listener: "a client SSE listener and a server port listener — unrelated concepts",
};

/**
 * Grandfathered duplicate declarations. MAY ONLY SHRINK.
 *
 * Batch 1 (#569) removed the agent-questions family, OrchestratorStatus, the scorecard
 * pair, IssueComment + IssueCommentKind and the preflight family: 75 -> 62.
 */
const GRANDFATHERED = new Set<string>([
  "ActivityEvent",
  "ActivityEventType",
  "AgentProvider",
  "ArtifactEntry",
  "BudgetEstimate",
  "BudgetRisk",
  "BurndownBucket",
  "ButlerCommand",
  "ButlerEvent",
  "ButlerQuestion",
  "ButlerQuestionAnswer",
  "ButlerQuestionOption",
  "ButlerSessionMessage",
  "ButlerSessionSummary",
  "CleanupWarningEntry",
  "CodemodFileDiff",
  "ContentionFile",
  "ContentionWorkspace",
  "DigestData",
  "DigestIssueRef",
  "DigestRange",
  "EnableReport",
  "FailurePattern",
  "FileContentionResult",
  "FocusData",
  "FocusIssue",
  "ImportResult",
  "InboxItem",
  "InsightsData",
  "InsightsRange",
  "LeadTimeBucket",
  "LoopAdvanceResult",
  "LoopStall",
  "MonitorCycleSummary",
  "PatternMatch",
  "ProjectActivityEvent",
  "ProjectActivityResult",
  "QuotaMetric",
  "QuotaProviderEntry",
  "QuotaUsageResult",
  "RepoMergeStatusEntry",
  "RiskLevel",
  "RiskSignal",
  "RunbookContent",
  "RunbookEntry",
  "SessionDigestEntry",
  "SlowRequestEntry",
  "SprintCapacityPlan",
  "SprintCapacityPolicy",
  "SprintEligibleIssue",
  "StaleWorktreeEntry",
  "StatusDuration",
  "TimeEntry",
  "TimeReportByDay",
  "TimeReportByIssue",
  "TimeReportData",
  "TouchedFile",
  "VoiceCaptureResult",
  "WorkerRow",
  "WorkspaceRiskEntry",
  "WorkspaceRiskResponse",
]);

function declaredTypeNames(pkg: string, exportedOnly: boolean): Set<string> {
  const base = path.join(packagesRoot, pkg, "src");
  const found = new Set<string>();
  if (!fs.existsSync(base)) return found;
  const pattern = exportedOnly
    ? /^export (?:interface|type) (\w+)/gm
    : /^(?:export )?(?:interface|type) (\w+)/gm;
  // #583 — the tree walk every guard suite needs, from the one shared helper.
  for (const full of walkPackageSources(base)) {
    for (const m of fs.readFileSync(full, "utf-8").matchAll(pattern)) found.add(m[1]);
  }
  return found;
}

describe("wire DTOs are declared once (#569)", () => {
  const client = declaredTypeNames("client", false);
  const server = declaredTypeNames("server", true);
  const mcp = declaredTypeNames("mcp-server", true);
  const shared = declaredTypeNames("shared", true);

  const duplicated = [...client]
    .filter((n) => (server.has(n) || mcp.has(n)) && !shared.has(n))
    .filter((n) => !(n in GENUINELY_LOCAL))
    .sort();

  it("no NEW type name is declared in both the client and a server package", () => {
    const fresh = duplicated.filter((n) => !GRANDFATHERED.has(n));
    const why = [
      "These names are declared in the client AND in server/ or mcp-server/, but not in shared.",
      "Two hand-maintained copies of one wire shape drift - that is what this guard exists to stop.",
      "Move the type into packages/shared/src/types/api/ and import it on both sides, or add it",
      "to GENUINELY_LOCAL with the reason it is not the same concept:",
    ].join(" ");
    expect(fresh, why).toEqual([]);
  });

  it("the grandfathered list only shrinks - remove entries as they are moved", () => {
    const stale = [...GRANDFATHERED].filter((n) => !duplicated.includes(n)).sort();
    const why = [
      "These are listed as grandfathered duplicates but are no longer duplicated.",
      "Delete them from GRANDFATHERED so the ratchet keeps its teeth:",
    ].join(" ");
    expect(stale, why).toEqual([]);
  });
});

// Text rendering for a placement explanation (#755).
//
// Separate from `services/placement-explain.service.ts` on purpose: that module
// imports the database, and `cli/commands/worker.ts` — which needs this renderer —
// is also the entry point of the STANDALONE worker binary, which "never opens or
// creates a database" (docs/worker-fleet.md §3). A type-only import is erased at
// build time, so the CLI gets the formatting without the db graph.
import type {
  IssuePlacementReport,
  PlacementCheckOutcome,
} from "../services/placement-explain.service.js";

const OUTCOME_MARKS: Record<PlacementCheckOutcome, string> = {
  pass: "ok  ",
  decided: "STOP",
  skipped: "skip",
  "not-reached": "  - ",
};

/** Human-readable rendering, shared by the CLI and the MCP tool. */
export function renderPlacementExplanation(report: IssuePlacementReport): string {
  const { issue, explanation: e } = report;
  const lines: string[] = [`#${issue.issueNumber} ${issue.title}`, "", e.summary];
  if (!e.agreesWithResolver) {
    lines.push(
      "",
      `  !! This explanation DISAGREES with resolveWorkerPlacement (chain says ${e.predicted.kind}, ` +
        `resolver says ${e.actual.kind}). The resolver is the truth — the chain in ` +
        `placement-explain.service.ts is stale and must be fixed.`,
    );
  }
  lines.push(
    "",
    `  provider=${e.provider} strict=${e.strict} branch=${e.branch ?? "(none)"} (${e.branchSource})`,
    `  fleet: ${e.fleet.registered} registered / ${e.fleet.online} online / ${e.fleet.connected} connected / ` +
      `${e.fleet.eligible} eligible / ${e.fleet.freeSlots} free slot(s)`,
    "",
    "  Decision chain (the order resolveWorkerPlacement applies it):",
  );
  for (const c of e.chain) {
    lines.push(`   ${OUTCOME_MARKS[c.outcome]} ${c.docStep}. ${c.title}`, `        ${c.detail}`);
    if (c.outcome === "decided" && c.prefKeys.length > 0) lines.push(`        change: ${c.prefKeys.join(", ")}`);
  }
  if (report.sessions.length > 0) {
    lines.push("", "  Sessions so far (where each one actually ran):");
    for (const s of report.sessions) {
      const where = s.placement === "remote" ? `worker ${s.workerName ?? `${s.workerId} (revoked)`}` : "board host";
      lines.push(`   - ${s.startedAt} ${s.executor} [${s.status}] on ${where}`);
    }
  }
  return lines.join("\n");
}

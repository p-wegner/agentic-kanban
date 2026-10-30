import type { CheckStatus, DoctorReport } from "./worker-doctor.js";

const ICONS: Record<CheckStatus, string> = { pass: "PASS", fail: "FAIL", skip: "SKIP", unknown: "UNKN", warn: "WARN" };

/** Human-readable report. Deliberately plain text — this gets pasted into an issue. */
export function renderDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(
    report.side === "worker"
      ? `Worker-side self-test against ${report.boardUrl}`
      : `Board-side fleet check at ${report.boardUrl}`,
  );
  lines.push("");
  for (const c of report.checks) {
    lines.push(`  [${ICONS[c.status]}] ${c.name}: ${c.detail}`);
    if (c.remedy && c.status !== "pass") lines.push(`         -> ${c.remedy}`);
  }
  lines.push("");
  const warned = report.checks.filter((c) => c.status === "warn").length;
  const failed = report.checks.filter((c) => c.status === "fail").length;
  const unknown = report.checks.filter((c) => c.status === "unknown").length;
  lines.push(
    failed === 0
      ? `All ${report.checks.length} checks passed or were skipped${unknown > 0 ? ` (${unknown} indeterminate - see above)` : ""}${warned > 0 ? ` (${warned} warning(s) - see above)` : ""}.`
      : `${failed} check(s) failed.`,
  );
  if (report.side === "worker") {
    lines.push(
      "This half cannot see how the board views this machine - the owner routes are loopback-only " +
        "(`agentic-kanban-worker setup --guide`, section 1). Run `agentic-kanban worker doctor-board` on the board for that half.",
    );
  }
  return lines.join("\n");
}

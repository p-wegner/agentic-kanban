// Pure parse / validate / format helpers for the `issue create-batch` command,
// extracted so the JSON-shape normalization, input validation, and result
// rendering are unit-testable without a database. The handler keeps the I/O
// (file read, the create transaction) and maps these results to
// console.error/console.log + process.exit.

import { formatResolvedProjectLine } from "./issue-cli-format.js";

export interface BatchIssueInput {
  title: string;
  description?: string;
  priority?: "low" | "medium" | "high" | "critical";
  issueType?: string;
  estimate?: string | null;
  sortOrder?: number;
  statusName?: string;
  tags?: string[];
}

export interface BatchDependencyInput {
  issueIndex: number;
  dependsOnIndex: number;
  type?: string;
}

/**
 * Normalize the parsed JSON into { issueInputs, dependencyInputs }. Accepts either
 * a bare array of issues or an object with an `issues` array (+ optional
 * `dependencies`). Returns the original error string otherwise.
 */
export function normalizeBatchInput(
  parsed: unknown,
): { ok: true; issueInputs: BatchIssueInput[]; dependencyInputs: BatchDependencyInput[] } | { ok: false; error: string } {
  if (Array.isArray(parsed)) {
    return { ok: true, issueInputs: parsed as BatchIssueInput[], dependencyInputs: [] };
  }
  if (parsed && typeof parsed === "object" && "issues" in parsed && Array.isArray((parsed).issues)) {
    const p = parsed as { issues: BatchIssueInput[]; dependencies?: BatchDependencyInput[] };
    return { ok: true, issueInputs: p.issues, dependencyInputs: p.dependencies ?? [] };
  }
  return { ok: false, error: "JSON must be an array of issues or an object with an 'issues' array." };
}

/**
 * Validate issue inputs against the project's status names, returning the first
 * violation message (matching the handler's `issues[i].*` strings) or null. Order
 * preserved: title-required before statusName-valid.
 */
export function validateBatchIssueInputs(issueInputs: BatchIssueInput[], statusNames: string[]): string | null {
  for (let i = 0; i < issueInputs.length; i++) {
    if (!issueInputs[i].title?.trim()) {
      return `issues[${i}].title is required.`;
    }
    if (issueInputs[i].statusName && !statusNames.includes(issueInputs[i].statusName!)) {
      return `issues[${i}].statusName '${issueInputs[i].statusName}' not found. Available: ${statusNames.join(", ")}`;
    }
  }
  return null;
}

/**
 * Build the `create-batch` output lines (JSON blob, or the Created summary + per-issue lines).
 *
 * `project` is optional only for back-compat with the pure formatter tests; the CLI
 * always passes it, because the project was resolved from the implicit global active
 * project and a bulk write is the most expensive thing to mis-file (#335).
 */
export function formatBatchCreateResult(
  created: Array<{ id: string; issueNumber: number; title: string }>,
  dependenciesCreated: number,
  json: boolean,
  project?: { id: string; name: string | null },
): string[] {
  const result = project
    ? { issues: created, dependenciesCreated, projectId: project.id, projectName: project.name }
    : { issues: created, dependenciesCreated };
  if (json) return [JSON.stringify(result, null, 2)];
  const lines = [
    `Created ${created.length} issue(s)${dependenciesCreated > 0 ? ` with ${dependenciesCreated} dependency edge(s)` : ""}.`,
  ];
  for (const c of created) {
    lines.push(`  #${c.issueNumber} ${c.title} (${c.id})`);
  }
  if (project) lines.push(formatResolvedProjectLine(project.id, project.name));
  return lines;
}

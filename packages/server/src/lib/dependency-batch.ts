// Pure validation + formatting for the `issue dependency update-batch` command,
// extracted so the per-edge validation rules and the result rendering are
// unit-testable without a database. The handler keeps the I/O (file read, the
// transaction) and maps these results to console.error/console.log + process.exit.

export interface BatchEdgeInput {
  issueId?: string;
  dependsOnId?: string;
  type?: string;
  action?: string;
}

/**
 * Validate a batch of dependency-edge operations, returning the first violation's
 * full message (matching the handler's `edges[i]: ...` strings) or null if all
 * edges are well-formed. Order of checks (required fields -> action -> type ->
 * self-edge) is preserved so the surfaced error matches the original handler.
 */
export function validateBatchEdges(edges: BatchEdgeInput[], validTypes: readonly string[]): string | null {
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    if (!e.issueId || !e.dependsOnId || !e.action) {
      return `edges[${i}]: missing required fields (issueId, dependsOnId, action).`;
    }
    if (!["add", "remove"].includes(e.action)) {
      return `edges[${i}]: action must be 'add' or 'remove'.`;
    }
    if (e.type && !validTypes.includes(e.type)) {
      return `edges[${i}]: invalid type '${e.type}'. Valid: ${validTypes.join(", ")}`;
    }
    if (e.action === "add" && e.issueId === e.dependsOnId) {
      return `edges[${i}]: an issue cannot depend on itself.`;
    }
  }
  return null;
}

export interface BatchEdgeResult {
  added: number;
  removed: number;
  skipped: Array<{ edge: { issueId: string; dependsOnId: string }; reason: string }>;
}

/** Build the `update-batch` output lines (JSON blob, or the Added/Removed/Skipped summary). */
export function formatBatchEdgeResult(result: BatchEdgeResult, json: boolean): string[] {
  if (json) return [JSON.stringify(result, null, 2)];
  const lines = [`Added: ${result.added}, Removed: ${result.removed}, Skipped: ${result.skipped.length}`];
  for (const s of result.skipped) {
    lines.push(`  Skipped: ${s.edge.issueId} -> ${s.edge.dependsOnId} (${s.reason})`);
  }
  return lines;
}

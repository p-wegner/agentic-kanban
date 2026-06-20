// Pure signal helpers extracted from getWorkspaceRisk (workspace-risk.service.ts).
// Both were buried inside a DB-heavy function and therefore untestable; pulling
// them out gives the fragile bits — JSONL tool-use parsing and the O(n^2) file
// overlap count — a unit-test seam without a database.

/**
 * Count `ask_followup_question` tool_use blocks in one session's raw stdout.
 * The stream is JSONL; each line is parsed independently and non-JSON lines
 * (and any other shapes) are ignored, mirroring the agent stream's tolerance.
 */
export function countAskFollowupQuestions(data: string): number {
  let count = 0;
  for (const line of data.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (obj.type === "assistant") {
        const content = ((obj.message as { content?: unknown[] })?.content ?? []) as { type: string; name?: string }[];
        for (const block of content) {
          if (block.type === "tool_use" && block.name === "ask_followup_question") {
            count++;
          }
        }
      }
    } catch {
      /* ignore non-JSON lines */
    }
  }
  return count;
}

/**
 * For each workspace, count how many OTHER workspaces it shares at least one
 * changed file with. Symmetric pairwise overlap (a workspace contributes at most
 * 1 to another's count regardless of how many files overlap).
 */
export function computeFileOverlapCounts(filesByWs: Map<string, string[]>): Map<string, number> {
  const allWsFiles = [...filesByWs.entries()];
  const overlapCountByWs = new Map<string, number>();
  for (const [wsId, files] of allWsFiles) {
    const fileSet = new Set(files);
    let overlap = 0;
    for (const [otherWsId, otherFiles] of allWsFiles) {
      if (otherWsId === wsId) continue;
      for (const f of otherFiles) {
        if (fileSet.has(f)) {
          overlap++;
          break;
        }
      }
    }
    overlapCountByWs.set(wsId, overlap);
  }
  return overlapCountByWs;
}

/**
 * Pure builders for the parallel-fork join artifacts + prompts (issue #862).
 *
 * `consolidate` in workflow-fork.service.ts (CC 42) tangled several multi-way string
 * constructions — the WORKFLOW_FORK_ARTIFACTS.md document, its auto-merge summary, the
 * per-mode "header job" line, and the join agent's "what to do" line — with its DB/git
 * I/O orchestration, so the prompt/artifact wording was untestable and inflated the
 * function's complexity. These are extracted here as pure functions (no I/O) so the exact
 * output is table-testable; the service keeps the orchestration and calls these for the text.
 *
 * Leaf module — imports nothing from services/repositories.
 */

/** One child branch's auto-merge outcome, as recorded by the join's merge pass. */
export interface ForkMergeResult {
  branch: string;
  status: "merged" | "conflict" | "skipped";
  detail?: string;
}

/**
 * The "## Auto-merge results" block for the artifacts doc. Empty unless the join
 * strategy is "merge" (manual-consolidation joins record no auto-merge).
 */
export function buildForkMergeSummary(joinStrategy: string, mergeResults: ForkMergeResult[]): string {
  const unmerged = mergeResults.filter((r) => r.status === "conflict");
  return joinStrategy === "merge"
    ? `## Auto-merge results\n\n` +
        mergeResults.map((r) => `- \`${r.branch}\`: **${r.status}**${r.detail ? ` — ${r.detail}` : ""}`).join("\n") +
        `\n\n` +
        (unmerged.length === 0
          ? `All branches were merged into this branch automatically. Review the combined result for coherence; the per-branch diffs below are for reference.\n\n`
          : `${unmerged.length} branch(es) did NOT merge cleanly (the conflicting merge was auto-aborted; that work remains only on its own branch). Integrate them manually using the diffs below.\n\n`)
    : "";
}

/** The header sentence describing the join agent's task at the join node, by fork mode. */
export function buildForkHeaderJob(
  sharedWorktree: boolean,
  joinStrategy: string,
  childrenCount: number,
  joinNodeName: string,
): string {
  return sharedWorktree
    ? `${childrenCount} fork stage(s) ran sequentially on this shared branch; all their work is already committed here. Your job at this **${joinNodeName}** stage: verify the combined result is coherent, then advance the workflow.`
    : joinStrategy === "merge"
    ? `${childrenCount} parallel branch(es) completed and were auto-merged into this branch. Your job at this **${joinNodeName}** stage: verify the combined result is coherent, integrate any branches that failed to merge (listed above), then advance the workflow.`
    : `${childrenCount} parallel branch(es) completed. Your job at this **${joinNodeName}** stage: review each branch's diff below, consolidate them into a single coherent result on this (parent) branch, resolve any overlaps, and then advance the workflow.`;
}

/** The full WORKFLOW_FORK_ARTIFACTS.md document the join agent reads. */
export function buildForkArtifactsDoc(params: {
  issueNumber: number | null;
  issueTitle: string;
  joinNodeName: string;
  childrenCount: number;
  joinStrategy: string;
  sharedWorktree: boolean;
  mergeResults: ForkMergeResult[];
  sections: string[];
}): string {
  const { issueNumber, issueTitle, joinNodeName, childrenCount, joinStrategy, sharedWorktree, mergeResults, sections } = params;
  const headerJob = buildForkHeaderJob(sharedWorktree, joinStrategy, childrenCount, joinNodeName);
  const mergeSummary = buildForkMergeSummary(joinStrategy, mergeResults);
  return (
    `# Parallel fork artifacts\n\n` +
    `Issue #${issueNumber ?? "?"} — "${issueTitle}"\n\n` +
    `${headerJob}\n\n` +
    mergeSummary +
    sections.join("\n\n---\n\n")
  );
}

/** The join agent's per-mode "what to do" line embedded in its launch prompt. */
export function buildJoinConsolidateLine(sharedWorktree: boolean, joinStrategy: string, unmergedCount: number): string {
  return sharedWorktree
    ? `The fork stages ran sequentially on this branch, so all their work is already committed here. Verify the combined result is coherent, then advance the workflow.`
    : joinStrategy === "merge"
    ? `The parallel branches have already been auto-merged into this branch. Verify the combined result is coherent${unmergedCount ? `, integrate the ${unmergedCount} branch(es) that failed to merge (see the artifacts)` : ""}, then advance the workflow.`
    : `Consolidate the branches into a single coherent result on this branch, then advance the workflow.`;
}

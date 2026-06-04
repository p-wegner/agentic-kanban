import { desc, sql } from "drizzle-orm";
import { agentSkills } from "@agentic-kanban/shared/schema";
import type { Database } from "../db/index.js";
import type { MergeQueuePlan } from "./merge-queue.service.js";
import { MERGE_RECONCILER_PROMPT } from "./merge-reconciler-prompt.js";

export interface ReconcilerPromptContext {
  baseBranch: string;
  projectId: string;
  serverPort: string;
  integrationWorkspaceId: string;
  integrationWorkingDir: string;
  /** The stranded batch, already JSON-stringified (see {@link buildStrandedBatch}). */
  strandedBatch: string;
}

/**
 * Build the prompt for the batch merge-reconciler agent. Mirrors {@link buildReviewPrompt}:
 * a project-scoped `merge-reconciler` agent_skills row overrides the bundled default
 * ({@link MERGE_RECONCILER_PROMPT}); placeholders are then substituted. Uses replacement
 * FUNCTIONS so a `$` in the injected JSON is never interpreted as a String.replace token.
 */
export async function buildReconcilerPrompt(
  database: Database,
  ctx: ReconcilerPromptContext,
): Promise<string> {
  let template = MERGE_RECONCILER_PROMPT;
  if (ctx.projectId) {
    const row = await database
      .select({ prompt: agentSkills.prompt })
      .from(agentSkills)
      .where(sql`${agentSkills.name} = 'merge-reconciler' AND (${agentSkills.projectId} = ${ctx.projectId} OR ${agentSkills.projectId} IS NULL)`)
      .orderBy(desc(agentSkills.projectId))
      .limit(1);
    if (row[0]?.prompt) template = row[0].prompt;
  }

  const subs: Record<string, string> = {
    baseBranch: ctx.baseBranch,
    projectId: ctx.projectId,
    serverPort: ctx.serverPort,
    integrationWorkspaceId: ctx.integrationWorkspaceId,
    integrationWorkingDir: ctx.integrationWorkingDir,
    strandedBatch: ctx.strandedBatch,
  };
  let out = template;
  for (const [key, value] of Object.entries(subs)) {
    out = out.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), () => value);
  }
  return out;
}

/**
 * Build the stranded-batch payload the reconciler agent reasons over, from the
 * {@link MergeQueuePlan} already computed by the orchestrator, filtered to the
 * workspaces the merge queue could not land this cycle. Trust-the-batch ground truth:
 * landing order (least file-overlap first), pairwise overlaps, migration collisions,
 * and the read-only conflict previews.
 */
export function buildStrandedBatch(
  strandedIds: string[],
  plan: MergeQueuePlan,
  opts: { baseBranch: string; projectId: string },
): {
  baseBranch: string;
  projectId: string;
  order: Array<Record<string, unknown>>;
  overlaps: MergeQueuePlan["overlaps"];
  totalOverlapScore: number;
  migrationCollisions: MergeQueuePlan["migrationCollisions"];
  conflictPreviews: MergeQueuePlan["conflictPreviews"];
} {
  const idSet = new Set(strandedIds);
  const order = plan.order
    .filter((w) => idSet.has(w.id))
    .map((w) => ({
      workspaceId: w.id,
      issueId: w.issueId,
      issueNumber: w.issueNumber,
      issueTitle: w.issueTitle,
      branch: w.branch,
      workingDir: w.workingDir,
      baseBranch: w.baseBranch,
      repoPath: w.repoPath,
      isDirect: w.isDirect,
      status: w.status,
      changedFiles: w.changedFiles,
    }));
  const overlaps = plan.overlaps.filter(
    (o) => idSet.has(o.workspaceIdA) && idSet.has(o.workspaceIdB) && o.overlapCount > 0,
  );
  const migrationCollisions = plan.migrationCollisions
    .map((m) => ({ ...m, workspaces: m.workspaces.filter((w) => idSet.has(w.workspaceId)) }))
    .filter((m) => m.workspaces.length > 1);
  const conflictPreviews = plan.conflictPreviews.filter((c) => idSet.has(c.workspaceId));
  const totalOverlapScore = overlaps.reduce((sum, o) => sum + o.overlapCount, 0);
  return { baseBranch: opts.baseBranch, projectId: opts.projectId, order, overlaps, totalOverlapScore, migrationCollisions, conflictPreviews };
}

/**
 * Pick the integration workspace for a reconcile run: the least-overlap (plan.order is
 * already sorted least-overlap-first) stranded member that has a real worktree (not a
 * direct/main-checkout workspace, where running git would be unsafe).
 */
export function pickIntegrationWorkspace(
  strandedIds: string[],
  plan: MergeQueuePlan,
): MergeQueuePlan["order"][number] | null {
  const idSet = new Set(strandedIds);
  return plan.order.find((w) => idSet.has(w.id) && !w.isDirect && !!w.workingDir) ?? null;
}

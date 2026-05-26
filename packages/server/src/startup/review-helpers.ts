import { db } from "../db/index.js";
import {
  buildReviewPrompt as _buildReviewPrompt,
  buildMonitorNudgePrompt as _buildMonitorNudgePrompt,
} from "../services/review.service.js";

// Re-export pure helpers and constants from the service layer
export {
  DEFAULT_MONITOR_NUDGE_PROMPT,
  DEFAULT_REVIEW_PROMPT,
  buildReviewArgs,
  parseProviderPref,
  getEffectiveProfile,
} from "../services/review.service.js";

// Backward-compat wrappers that inject `db` so existing callers (exit-workflow, monitor-setup)
// don't need to be changed. New call sites should use services/review.service.ts directly.

export async function buildReviewPrompt(
  branch: string,
  baseBranch: string | null,
  issueId: string,
  autoFix: boolean,
  projectId?: string,
  conflictingFiles?: string[],
  uncommittedChanges?: string[],
  workspaceId?: string,
  skillName = "code-review",
  verifyAgent?: string,
): Promise<{ prompt: string; model: string | null }> {
  return _buildReviewPrompt(db, branch, baseBranch, issueId, autoFix, projectId, conflictingFiles, uncommittedChanges, workspaceId, skillName, verifyAgent);
}

export async function buildMonitorNudgePrompt(projectId: string): Promise<string> {
  return _buildMonitorNudgePrompt(db, projectId);
}

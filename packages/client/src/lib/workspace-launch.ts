// Pure request-body builder for workspace quick-launch.
//
// Extracted from WorkspacePanel's handleQuickLaunch / handleSkillQuickLaunch,
// which built the POST /api/workspaces body with near-identical inline logic.
// Pure + unit-tested (repo convention) and dedupes the two call sites.

import { profileSelectionFromValue, resolveQuickLaunchDefault } from "./workspace-helpers.js";

export interface QuickLaunchInput {
  issueId: string;
  requiresReview: boolean;
  planMode: boolean;
  /** Suggested branch name. */
  branch: string;
  /** The profile dropdown value ("Default", "claude:anth", …). */
  selectedProfile: string;
  /** Preferences blob, used to resolve the global default when "Default" is picked. */
  prefs: Record<string, string>;
  /** Whether to include the model id (true for claude/codex quick-launch). */
  includeModel: boolean;
  model: string;
  /** Present for skill quick-launch. */
  skillId?: string;
}

/**
 * Build the POST /api/workspaces body for a quick-launch. Resolves the chosen
 * profile (or the global default when "Default" is selected) so the label the
 * user saw matches what actually runs.
 */
export function buildQuickLaunchBody(input: QuickLaunchInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    issueId: input.issueId,
    isDirect: false,
    requiresReview: input.requiresReview,
    planMode: input.planMode,
    branch: input.branch,
  };
  if (input.skillId) body.skillId = input.skillId;

  const profile = profileSelectionFromValue(input.selectedProfile);
  if (profile) {
    body.profile = profile;
  } else {
    const resolved = resolveQuickLaunchDefault(input.prefs);
    if (resolved) body.profile = resolved;
  }

  if (input.includeModel && input.model) body.model = input.model;
  return body;
}

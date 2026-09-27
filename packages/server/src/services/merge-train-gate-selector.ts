import { existsSync } from "node:fs";
import { join } from "node:path";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import type { Database } from "../db/index.js";
import { materializeGateSelectorArtifacts, type PluginSkillMaterialization } from "./workspace-provision.service.js";
import { IMPACT_TOOL_RELATIVE_PATH, TEST_IMPACT_SKILL_NAME } from "./test-impact-outcome.service.js";

/**
 * A merge train's staging worktree (the full train, each bisect half, the control arm) gets the
 * test-impact selector the same way a builder's worktree does: through
 * `materializeGateSelectorArtifacts`, the ONE road of #1039. MEASURED on the stable board
 * 2026-09-27: a train worktree carried 43 skills and no `test-impact`, so every impact-tier train
 * gate logged `[test:mine] impact selector failed to start (ENOENT)`, fell back to `vitest
 * related` and ran ~950 test files (30-60 min) instead of the budgeted selection.
 *
 * Best-effort and never throws: a gate without the selector still runs (wider, never wrong), and
 * the gate message then says `selector ABSENT (...)`. The log line here says the same thing at
 * the moment it happened, so the widening is never silent.
 */
export async function provisionTrainGateSelector(args: {
  database: Database;
  repoPath: string;
  projectId: string;
  worktreePath: string;
  attemptLabel: string;
  log?: (message: string) => void;
}): Promise<{ selectorPresent: boolean; materialization: PluginSkillMaterialization | null }> {
  const log = args.log ?? ((message: string) => console.warn(`[merge-train] ${message}`));
  let materialization: PluginSkillMaterialization | null = null;
  try {
    materialization = await materializeGateSelectorArtifacts(args.database, {
      worktreePath: args.worktreePath,
      repoPath: args.repoPath,
      projectId: args.projectId,
    });
  } catch (err) {
    log(`${args.attemptLabel}: selector ABSENT (plugin-skill materialization threw: ${errorMessage(err)}) - an impact-tier gate widens`);
  }
  const selectorPresent = existsSync(join(args.worktreePath, IMPACT_TOOL_RELATIVE_PATH));
  const missing = materialization?.missing.find((m) => m.skillName === TEST_IMPACT_SKILL_NAME);
  if (missing) {
    log(
      `${args.attemptLabel}: selector ABSENT (${IMPACT_TOOL_RELATIVE_PATH} is not in the staging worktree ` +
        `${args.worktreePath}: ${missing.reason}) - an impact-tier gate widens to vitest related`,
    );
  }
  return { selectorPresent, materialization };
}

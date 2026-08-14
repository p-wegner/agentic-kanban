import type { Database } from "../db/index.js";
import { listAgentSkills } from "../repositories/agent-skill.repository.js";
import { writeAgentSkillFile, isSkillsDirAbsentOrEmpty } from "@agentic-kanban/shared/lib/agent-skill-files";
import { isBuilderRelevantSkill } from "@agentic-kanban/shared/lib/builder-skill-policy";

/**
 * Seed a freshly registered project's `.claude/skills/` with the built-in skills.
 *
 * Extracted from `project.service.ts` (#388 needed a few lines there and the file was at its
 * god-module ceiling) — it is a self-contained concern with one caller and no shared state.
 *
 * Only exports into a repo whose skills dir is absent or empty, so it never overwrites a
 * project's own skills, and every failure is non-fatal: a skill that did not land is a missing
 * convenience, never a reason to fail a registration that has already created the project.
 *
 * #129 — only the skills a WORKTREE agent actually fires are exported. Every exported skill rides
 * into every worktree and pays an always-on name+description context tax per turn; board-side
 * skills (monitor, conductor, enhancer) run from their DB prompt against the main checkout and
 * would be pure tax here.
 */
export async function exportBuiltinSkillsToProject(repoPath: string, database: Database): Promise<void> {
  if (!(await isSkillsDirAbsentOrEmpty(repoPath))) return;
  try {
    const builtinSkills = await listAgentSkills(undefined, false, database);
    for (const skill of builtinSkills) {
      if (!isBuilderRelevantSkill(skill.name)) continue;
      // A name with a path separator would escape the skills dir; a built-in should never have
      // one, so this is a belt-and-braces refusal rather than an expected branch.
      if (skill.isBuiltin && !/[/\\]|\.\./.test(skill.name)) {
        await writeAgentSkillFile(repoPath, skill);
      }
    }
  } catch {
    // non-fatal — export failure must not block registration
  }
}

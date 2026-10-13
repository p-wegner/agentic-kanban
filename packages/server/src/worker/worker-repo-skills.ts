import { writeAgentSkillFile } from "@agentic-kanban/shared/lib/agent-skill-files";
import { gitExec } from "@agentic-kanban/shared/lib/git-exec";
import { execSucceeded } from "@agentic-kanban/shared/lib/exec-result";
import { workerLog } from "./worker-updater.js";

/**
 * #1467: write the board's skills into a fresh checkout WITHOUT overwriting a skill the repo
 * itself tracks. The board's built-in text of `code-review` etc. differs from the project's own
 * tracked copy, and a builder's `git add .claude/skills` committed the overwrite (8f9831bea).
 * A name whose directory holds tracked files is skipped - the project copy wins.
 */
export async function materializeRepoSkills(
  checkoutDir: string,
  skills: ReadonlyArray<{ name: string; description?: string; content: string }>,
  log: (line: string) => void = workerLog,
): Promise<{ written: string[]; skippedTracked: string[] }> {
  const written: string[] = [];
  const skippedTracked: string[] = [];
  for (const skill of skills) {
    const tracked = await gitExec(["ls-files", "--", `.claude/skills/${skill.name}`], { cwd: checkoutDir });
    if (execSucceeded(tracked) && tracked.stdout.trim().length > 0) {
      skippedTracked.push(skill.name);
      continue;
    }
    await writeAgentSkillFile(checkoutDir, {
      name: skill.name,
      description: skill.description ?? "",
      prompt: skill.content,
    });
    written.push(skill.name);
  }
  if (skippedTracked.length > 0) {
    log(`[worker] kept the repo's tracked copy of ${skippedTracked.length} skill(s) instead of the board's text: ${skippedTracked.join(", ")}`);
  }
  return { written, skippedTracked };
}

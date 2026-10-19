import { existsSync } from "node:fs";
import { join } from "node:path";
import { readModelHiddenSkills } from "../lib/model-hidden-skills.js";
import { listLocalSkillNamesSync, localSkillFilePath } from "@agentic-kanban/shared/lib/agent-skill-files";
import { resolveWorktreeDevPorts as resolveWorktreeDevPortsShared } from "./worktree-ports.js";

export function resolveWorktreeDevPorts(worktreePath: string): { serverPort: string; clientPort: string } | null {
  const ports = resolveWorktreeDevPortsShared(worktreePath);
  if (!ports) return null;
  return { serverPort: String(ports.serverPort), clientPort: String(ports.clientPort) };
}

/**
 * The SKILL.md files materialized into a worktree, for Pi's repeated `--skill` flags.
 *
 * Routed through `agent-skill-files` (#553): this used to be a private scan filtering on
 * `entry.isDirectory()` with its own name regex, and readdir reports a junction as a
 * SYMLINK, not a directory — so every PLUGIN skill (fanned out as a junction) was invisible
 * here and never reached the Pi launch, while sitting plainly on disk. `couldHoldSkill` +
 * `isSafeSkillName` already decide both questions, in one place, for every other reader.
 *
 * #1251 — a plugin skill listed `user-invocable-only`/`off` is excluded from this
 * MODEL-INITIATED auto-load list: it is still on disk (so an explicit `/name` invocation or
 * Claude's own slash-command discovery still works), it is just not force-fed into every
 * turn's context via `--skill`.
 */
export function materializedSkillFiles(worktreePath: string): string[] {
  // #1251: Pi has no "name-only" listing, so a skill the settings hide from the model is omitted.
  const hidden = readModelHiddenSkills(worktreePath);
  return listLocalSkillNamesSync(worktreePath)
    .filter((name) => !hidden.has(name))
    .map((name) => localSkillFilePath(worktreePath, name))
    .filter((skillPath) => existsSync(skillPath));
}

export function piExtensionFiles(worktreePath: string): string[] {
  const extensionPath = join(worktreePath, ".pi", "plugin", "agentic-kanban-hooks.ts");
  return existsSync(extensionPath) ? [extensionPath] : [];
}

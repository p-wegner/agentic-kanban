import { access, lstat, mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

export type AgentSkillFile = {
  name: string;
  description: string;
  prompt: string;
};

export async function writeAgentSkillFile(targetPath: string, skill: AgentSkillFile) {
  const skillsDir = join(targetPath, ".claude", "skills");
  const skillDir = join(skillsDir, skill.name);

  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), buildSkillMarkdown(skill), "utf-8");
  await ensureCodexSkillsLink(targetPath);

  return { skillsDir, skillDir };
}

export async function ensureCodexSkillsLink(targetPath: string) {
  const claudeSkillsDir = join(targetPath, ".claude", "skills");
  const codexDir = join(targetPath, ".codex");
  const codexSkillsDir = join(codexDir, "skills");

  await mkdir(claudeSkillsDir, { recursive: true });
  await mkdir(codexDir, { recursive: true });

  // Check if the path exists as a symlink (lstat doesn't follow symlinks)
  let existsAsSymlink = false;
  try {
    const stat = await lstat(codexSkillsDir);
    existsAsSymlink = stat.isSymbolicLink();
    if (!stat.isSymbolicLink()) {
      // Exists as a real directory — leave it alone
      return { codexSkillsDir, created: false };
    }
  } catch {
    // Path doesn't exist at all — fall through to create
  }

  if (existsAsSymlink) {
    // Symlink exists; check if its target is accessible
    try {
      await access(codexSkillsDir);
      return { codexSkillsDir, created: false };
    } catch {
      // Broken symlink — remove it so we can recreate
      await unlink(codexSkillsDir);
    }
  }

  const relativeTarget = relative(codexDir, claudeSkillsDir) || ".";
  const target = process.platform === "win32" ? claudeSkillsDir : relativeTarget;
  const type = process.platform === "win32" ? "junction" : "dir";
  await symlink(target, codexSkillsDir, type);
  return { codexSkillsDir, created: true };
}

/** Path to the installed SKILL.md for a skill inside a project repo. */
export function localSkillFilePath(repoPath: string, skillName: string): string {
  return join(repoPath, ".claude", "skills", skillName, "SKILL.md");
}

/**
 * Read the locally installed SKILL.md for a skill, if it exists.
 * Returns the prompt string (everything after the frontmatter `---` block), or null.
 */
export async function readLocalSkillPrompt(repoPath: string, skillName: string): Promise<string | null> {
  const filePath = localSkillFilePath(repoPath, skillName);
  try {
    const content = await readFile(filePath, "utf-8");
    // Strip frontmatter (--- ... ---\n)
    const match = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
    return match ? match[1].trim() : content.trim();
  } catch {
    return null;
  }
}

/** Returns true if the skill has a locally installed SKILL.md in the project repo. */
export async function isSkillInstalledLocally(repoPath: string, skillName: string): Promise<boolean> {
  try {
    await access(localSkillFilePath(repoPath, skillName));
    return true;
  } catch {
    return false;
  }
}

function buildSkillMarkdown(skill: AgentSkillFile) {
  return [
    "---",
    `name: ${skill.name}`,
    `description: ${skill.description}`,
    "---",
    "",
    skill.prompt,
  ].join("\n");
}

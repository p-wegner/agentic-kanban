import { access, lstat, mkdir, symlink, unlink, writeFile } from "node:fs/promises";
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

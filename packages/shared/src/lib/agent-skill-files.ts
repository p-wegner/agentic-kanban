import { access, mkdir, symlink, writeFile } from "node:fs/promises";
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

  try {
    await access(codexSkillsDir);
    return { codexSkillsDir, created: false };
  } catch {
    const relativeTarget = relative(codexDir, claudeSkillsDir) || ".";
    const target = process.platform === "win32" ? claudeSkillsDir : relativeTarget;
    const type = process.platform === "win32" ? "junction" : "dir";
    await symlink(target, codexSkillsDir, type);
    return { codexSkillsDir, created: true };
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

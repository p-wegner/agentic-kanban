import { access, lstat, mkdir, readFile, readdir, symlink, unlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

export type AgentSkillFile = {
  name: string;
  description: string;
  prompt: string;
};

export async function writeAgentSkillFile(targetPath: string, skill: AgentSkillFile) {
  if (/[/\\]/.test(skill.name) || skill.name === ".." || skill.name === ".") {
    throw new Error(`Invalid skill name for filesystem use: "${skill.name}"`);
  }
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

export type DiskSkillEntry = {
  name: string;
  description: string;
  model: string | null;
  prompt: string;
};

/**
 * Parse a SKILL.md file's frontmatter into a DiskSkillEntry.
 * Frontmatter fields recognised: name, description, model.
 * Everything after the closing `---` is the prompt.
 */
function parseDiskSkillMarkdown(content: string, fallbackName: string): DiskSkillEntry {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!frontmatterMatch) {
    return { name: fallbackName, description: "", model: null, prompt: content.trim() };
  }
  const front = frontmatterMatch[1];
  const prompt = frontmatterMatch[2].trim();
  const nameMatch = front.match(/^name:\s*(.+)$/m);
  const descMatch = front.match(/^description:\s*(.+)$/m);
  const modelMatch = front.match(/^model:\s*(.+)$/m);
  return {
    name: nameMatch?.[1].trim() || fallbackName,
    description: descMatch?.[1].trim() || "",
    model: modelMatch?.[1].trim() || null,
    prompt,
  };
}

/**
 * Scan .claude/skills/ inside a project repo and return every SKILL.md found.
 * Skills with invalid names (path traversal) are silently skipped.
 */
export async function scanLocalSkills(repoPath: string): Promise<DiskSkillEntry[]> {
  const skillsDir = join(repoPath, ".claude", "skills");
  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const skills: DiskSkillEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (/[/\\]/.test(entry.name) || entry.name === ".." || entry.name === ".") continue;
    try {
      const content = await readFile(join(skillsDir, entry.name, "SKILL.md"), "utf-8");
      skills.push(parseDiskSkillMarkdown(content, entry.name));
    } catch {
      // skip unreadable skill files
    }
  }
  return skills;
}

/**
 * Copy a SKILL.md verbatim from the project repo to the worktree.
 * Used when launching a disk-only skill that has no DB entry.
 */
export async function copySkillToWorktree(repoPath: string, skillName: string, worktreePath: string): Promise<boolean> {
  const src = localSkillFilePath(repoPath, skillName);
  const destDir = join(worktreePath, ".claude", "skills", skillName);
  try {
    const content = await readFile(src, "utf-8");
    await mkdir(destDir, { recursive: true });
    await writeFile(join(destDir, "SKILL.md"), content, "utf-8");
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

import { access, lstat, mkdir, readFile, readdir, symlink, unlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

export type AgentSkillFile = {
  name: string;
  description: string;
  prompt: string;
};

/**
 * Matches a leading YAML frontmatter block: group 1 = the fields, group 2 = the body.
 *
 * `\r?\n` is load-bearing, not defensive noise. This repo is Windows-first and its
 * checkouts are CRLF (`core.autocrlf=true`), so an LF-only `^---\n` never matched a
 * real SKILL.md on disk — and because a failed strip is indistinguishable from a file
 * with no frontmatter, callers silently got the WHOLE FILE back as the prompt. See #61.
 */
const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/;

/**
 * Remove every leading frontmatter block from `content`, returning the body.
 *
 * Loops because the corruption ratchets: a poisoned 2-block file that reaches the
 * default branch is read back on the next materialization, so one strip is not
 * enough to converge an already-stacked file. A `---` divider inside the body is
 * untouched — only blocks at the very top are stripped.
 */
function stripLeadingFrontmatter(content: string): string {
  let body = content;
  for (let match = body.match(FRONTMATTER_RE); match; match = body.match(FRONTMATTER_RE)) {
    body = match[2];
  }
  return body;
}

/**
 * A skill name is safe iff it can be used verbatim as a single filesystem
 * directory segment with no path-traversal or escape potential. This is the
 * single source of truth shared by the create-time guard (MCP
 * `create_agent_skill`) and every materialization/copy guard below — they must
 * never diverge (see ticket #931).
 *
 * Rejects: empty/whitespace-only, `/` or `\` separators, the `.` and `..`
 * directory aliases, embedded NUL, and Windows drive-relative names like `C:`.
 */
export function isSafeSkillName(name: unknown): name is string {
  if (typeof name !== "string") return false;
  if (name.trim().length === 0) return false;
  if (/[/\\]/.test(name)) return false;
  if (name === "." || name === "..") return false;
  if (name.includes("\0")) return false;
  // Windows drive-relative reference (e.g. "C:", "C:foo") resolves against the
  // drive's current dir, escaping the skills directory.
  if (/^[a-zA-Z]:/.test(name)) return false;
  return true;
}

export async function writeAgentSkillFile(targetPath: string, skill: AgentSkillFile) {
  if (!isSafeSkillName(skill.name)) {
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
    return stripLeadingFrontmatter(content).trim();
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
  const frontmatterMatch = content.match(FRONTMATTER_RE);
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
  const entries = await readdir(skillsDir, { withFileTypes: true }).catch(() => null);
  if (!entries) return [];
  const skills: DiskSkillEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!isSafeSkillName(entry.name)) continue;
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
  // Reject names that could escape the skills directory via path traversal
  if (!isSafeSkillName(skillName)) {
    return false;
  }
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

/**
 * Returns true when the .claude/skills directory does not exist OR is empty
 * (no subdirectories with a SKILL.md). Safe to export builtin skills only in
 * this case — any existing custom skill means we leave the directory alone.
 */
export async function isSkillsDirAbsentOrEmpty(repoPath: string): Promise<boolean> {
  const skillsDir = join(repoPath, ".claude", "skills");
  const entries = await readdir(skillsDir, { withFileTypes: true }).catch(() => null);
  if (!entries) return true;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      await access(join(skillsDir, entry.name, "SKILL.md"));
      return false;
    } catch {
      // no SKILL.md in this subdir — keep looking
    }
  }
  return true;
}

/**
 * Defense in depth: the prompt is stripped of any frontmatter it already carries
 * before a fresh block is prepended, so a poisoned prompt from ANY caller cannot
 * round-trip into a stacked second block. `resolveSkillFile` (workspace provisioning)
 * and `injectNodeSkill` (workflow fork) both hand us `readLocalSkillPrompt`'s output;
 * when that strip regressed, this function faithfully generated the corruption. The
 * generated block is authoritative — it comes from the DB row.
 */
function buildSkillMarkdown(skill: AgentSkillFile) {
  return [
    "---",
    `name: ${skill.name}`,
    `description: ${skill.description}`,
    "---",
    "",
    stripLeadingFrontmatter(skill.prompt).trim(),
  ].join("\n");
}

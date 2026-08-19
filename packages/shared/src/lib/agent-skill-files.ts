import { access, cp, lstat, mkdir, readFile, readdir, symlink, unlink, writeFile } from "node:fs/promises";
import { readdirSync as readdirSyncNode, type Dirent } from "node:fs";
import { join, relative } from "node:path";
import { errorMessage } from "./error-message.js";

/**
 * `<root>/.claude/skills` — the ONE derivation of the skills directory (#553).
 *
 * The join was re-derived in fourteen places across four packages, which is what let
 * three writers/scanners bypass this module's guards entirely (a private scan that
 * missed junctioned plugin skills, a `writeFileSync` with no name guard and no
 * frontmatter). Anything that reads or writes a materialized skill goes through these.
 */
export function skillsDirOf(root: string): string {
  return join(root, ".claude", "skills");
}

/** `<root>/.claude/skills/<name>` — the directory one materialized skill occupies. */
export function skillDirOf(root: string, skillName: string): string {
  return join(skillsDirOf(root), skillName);
}

/**
 * True for a directory entry that may hold a skill.
 *
 * `isDirectory()` alone is NOT enough: the plugin system installs a plugin's
 * skills into `.claude/skills/<name>` as a **junction/symlink** into the plugin
 * checkout (`plugin.service.ts` `fanOutSkills`), and `readdir(withFileTypes)`
 * does not follow links — such an entry reports `isSymbolicLink()`, not
 * `isDirectory()`. Scanning for directories only therefore made every plugin
 * skill invisible to the board (skill lists, butler slash-commands, the launch
 * path), while the same skill was plainly there on disk.
 */
function couldHoldSkill(entry: Dirent): boolean {
  return entry.isDirectory() || entry.isSymbolicLink();
}

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
 *
 * The blank line between stacked blocks must be consumed on each pass. `buildSkillMarkdown`
 * emits `---\n…\n---\n\n<prompt>`, but the regex only consumes the single newline that
 * terminates the closing `---`, so group 2 opens with the leftover newline of that blank
 * line. Without dropping it, `^---` fails on the second pass and the loop exits after one
 * block — silently leaving every stacked block in place.
 */
function stripLeadingFrontmatter(content: string): string {
  let body = content;
  for (let match = body.match(FRONTMATTER_RE); match; match = body.match(FRONTMATTER_RE)) {
    body = match[2].replace(/^[ \t]*\r?\n/, "");
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
    // `isSafeSkillName` is a type predicate, so inside this branch `skill.name` narrows to
    // `never` and the template had nothing to interpolate (restrict-template-expressions).
    // Read it off the unnarrowed value.
    throw new Error(`Invalid skill name for filesystem use: "${String((skill as { name: unknown }).name)}"`);
  }
  const skillsDir = skillsDirOf(targetPath);
  const skillDir = skillDirOf(targetPath, skill.name);

  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), buildSkillMarkdown(skill), "utf-8");
  await ensureCodexSkillsLink(targetPath);

  return { skillsDir, skillDir };
}

export async function ensureCodexSkillsLink(targetPath: string) {
  const claudeSkillsDir = skillsDirOf(targetPath);
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
  return join(skillDirOf(repoPath, skillName), "SKILL.md");
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
  const skillsDir = skillsDirOf(repoPath);
  const entries = await readdir(skillsDir, { withFileTypes: true }).catch(() => null);
  if (!entries) return [];
  const skills: DiskSkillEntry[] = [];
  for (const entry of entries) {
    if (!couldHoldSkill(entry)) continue;
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
 * Names of the skills materialized under `<path>/.claude/skills`, without
 * reading any SKILL.md body. Used on the launch path (#129) where we only need
 * to know WHICH skills a worktree has, not what they say — `scanLocalSkills`
 * would read and parse every file for nothing.
 */
export async function listLocalSkillNames(repoPath: string): Promise<string[]> {
  const skillsDir = skillsDirOf(repoPath);
  const entries = await readdir(skillsDir, { withFileTypes: true }).catch(() => null);
  if (!entries) return [];
  return entries
    .filter((entry) => couldHoldSkill(entry) && isSafeSkillName(entry.name))
    .map((entry) => entry.name);
}

/**
 * The synchronous twin of {@link listLocalSkillNames}, for the launch path, which
 * assembles its argv synchronously (#553). Same two rules — `couldHoldSkill` (a plugin
 * skill is a JUNCTION, which readdir reports as a symlink, never a directory) and
 * `isSafeSkillName` — because a second copy of them is exactly what made plugin skills
 * invisible to the Pi launcher while they sat plainly on disk.
 */
export function listLocalSkillNamesSync(repoPath: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSyncNode(skillsDirOf(repoPath), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => couldHoldSkill(entry) && isSafeSkillName(entry.name))
    .map((entry) => entry.name);
}

/**
 * Copy a disk-only skill from the project repo into a worktree.
 *
 * Copies the WHOLE skill directory, not just `SKILL.md`. A skill bundle routinely
 * carries the executables its own instructions tell the agent to run — plugin
 * skills like `ui-sdk` (`tools/ui-sdk.mjs`) or `requirement-grounding`
 * (`tools/ground.mjs`) are useless without them. Materializing the prose alone
 * produced a skill that documented commands which did not exist in the worktree,
 * and the agent's failure looked like a bad skill rather than a missing file.
 *
 * `dereference` matters on this path: the source may itself be a junction into a
 * plugin checkout (see `fanOutSkills`), and the worktree must end up with real
 * files, not a link back into a directory the agent may not be allowed to write.
 * `SKILL.md` is copied first and is the success criterion — a skill whose extra
 * assets fail to copy still launches (degraded), whereas a missing SKILL.md is a
 * genuine "skill not found".
 */
export async function copySkillToWorktree(repoPath: string, skillName: string, worktreePath: string): Promise<boolean> {
  // Reject names that could escape the skills directory via path traversal
  if (!isSafeSkillName(skillName)) {
    return false;
  }
  const srcDir = skillDirOf(repoPath, skillName);
  const destDir = skillDirOf(worktreePath, skillName);
  try {
    const content = await readFile(localSkillFilePath(repoPath, skillName), "utf-8");
    await mkdir(destDir, { recursive: true });
    await writeFile(join(destDir, "SKILL.md"), content, "utf-8");
  } catch {
    return false;
  }

  try {
    for (const entry of await readdir(srcDir, { withFileTypes: true })) {
      if (entry.name === "SKILL.md") continue;
      await cp(join(srcDir, entry.name), join(destDir, entry.name), {
        recursive: true,
        dereference: true,
        force: true,
      });
    }
  } catch (err) {
    console.warn(
      `[skills] copied SKILL.md for "${skillName}" but not its bundled assets: `
      + `${errorMessage(err)}`,
    );
  }
  return true;
}

/**
 * Returns true when the .claude/skills directory does not exist OR is empty
 * (no subdirectories with a SKILL.md). Safe to export builtin skills only in
 * this case — any existing custom skill means we leave the directory alone.
 */
export async function isSkillsDirAbsentOrEmpty(repoPath: string): Promise<boolean> {
  const skillsDir = skillsDirOf(repoPath);
  const entries = await readdir(skillsDir, { withFileTypes: true }).catch(() => null);
  if (!entries) return true;
  for (const entry of entries) {
    if (!couldHoldSkill(entry)) continue;
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
export function buildSkillMarkdown(skill: AgentSkillFile) {
  return [
    "---",
    `name: ${skill.name}`,
    `description: ${skill.description}`,
    "---",
    "",
    stripLeadingFrontmatter(skill.prompt).trim(),
  ].join("\n");
}

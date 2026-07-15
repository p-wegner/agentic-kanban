#!/usr/bin/env node
// Stop hook: detect a duplicated YAML frontmatter block in .claude/skills/*/SKILL.md.
//
// Recurring pattern observed across many agent sessions on this project: a skill's
// SKILL.md ends up with a second, redundant `---\nname: ...\ndescription: ...\n---`
// block stacked right after the first. The board's own materialization path
// (writeAgentSkillFile in agent-skill-files.ts) always overwrites the file cleanly
// with a single frontmatter block, so this is not a bug in that write path -- it
// happens mid-session, source unconfirmed. Every occurrence so far was caught
// manually by code review and reverted as out-of-scope, costing a review round-trip
// each time. This hook catches it BEFORE the agent stops so it gets fixed in the
// same session instead.
//
// Fires on both Claude (via direct Stop hook wiring) and Codex (via
// .codex/hooks.json direct Stop entry -- matching the check-conflict-markers
// pattern). On re-prompt (stop_hook_active=true) we let it through to avoid
// infinite loops.
//
// Checks committed (HEAD) content only, like check-conflict-markers.js --
// working-tree edits and staged-but-uncommitted changes are not flagged.

const { execFileSync } = require("child_process");
const readline = require("readline");

function getProjectDir() {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return process.env.CLAUDE_PROJECT_DIR || process.cwd();
  }
}

function listSkillMarkdownFiles(repoRoot) {
  try {
    const output = execFileSync(
      "git",
      ["ls-tree", "-r", "--name-only", "HEAD", "--", ".claude/skills/"],
      {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 10000,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      }
    );
    return output.split(/\r?\n/).filter((f) => f.endsWith("/SKILL.md"));
  } catch {
    // no .claude/skills/ tracked at HEAD, or git error -- nothing to check
    return [];
  }
}

function readAtHead(repoRoot, file) {
  try {
    return execFileSync("git", ["show", `HEAD:${file}`], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

// A well-formed SKILL.md has exactly two `---` fence lines (the frontmatter
// block) near the top. A duplicated block stacks a second fence pair right
// after the first, so 4+ fence lines within the file's opening lines is the
// signature -- a legitimate `---` markdown divider used far down in a long
// skill body falls outside this window and is not flagged.
const HEAD_WINDOW = 14;

function hasDuplicatedFrontmatter(content) {
  const lines = content.split(/\r?\n/).slice(0, HEAD_WINDOW);
  const fenceCount = lines.filter((l) => l.trim() === "---").length;
  return fenceCount >= 4;
}

function findDuplicatedFrontmatterFiles(repoRoot) {
  const findings = [];
  for (const file of listSkillMarkdownFiles(repoRoot)) {
    const content = readAtHead(repoRoot, file);
    if (content && hasDuplicatedFrontmatter(content)) findings.push(file);
  }
  return findings;
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin });
  const lines = [];
  for await (const line of rl) lines.push(line);
  let input = {};
  try {
    input = JSON.parse(lines.join(""));
  } catch {}

  // Loop safety: don't re-block on re-prompt (matches check-conflict-markers pattern).
  if (input.stop_hook_active === true) process.exit(0);

  const repoRoot = getProjectDir();
  const findings = findDuplicatedFrontmatterFiles(repoRoot);

  if (findings.length === 0) process.exit(0);

  const reason = [
    "[fatal] Duplicated YAML frontmatter block detected in a skill file:",
    "",
    ...findings.map((f) => `  ${f}`),
    "",
    "A second '---\\nname: ...\\ndescription: ...\\n---' block is stacked right after",
    "the first. This is a known recurring corruption pattern, unrelated to your",
    "ticket's scope -- revert the file to match master (e.g. `git checkout master --",
    "<file>`) and commit the fix before stopping.",
  ].join("\n");

  console.error(reason);
  console.log(JSON.stringify({ decision: "block", reason }));
  process.exit(1);
}

main().catch(() => process.exit(0));

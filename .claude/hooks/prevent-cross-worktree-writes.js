#!/usr/bin/env node
/**
 * Prevent cross-worktree writes — keep each Claude Code instance inside its own
 * git worktree.
 *
 * Runs as a PreToolUse hook on the structured file-writing tools (Write, Edit,
 * MultiEdit, NotebookEdit). It blocks any write whose target path lives inside a
 * *different* git worktree of the same repo than the one this instance is
 * operating in.
 *
 * Why: agents are launched in a dedicated worktree (cwd = worktree). When an
 * agent writes into the main checkout or a sibling worktree, that work lands
 * uncommitted in someone else's tree, blocks merges, and has corrupted the dev
 * DB (see issue #43 / docs/learnings/2026-05-27-...). This hook enforces the
 * invariant "stay in your own worktree".
 *
 * Scope / behaviour:
 *   - ALLOW writes inside the current worktree (CLAUDE_PROJECT_DIR / cwd's git toplevel).
 *   - ALLOW writes outside every worktree (e.g. %TEMP%, ~/.claude) — not our concern.
 *   - BLOCK writes inside any OTHER worktree of the same repo.
 *   - No-op when cwd isn't a git repo or the repo has a single worktree.
 *
 * Known gap: Bash/PowerShell file writes (redirects, cp/mv) are NOT covered here
 * — only the structured write tools, which are the primary and reliable vector.
 *
 * Override: set ALLOW_CROSS_WORKTREE_WRITE=1 (explicit, for the rare legit case).
 */

const path = require("path");
const readline = require("readline");
const { execFileSync } = require("child_process");

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** Normalise a path for case-insensitive, separator-insensitive comparison (Windows-friendly). */
function norm(p) {
  if (!p) return "";
  let r = path.resolve(p).replace(/\\/g, "/");
  // Drop a trailing slash (except root) and lowercase (Windows FS is case-insensitive).
  if (r.length > 1 && r.endsWith("/")) r = r.slice(0, -1);
  return r.toLowerCase();
}

/** True if `child` is inside (or equal to) `parent`, on a path boundary. */
function isInside(child, parent) {
  if (!child || !parent) return false;
  if (child === parent) return true;
  return child.startsWith(parent.endsWith("/") ? parent : parent + "/");
}

function gitToplevel(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim();
  } catch {
    return null;
  }
}

/** List all worktree root paths for the repo containing `cwd`. */
function listWorktrees(cwd) {
  try {
    const out = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    return out
      .split(/\r?\n/)
      .filter((l) => l.startsWith("worktree "))
      .map((l) => l.slice("worktree ".length).trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Extract the target file path(s) from a write-tool input. */
function targetPaths(toolInput) {
  if (!toolInput) return [];
  const p =
    toolInput.file_path ||
    toolInput.filePath ||
    toolInput.notebook_path ||
    toolInput.notebookPath ||
    toolInput.path;
  return p ? [p] : [];
}

async function readInput() {
  const rl = readline.createInterface({ input: process.stdin });
  const lines = [];
  for await (const line of rl) lines.push(line);
  try {
    return JSON.parse(lines.join(""));
  } catch {
    return null;
  }
}

function allow() {
  process.exit(0);
}

function block(reason) {
  process.stdout.write(JSON.stringify({ decision: "block", reason }) + "\n");
  process.exit(2);
}

async function main() {
  if (process.env.ALLOW_CROSS_WORKTREE_WRITE === "1") allow();

  const input = await readInput();
  if (!input) allow();

  const toolName = input.tool_name || input.toolName;
  if (!WRITE_TOOLS.has(toolName)) allow();

  const targets = targetPaths(input.tool_input || input.toolInput);
  if (targets.length === 0) allow();

  // The worktree this instance is operating in.
  const cwd = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const currentRoot = norm(gitToplevel(cwd) || cwd);
  const worktrees = listWorktrees(cwd).map(norm);
  if (worktrees.length <= 1) allow(); // single-worktree repo or not a repo → nothing to protect

  const others = worktrees.filter((w) => w !== currentRoot);

  for (const target of targets) {
    const t = norm(path.isAbsolute(target) ? target : path.join(cwd, target));
    // Writing inside our own worktree is always fine.
    if (isInside(t, currentRoot)) continue;
    // Writing inside a different worktree is the violation we guard against.
    const offending = others.find((w) => isInside(t, w));
    if (offending) {
      block(
        "⛔ Cross-worktree write blocked.\n\n" +
          `This Claude instance is operating in:\n  ${currentRoot}\n\n` +
          `but the write targets a DIFFERENT git worktree:\n  ${t}\n  (worktree: ${offending})\n\n` +
          "Each agent must stay inside its own worktree. Writing into another worktree\n" +
          "(or the main checkout) leaves work uncommitted in someone else's tree, blocks\n" +
          "merges, and has corrupted the dev DB (see issue #43).\n\n" +
          "Fix: write to a path inside your own worktree above. If you genuinely need to\n" +
          "edit another worktree, do it from an instance running there — or, for a rare\n" +
          "authorized case, set ALLOW_CROSS_WORKTREE_WRITE=1. Do NOT bypass by editing this hook."
      );
    }
    // Target is outside every worktree (temp, home, etc.) → not our concern.
  }

  allow();
}

main().catch(() => process.exit(0));

#!/usr/bin/env node
/**
 * PreToolUse hook: require-code-review-for-pr.js
 *
 * Blocks `gh pr create` commands unless a code review has been completed.
 * Checks for a marker file `.claude/.pr-review-done-<branch>` which is
 * created after running the /review or /security-review skill.
 *
 * Adapted from beyond-vibe-coding's PR gate pattern.
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const readline = require("readline");

function getProjectDir() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

function getCurrentBranch() {
  try {
    return execSync("git branch --show-current", {
      cwd: getProjectDir(),
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

function getMarkerPath(branch) {
  // Sanitize branch name for filename
  const safe = branch.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(getProjectDir(), ".claude", `.pr-review-done-${safe}`);
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin });
  const lines = [];
  for await (const line of rl) lines.push(line);

  let input = {};
  try {
    input = JSON.parse(lines.join(""));
  } catch {
    process.exit(0);
  }

  // Only intercept Bash tool calls
  const command = input.tool_input?.command || "";
  if (!/\bgh\s+pr\s+create\b/.test(command)) process.exit(0);

  const branch = getCurrentBranch();
  if (!branch) process.exit(0);

  const markerPath = getMarkerPath(branch);
  if (fs.existsSync(markerPath)) {
    // Review was done — clean up marker and allow
    fs.unlinkSync(markerPath);
    process.exit(0);
  }

  // Block — no review marker found
  process.stdout.write(
    JSON.stringify({
      decision: "block",
      reason: [
        "CODE REVIEW REQUIRED BEFORE PR CREATION",
        "",
        "Run a code review before creating a pull request:",
        "",
        "  /review          (general code review)",
        "  /security-review  (security-focused review)",
        "",
        "After the review is complete, the PR gate will open automatically.",
      ].join("\n"),
    }) + "\n"
  );
  process.exit(2);
}

main().catch(() => process.exit(0));

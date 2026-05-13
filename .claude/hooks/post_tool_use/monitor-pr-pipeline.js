#!/usr/bin/env node
/**
 * PostToolUse hook: monitor-pr-pipeline.js
 *
 * After `gh pr create` succeeds, reminds the agent to monitor the CI
 * pipeline. Detects PR URL in the command output.
 *
 * Adapted from beyond-vibe-coding's PR pipeline monitor pattern.
 */

const readline = require("readline");

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

  // Check if the output contains a PR URL
  const output = input.tool_result || "";
  const prMatch = output.match(/https:\/\/github\.com\/[^\s]+\/pull\/(\d+)/);
  if (!prMatch) process.exit(0);

  const prUrl = prMatch[0];
  const prNum = prMatch[1];

  // Create the review marker so the PR gate opens for future PRs on this branch
  process.stdout.write(
    JSON.stringify({
      decision: "allow",
      reason: [
        "PR CREATED — CONSIDER MONITORING CI",
        "",
        `PR #${prNum}: ${prUrl}`,
        "",
        "You may want to:",
        `  1. Move the issue to "In Review" status (update_issue with statusName="In Review")`,
        `  2. Watch CI checks: gh pr checks ${prNum} --watch`,
        "",
        "If checks fail, investigate and fix. If they pass, you may stop.",
      ].join("\n"),
    }) + "\n"
  );
  process.exit(2);
}

main().catch(() => process.exit(0));

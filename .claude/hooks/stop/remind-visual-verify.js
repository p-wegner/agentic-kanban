#!/usr/bin/env node
/**
 * Stop hook: remind-visual-verify.js
 *
 * When the agent is about to stop, checks if any client source files were
 * edited. If so, blocks and reminds the agent to visually verify changes
 * with the playwright-cli skill before finishing.
 *
 * Infinite-loop prevention: if stop_hook_active is true (Claude Code sets
 * this when continuing from a previous Stop hook block), exit 0 immediately.
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");

function getProjectDir() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

function loadState() {
  const p = path.join(getProjectDir(), ".claude", "hooks", ".edited-files.json");
  if (!fs.existsSync(p)) return { files: [] };
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return { files: [] };
  }
}

function hasClientEdits(files) {
  return files.some(
    (f) =>
      f.startsWith("packages/client/") &&
      /\.(tsx?|jsx?|css)$/.test(f),
  );
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

  // Already re-prompted once — let the agent stop
  if (input.stop_hook_active === true) process.exit(0);

  const state = loadState();

  // No client files edited — nothing to verify visually
  if (!hasClientEdits(state.files)) process.exit(0);

  // Client files were edited — block and remind
  const decision = {
    decision: "block",
    reason: [
      "VISUAL VERIFICATION REQUIRED",
      "",
      "Client source files were modified. Before stopping, verify your changes",
      "in the browser using the playwright-cli skill:",
      "",
      "  /playwright-cli",
      "",
      "Then:",
      "  1. Open http://localhost:5173",
      "  2. Take a snapshot to check the UI renders correctly",
      "  3. Screenshot only if debugging — clean up .png files after",
      "",
      "If the dev server is not running, start it with: pnpm dev",
      "Assume the server is running and only start it if navigation fails.",
      "",
      "After verification, you may stop.",
    ].join("\n"),
  };

  process.stdout.write(JSON.stringify(decision) + "\n");
  process.exit(2);
}

main().catch(() => process.exit(0));

#!/usr/bin/env node
/**
 * Stop hook: remind-visual-verify.js
 *
 * When the agent is about to stop, performs two checks:
 *
 * 1. STATE CHECK: Parses docs/state.md for the current stage checklist.
 *    If any `- [ ]` items remain unchecked, blocks and tells the agent
 *    to continue implementing the remaining items.
 *
 * 2. VISUAL VERIFY: If client source files were edited (tracked via
 *    PostToolUse hook), blocks and reminds the agent to visually verify
 *    changes with the playwright-cli skill.
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

function getStatePath() {
  return path.join(getProjectDir(), ".claude", "hooks", ".edited-files.json");
}

function loadEditState() {
  const p = getStatePath();
  if (!fs.existsSync(p)) return { files: [] };
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return { files: [] };
  }
}

function clearClientEdits(state) {
  const remaining = state.files.filter(
    (f) =>
      !(f.startsWith("packages/client/") && /\.(tsx?|jsx?|css)$/.test(f)),
  );
  fs.writeFileSync(getStatePath(), JSON.stringify({ files: remaining }, null, 2));
}

function hasClientEdits(files) {
  return files.some(
    (f) =>
      f.startsWith("packages/client/") &&
      /\.(tsx?|jsx?|css)$/.test(f),
  );
}

/**
 * Parse docs/state.md to find unchecked items in the current stage.
 * Returns { stageName, uncheckedItems: string[] }
 */
function getUncheckedStateItems() {
  const statePath = path.join(getProjectDir(), "docs", "state.md");
  if (!fs.existsSync(statePath)) return { stageName: null, uncheckedItems: [] };

  const content = fs.readFileSync(statePath, "utf8");
  const lines = content.split(/\r?\n/);

  // Find "## Current Stage:" line to get the stage name
  let stageName = null;
  let stageHeaderIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("## Current Stage:")) {
      stageName = lines[i].replace(/^## Current Stage:\s*/, "").trim();
      stageHeaderIdx = i;
      break;
    }
  }
  if (stageHeaderIdx === -1) return { stageName: null, uncheckedItems: [] };

  // If stage is already marked DONE, no unchecked items
  if (stageName.includes("(DONE)")) return { stageName, uncheckedItems: [] };

  // Find the corresponding "### Stage N Checklist" section
  // Extract stage number from header like "Stage 7 — ..."
  const stageMatch = stageName.match(/Stage\s+(\d+)/);
  if (!stageMatch) return { stageName, uncheckedItems: [] };
  const stageNum = stageMatch[1];

  let checklistStart = -1;
  for (let i = stageHeaderIdx + 1; i < lines.length; i++) {
    if (new RegExp(`^### Stage ${stageNum} Checklist`).test(lines[i])) {
      checklistStart = i;
      break;
    }
  }
  if (checklistStart === -1) return { stageName, uncheckedItems: [] };

  // Collect unchecked items until the next ### heading or end of file
  const uncheckedItems = [];
  for (let i = checklistStart + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("### ") || line.startsWith("## ")) break;
    // Match unchecked checkbox: "- [ ]"
    const uncheckedMatch = line.match(/^-\s+\[\s*\]\s+(.+)/);
    if (uncheckedMatch) {
      uncheckedItems.push(uncheckedMatch[1].trim());
    }
  }

  return { stageName, uncheckedItems };
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

  // --- CHECK 1: State checklist ---
  const { stageName, uncheckedItems } = getUncheckedStateItems();
  if (uncheckedItems.length > 0) {
    const itemLines = uncheckedItems.map((item) => `  - ${item}`).join("\n");
    const decision = {
      decision: "block",
      reason: [
        "STATE CHECKLIST INCOMPLETE",
        "",
        `Stage: ${stageName}`,
        `The following ${uncheckedItems.length} item(s) are unchecked in docs/state.md:`,
        "",
        itemLines,
        "",
        "Continue implementing the remaining items. Update docs/state.md as you",
        "complete each one. Only stop when all checklist items are checked off.",
      ].join("\n"),
    };
    process.stdout.write(JSON.stringify(decision) + "\n");
    process.exit(2);
  }

  // --- CHECK 2: Visual verification ---
  const editState = loadEditState();

  // No client files edited — nothing to verify visually
  if (!hasClientEdits(editState.files)) process.exit(0);

  // Client files were edited — block and remind
  // Clear client edits from state so the next stop attempt passes (prevents infinite loop)
  clearClientEdits(editState);

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

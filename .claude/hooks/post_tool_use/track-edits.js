#!/usr/bin/env node
/**
 * PostToolUse hook: track-edits.js
 *
 * After every Write/Edit tool call, records the edited file path to a state
 * file so the Stop hook can check whether client source files were modified.
 *
 * State file: .claude/hooks/.edited-files.json
 * Cleaned up by the Stop hook after it runs.
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

function loadState() {
  const p = getStatePath();
  if (!fs.existsSync(p)) return { files: [] };
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return { files: [] };
  }
}

function saveState(state) {
  const p = getStatePath();
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(state, null, 2));
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

  const filePath =
    input.tool_input?.file_path ||
    input.tool_input?.filePath ||
    null;

  if (!filePath) process.exit(0);

  const projectDir = getProjectDir();
  let rel = filePath;
  if (path.isAbsolute(filePath) && filePath.startsWith(projectDir)) {
    rel = path.relative(projectDir, filePath).replace(/\\/g, "/");
  }

  const state = loadState();
  if (!state.files.includes(rel)) {
    state.files.push(rel);
    saveState(state);
  }

  process.exit(0);
}

main().catch(() => process.exit(0));

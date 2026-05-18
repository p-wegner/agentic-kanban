#!/usr/bin/env node
/**
 * Smart Hooks Runner — config-driven hook runner for agentic-kanban.
 *
 * Adapted from the beyond-vibe-coding pattern. Reads checks from
 * smart-hooks-config.json instead of hardcoding per-hook logic.
 *
 * Usage:
 *   node smart-hooks-runner.js PostToolUse   (called after Write/Edit/MultiEdit)
 *   node smart-hooks-runner.js Stop          (called when agent stops)
 *
 * State file: .claude/hooks/.smart-hooks-state.json
 *   - Tracks edited files across PostToolUse calls
 *   - Cleared after Stop hooks run
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const readline = require("readline");

function getProjectDir() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

function getConfigPath() {
  return path.join(getProjectDir(), ".claude", "hooks", "smart-hooks-config.json");
}

function getStatePath() {
  return path.join(getProjectDir(), ".claude", "hooks", ".smart-hooks-state.json");
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
  } catch {
    return { hooks: {} };
  }
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(getStatePath(), "utf8"));
  } catch {
    return { editedFiles: [] };
  }
}

function saveState(state) {
  const p = getStatePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(state, null, 2));
}

function clearState() {
  const p = getStatePath();
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

function toRelative(filePath) {
  const projectDir = getProjectDir();
  if (path.isAbsolute(filePath) && filePath.startsWith(projectDir)) {
    return path.relative(projectDir, filePath).replace(/\\/g, "/");
  }
  return filePath.replace(/\\/g, "/");
}

function matchesPatterns(filePath, patterns) {
  if (!patterns || patterns.length === 0) return true;
  const normalized = filePath.replace(/\\/g, "/");
  return patterns.some((p) => {
    const re = p
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "{{GLOBSTAR}}")
      .replace(/\*/g, "[^/]*")
      .replace(/{{GLOBSTAR}}/g, ".*");
    return new RegExp(`^${re}$`).test(normalized);
  });
}

function runCheck(check) {
  const timeout = (check.timeout || 30) * 1000;
  try {
    execSync(check.command, {
      cwd: getProjectDir(),
      timeout,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    return { success: true, output: "" };
  } catch (err) {
    return {
      success: false,
      output: [err.stdout || "", err.stderr || ""].join("\n").trim(),
    };
  }
}

// --- PostToolUse: track edited files + run per-file checks ---

function handlePostToolUse(input) {
  const filePath = input.tool_input?.file_path || input.tool_input?.filePath || null;
  if (!filePath) return;

  const rel = toRelative(filePath);
  const state = loadState();
  if (!state.editedFiles.includes(rel)) {
    state.editedFiles.push(rel);
    saveState(state);
  }

  const config = loadConfig();
  const checks = config.hooks?.PostToolUse || [];

  for (const check of checks) {
    if (!check.enabled) continue;
    if (!matchesPatterns(rel, check.filePatterns)) continue;

    const command = check.command.replace(/\{file\}/g, rel);
    const result = runCheck({ ...check, command });

    if (!result.success) {
      console.error(`[smart-hooks] ${check.name}: FAILED`);
      if (result.output) console.error(result.output);
      if (check.blocking) {
        process.stdout.write(
          JSON.stringify({
            decision: "block",
            reason: `${check.name} failed:\n\n${result.output}\n\nFix the issue before continuing.`,
          }) + "\n"
        );
        process.exit(2);
      }
    }
  }
}

// --- Stop: run full checks (tests, tsc, reminders) ---

function handleStop(input) {
  const state = loadState();
  const config = loadConfig();
  const checks = config.hooks?.Stop || [];
  if (checks.length === 0) {
    clearState();
    process.exit(0);
  }

  const blockReasons = [];
  const alwaysRun = input.stop_hook_active !== true;
  // On re-prompt, only run hooks marked alwaysRun (e.g. cleanup reminders)
  // File-dependent hooks (tests, tsc, playwright) are skipped on re-prompt

  for (const check of checks) {
    if (!check.enabled) continue;

    // File-dependent checks: skip if no files were edited, or on re-prompt
    if (check.filePatterns && check.filePatterns.length > 0) {
      if (!alwaysRun) continue;
      if (state.editedFiles.length === 0) continue;
      if (!state.editedFiles.some((f) => matchesPatterns(f, check.filePatterns))) continue;
    } else if (!check.alwaysRun && !alwaysRun) {
      // Checks without filePatterns that aren't marked alwaysRun: skip on re-prompt
      continue;
    }

    const result = runCheck(check);

    if (!result.success && check.blocking) {
      // If the check itself output a JSON block decision, use it directly
      try {
        const parsed = JSON.parse(result.output);
        if (parsed.decision === "block" && parsed.reason) {
          blockReasons.push(parsed.reason);
          continue;
        }
      } catch {}
      blockReasons.push(`--- ${check.name} ---\n${result.output}`);
    }
  }

  clearState();

  if (blockReasons.length > 0) {
    process.stdout.write(
      JSON.stringify({
        decision: "block",
        reason: ["CHECKS FAILED", "", ...blockReasons, "", "Fix the issues before stopping."].join("\n"),
      }) + "\n"
    );
    process.exit(2);
  }
}

// --- Main ---

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

  const hookType = process.argv[2];
  if (hookType === "PostToolUse") handlePostToolUse(input);
  else if (hookType === "Stop") handleStop(input);

  process.exit(0);
}

main().catch(() => process.exit(0));

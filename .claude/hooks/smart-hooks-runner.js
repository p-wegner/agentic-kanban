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

let hookInput = {};

function getProjectDir() {
  const startDir = process.env.CLAUDE_PROJECT_DIR || hookInput.cwd || process.cwd();
  try {
    return execSync("git rev-parse --show-toplevel", {
      cwd: startDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim();
  } catch {
    return startDir;
  }
}

function getScriptProjectDir() {
  return path.resolve(__dirname, "..", "..");
}

function getConfigPath(projectDir = getProjectDir()) {
  return path.join(projectDir, ".claude", "hooks", "smart-hooks-config.json");
}

function getRulesPath(projectDir = getProjectDir()) {
  return path.join(projectDir, ".claude", "smart-hooks-rules.json");
}

function getStatePath() {
  return path.join(getProjectDir(), ".claude", "hooks", ".smart-hooks-state.json");
}

/**
 * Load the generated per-project edit-time feedback rules (#787) and convert each into a
 * runner "check". The rules file is machine-generated from the stack profile and uses a flat
 * `{ rules: [...] }` shape; the runner's check shape needs an `enabled` flag (rules are always
 * active). Generated rules run on both PostToolUse (per-edit) and Stop (end-of-session).
 */
function loadGeneratedRules(projectDir) {
  let rules;
  try {
    rules = JSON.parse(fs.readFileSync(getRulesPath(projectDir), "utf8")).rules;
  } catch {
    return [];
  }
  if (!Array.isArray(rules)) return [];
  return rules
    .filter((r) => r && r.command)
    .map((r) => ({
      enabled: true,
      name: r.name || "Check",
      command: r.command,
      filePatterns: Array.isArray(r.filePatterns) ? r.filePatterns : [],
      blocking: r.blocking !== false,
      timeout: typeof r.timeout === "number" ? r.timeout : 120,
    }));
}

function loadConfig(projectDir = getProjectDir()) {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(getConfigPath(projectDir), "utf8"));
  } catch {
    config = { hooks: {} };
  }
  if (!config.hooks) config.hooks = {};

  // Merge the generated stack-profile rules into the PostToolUse + Stop checks so a driven
  // project gets incremental edit-time feedback without any hand-authored config (#787).
  const generated = loadGeneratedRules(projectDir);
  if (generated.length > 0) {
    config.hooks.PostToolUse = [...(config.hooks.PostToolUse || []), ...generated];
    config.hooks.Stop = [...(config.hooks.Stop || []), ...generated];
  }
  return config;
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

function runCheck(check, inputData, editedFiles) {
  const timeout = (check.timeout || 30) * 1000;
  const env = {
    ...process.env,
    ...(editedFiles ? { SMART_HOOKS_EDITED_FILES: JSON.stringify(editedFiles) } : {}),
  };
  try {
    execSync(check.command, {
      cwd: check.cwd || getProjectDir(),
      timeout,
      encoding: "utf8",
      input: inputData ? JSON.stringify(inputData) : "",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env,
    });
    return { success: true, output: "" };
  } catch (err) {
    return {
      success: false,
      output: [err.stdout || "", err.stderr || ""].join("\n").trim(),
    };
  }
}

// --- PreToolUse: prevent destructive operations before execution ---

function isShellTool(toolName) {
  return ["Bash", "PowerShell", "shell", "shell_command", "exec_command", "command_execution"].includes(toolName);
}

function extractCommand(input) {
  return (
    input.tool_input?.command ||
    input.tool_input?.Command ||
    input.command ||
    input.Command ||
    ""
  );
}

// Windows paths are case-insensitive with either separator; POSIX paths are
// case-sensitive with "/" only — lowercasing there would falsely match
// /home/Alice and /home/alice.
const IS_WINDOWS = process.platform === "win32";

function normalizePathForCompare(p) {
  const s = String(p || "");
  return IS_WINDOWS
    ? s.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase()
    : s.replace(/\/+$/, "");
}

function pathIsInside(child, parent) {
  const c = normalizePathForCompare(child);
  const p = normalizePathForCompare(parent);
  const sep = IS_WINDOWS ? "\\" : "/";
  return c === p || c.startsWith(`${p}${sep}`);
}

function getMainCheckout() {
  if (process.env.KANBAN_MAIN_CHECKOUT) return process.env.KANBAN_MAIN_CHECKOUT;
  // Derive the main checkout from git instead of hardcoding a machine-specific path.
  // In a worktree, --git-common-dir resolves to the MAIN checkout's .git, whose parent
  // is the main checkout; in the main checkout it resolves to ./.git → the repo root.
  const startDir = process.env.CLAUDE_PROJECT_DIR || hookInput.cwd || process.cwd();
  try {
    const commonDir = execSync("git rev-parse --path-format=absolute --git-common-dir", {
      cwd: startDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim();
    if (commonDir) return path.dirname(commonDir);
  } catch {}
  return getProjectDir();
}

function isWorktreePath(p) {
  return /[\/\\]\.worktrees[\/\\]/i.test(String(p || "")) || /--\.worktrees--/i.test(String(p || ""));
}

function commandRunsVitest(command) {
  return (
    /\bvitest\b/i.test(command) ||
    /\btest:mine\b/i.test(command) ||
    /\bpnpm(?:\.cmd)?\b[^\n]*(?:\btest\b|\bexec\s+vitest\b)/i.test(command)
  );
}

function commandMovesToMainCheckout(command) {
  const main = getMainCheckout();
  if (!main) return false;
  const m = command.match(/\b(?:cd|Set-Location|Push-Location)\s+["']?([^\s"';]+)/i);
  return m ? pathIsInside(m[1], main) : false;
}

function getToolCwd(input) {
  return (
    input.tool_input?.cwd ||
    input.tool_input?.workdir ||
    input.tool_input?.working_dir ||
    input.cwd ||
    ""
  );
}

function getSessionProjectHint(input) {
  return (
    input.transcript_path ||
    input.transcriptPath ||
    input.cwd ||
    process.env.CLAUDE_PROJECT_DIR ||
    ""
  );
}

function wrongCheckoutVitestReason(input, command) {
  if (!commandRunsVitest(command)) return null;
  const sessionProject = getSessionProjectHint(input);
  if (!isWorktreePath(sessionProject)) return null;

  const mainCheckout = getMainCheckout();
  const cwd = getToolCwd(input);
  const cwdIsMain = cwd && pathIsInside(cwd, mainCheckout);
  if (!cwdIsMain && !commandMovesToMainCheckout(command)) return null;

  return [
    "Run worktree tests from the worktree root, not the main checkout.",
    "",
    `This session is for a worktree (${sessionProject}), but the test command is running under:`,
    `  ${cwdIsMain ? cwd : mainCheckout}`,
    "",
    "Use:",
    "  cd <your worktree root>",
    "  pnpm test:mine -- --changed HEAD",
    "",
    "Or from a package directory in that same worktree:",
    "  pnpm exec vitest related <file>",
    "",
    "Do not run pnpm install to fix vitest import errors; report the environment issue and continue.",
  ].join("\n");
}

function handlePreToolUse(input) {
  const toolName = input.tool_name;

  // Only validate shell commands. Codex reports canonical shell hooks as Bash,
  // but older/local harnesses may use their implementation-specific names.
  if (!isShellTool(toolName)) {
    process.exit(0);
  }

  const command = extractCommand(input);
  const wrongCheckoutReason = wrongCheckoutVitestReason(input, command);
  if (wrongCheckoutReason) {
    console.error("[smart-hooks] Wrong-checkout Vitest guard: PREVENTED");
    console.error(wrongCheckoutReason);
    process.stdout.write(
      JSON.stringify({
        decision: "block",
        reason: wrongCheckoutReason,
      }) + "\n"
    );
    process.exit(2);
  }

  const policyDir = getScriptProjectDir();
  const config = loadConfig(policyDir);
  const checks = config.hooks?.PreToolUse || [];

  for (const check of checks) {
    if (!check.enabled) continue;

    const result = runCheck({ ...check, cwd: check.cwd || policyDir }, { command, cwd: input.cwd }, []);

    if (!result.success) {
      console.error(`[smart-hooks] ${check.name}: PREVENTED`);
      if (result.output) console.error(result.output);
      process.stdout.write(
        JSON.stringify({
          decision: "block",
          reason: `${check.name}:\n\n${result.output}`,
        }) + "\n"
      );
      process.exit(2);
    }
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
    const result = runCheck({ ...check, command }, input, state.editedFiles);

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
  const isFirstStop = input.stop_hook_active !== true;
  // On re-prompt (stop_hook_active=true), only run checks marked alwaysRun.
  // File-dependent hooks (tests, tsc, playwright) are skipped on re-prompt.

  for (const check of checks) {
    if (!check.enabled) continue;

    // File-dependent checks: skip if no files were edited, or on re-prompt
    if (check.filePatterns && check.filePatterns.length > 0) {
      if (!isFirstStop) continue;
      if (state.editedFiles.length === 0) continue;
      if (!state.editedFiles.some((f) => matchesPatterns(f, check.filePatterns))) continue;
    } else if (!check.alwaysRun && !isFirstStop) {
      // Checks without filePatterns that aren't marked alwaysRun: skip on re-prompt
      continue;
    }

    const result = runCheck(check, input, state.editedFiles);

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
    hookInput = input;
  } catch {
    process.exit(0);
  }

  const hookType = process.argv[2];
  if (hookType === "PreToolUse") handlePreToolUse(input);
  else if (hookType === "PostToolUse") handlePostToolUse(input);
  else if (hookType === "Stop") handleStop(input);

  process.exit(0);
}

if (require.main === module) {
  main().catch(() => process.exit(0));
}

module.exports = {
  wrongCheckoutVitestReason,
};

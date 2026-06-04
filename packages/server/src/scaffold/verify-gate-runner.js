#!/usr/bin/env node
// Verify-gate runner — a self-contained Stop hook that runs a project-defined
// build/test/lint command in the worktree and blocks the session from exiting
// with a "done" status when the command fails.
//
// Designed to be shipped into any scaffolded repo's .claude/hooks/ directory.
// No board-specific assumptions, no DB access, no project IDs.
//
// Configuration (pick one, evaluated in order):
//   1. .claude/hooks/verify-gate.config.json  { "command": "npm test" }
//   2. VERIFY_GATE_COMMAND environment variable
//   3. No config → exit 0 (gate disabled, no-op)
//
// Exit codes:
//   0  — command passed (or gate disabled)
//   1  — command failed; session blocked from merging
//   2  — configuration error (bad JSON, etc.)

const { execFileSync } = require("child_process");
const { readFileSync, existsSync } = require("fs");
const { join, dirname } = require("path");

// Use the directory of the script file itself so the config is always found
// alongside the runner — whether called directly or via smart-hooks-runner.
const HOOK_DIR = dirname(process.argv[1]);
const CONFIG_PATH = join(HOOK_DIR, "verify-gate.config.json");
const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

function resolveCommand() {
  if (existsSync(CONFIG_PATH)) {
    let cfg;
    try {
      cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    } catch (e) {
      process.stderr.write(`[verify-gate] Bad JSON in verify-gate.config.json: ${e.message}\n`);
      process.exit(2);
    }
    if (cfg && typeof cfg.command === "string" && cfg.command.trim()) {
      return cfg.command.trim();
    }
  }
  if (process.env.VERIFY_GATE_COMMAND && process.env.VERIFY_GATE_COMMAND.trim()) {
    return process.env.VERIFY_GATE_COMMAND.trim();
  }
  return null;
}

function resolveCwd(input) {
  // Prefer the worktree dir from the hook input, fall back to process.cwd().
  const candidate = input && (input.cwd || (input.session && input.session.cwd));
  if (candidate && existsSync(candidate)) return candidate;
  return process.cwd();
}

async function main() {
  const lines = [];
  for await (const chunk of process.stdin) lines.push(chunk);
  let input = {};
  try {
    input = JSON.parse(lines.join(""));
  } catch {
    /* stdin may be empty or non-JSON in some harnesses — tolerate */
  }

  // Loop safety: stop_hook_active means a prior Stop hook already fired and the
  // agent was re-prompted; let it through on re-entry so we don't loop forever.
  if (input.stop_hook_active === true) process.exit(0);

  const command = resolveCommand();
  if (!command) process.exit(0); // gate not configured — no-op

  const cwd = resolveCwd(input);

  process.stderr.write(`[verify-gate] Running: ${command}\n`);
  process.stderr.write(`[verify-gate] Working dir: ${cwd}\n`);

  const isWindows = process.platform === "win32";
  const shell = isWindows ? "cmd.exe" : "/bin/sh";
  const shellArgs = isWindows ? ["/c", command] : ["-c", command];

  // Capture both stdout and stderr from the sub-command so they don't leak
  // onto the hook's stdout (Claude Stop hooks use stdout for JSON decisions).
  let exitCode = 0;
  let cmdOutput = "";
  try {
    const result = execFileSync(shell, shellArgs, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      timeout: TIMEOUT_MS,
      encoding: "utf8",
    });
    // On success execFileSync returns stdout; relay it to stderr for visibility.
    if (result) process.stderr.write(result);
  } catch (e) {
    exitCode = typeof e.status === "number" ? e.status : 1;
    if (e.killed) {
      process.stderr.write(`[verify-gate] Command timed out after 5 minutes.\n`);
      exitCode = 1;
    }
    // Relay captured output to stderr so the agent can see what failed.
    cmdOutput = [e.stdout, e.stderr].filter(Boolean).join("\n");
    if (cmdOutput) process.stderr.write(cmdOutput + "\n");
  }

  if (exitCode !== 0) {
    const reason =
      `[verify-gate] FAILED (exit ${exitCode}): ${command}\n` +
      (cmdOutput ? `\n${cmdOutput}\n` : "") +
      `\nFix the above errors before this workspace can be merged.`;
    process.stderr.write(reason + "\n");
    // Emit a structured block decision so Claude shows the failure reason.
    process.stdout.write(JSON.stringify({ decision: "block", reason }) + "\n");
    process.exit(1);
  }

  process.stderr.write(`[verify-gate] Passed.\n`);
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`[verify-gate] Unexpected error: ${e.message}\n`);
  process.exit(1);
});

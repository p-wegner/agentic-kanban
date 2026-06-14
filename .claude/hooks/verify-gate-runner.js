#!/usr/bin/env node
// Verify-gate runner — a self-contained Stop hook that runs a project-defined
// build/test/lint command in the worktree and blocks the session from exiting
// with a "done" status when the command fails.
//
// Bounded self-repair loop: when the command fails, the captured failure is fed
// back to the builder (via a `block` decision, which re-prompts the agent) for a
// bounded number of self-repair attempts before giving up. On exhaustion the
// ticket is ESCALATED with the captured error attached — never silently stranded.
//
// Designed to be shipped into any scaffolded repo's .claude/hooks/ directory.
// No board-specific assumptions, no DB access, no project IDs.
//
// Configuration (pick one, evaluated in order):
//   1. .claude/hooks/verify-gate.config.json  { "command": "npm test", "maxRepairAttempts": 3 }
//   2. VERIFY_GATE_COMMAND environment variable (+ VERIFY_GATE_MAX_REPAIR_ATTEMPTS)
//   3. No config → exit 0 (gate disabled, no-op)
//
// Self-repair state is persisted per-worktree in .claude/hooks/.verify-gate-state.json
// so the attempt counter survives across separate Stop-hook process invocations.
//
// Exit codes:
//   0  — command passed (or gate disabled, or escalated after exhausting attempts)
//   1  — command failed; session blocked to drive another self-repair attempt
//   2  — configuration error (bad JSON, etc.)

const { execFileSync } = require("child_process");
const { readFileSync, writeFileSync, existsSync, unlinkSync } = require("fs");
const { join, dirname } = require("path");

// Use the directory of the script file itself so the config is always found
// alongside the runner — whether called directly or via smart-hooks-runner.
const HOOK_DIR = dirname(process.argv[1]);
const CONFIG_PATH = join(HOOK_DIR, "verify-gate.config.json");
const STATE_PATH = join(HOOK_DIR, ".verify-gate-state.json");
const ESCALATION_PATH = join(HOOK_DIR, ".verify-gate-escalation.json");
const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_MAX_REPAIR_ATTEMPTS = 3;

function resolveConfig() {
  let command = null;
  let maxRepairAttempts = DEFAULT_MAX_REPAIR_ATTEMPTS;

  if (existsSync(CONFIG_PATH)) {
    let cfg;
    try {
      cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    } catch (e) {
      process.stderr.write(`[verify-gate] Bad JSON in verify-gate.config.json: ${e.message}\n`);
      process.exit(2);
    }
    if (cfg && typeof cfg.command === "string" && cfg.command.trim()) {
      command = cfg.command.trim();
    }
    if (cfg && Number.isFinite(cfg.maxRepairAttempts)) {
      maxRepairAttempts = Math.max(0, Math.floor(cfg.maxRepairAttempts));
    }
  }

  if (!command && process.env.VERIFY_GATE_COMMAND && process.env.VERIFY_GATE_COMMAND.trim()) {
    command = process.env.VERIFY_GATE_COMMAND.trim();
  }
  const envMax = process.env.VERIFY_GATE_MAX_REPAIR_ATTEMPTS;
  if (envMax && Number.isFinite(Number(envMax))) {
    maxRepairAttempts = Math.max(0, Math.floor(Number(envMax)));
  }

  return { command, maxRepairAttempts };
}

function resolveCwd(input) {
  // Prefer the worktree dir from the hook input, fall back to process.cwd().
  const candidate = input && (input.cwd || (input.session && input.session.cwd));
  if (candidate && existsSync(candidate)) return candidate;
  return process.cwd();
}

// --- Self-repair state (persisted across separate hook process invocations) ---
function readState() {
  if (!existsSync(STATE_PATH)) return { attempts: 0 };
  try {
    const s = JSON.parse(readFileSync(STATE_PATH, "utf8"));
    return { attempts: Number.isFinite(s.attempts) ? s.attempts : 0 };
  } catch {
    return { attempts: 0 };
  }
}

function writeState(state) {
  try {
    writeFileSync(STATE_PATH, JSON.stringify(state), "utf8");
  } catch {
    /* state is best-effort; a missing/unwritable file just means we under-count */
  }
}

function clearState() {
  try {
    if (existsSync(STATE_PATH)) unlinkSync(STATE_PATH);
  } catch {
    /* non-fatal */
  }
}

function writeEscalation(payload) {
  try {
    writeFileSync(ESCALATION_PATH, JSON.stringify(payload, null, 2) + "\n", "utf8");
  } catch {
    /* non-fatal — the escalation is also surfaced via stderr/decision */
  }
}

function runVerifyCommand(command, cwd) {
  const isWindows = process.platform === "win32";
  const shell = isWindows ? "cmd.exe" : "/bin/sh";
  const shellArgs = isWindows ? ["/c", command] : ["-c", command];

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
    if (result) process.stderr.write(result);
  } catch (e) {
    exitCode = typeof e.status === "number" ? e.status : 1;
    if (e.killed) {
      process.stderr.write(`[verify-gate] Command timed out after 5 minutes.\n`);
      exitCode = 1;
    }
    cmdOutput = [e.stdout, e.stderr].filter(Boolean).join("\n");
    if (cmdOutput) process.stderr.write(cmdOutput + "\n");
  }
  return { exitCode, cmdOutput };
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

  const { command, maxRepairAttempts } = resolveConfig();
  if (!command) process.exit(0); // gate not configured — no-op

  const cwd = resolveCwd(input);

  process.stderr.write(`[verify-gate] Running: ${command}\n`);
  process.stderr.write(`[verify-gate] Working dir: ${cwd}\n`);

  const { exitCode, cmdOutput } = runVerifyCommand(command, cwd);

  if (exitCode === 0) {
    // Passed — clear any in-progress self-repair state so the next failure starts fresh.
    clearState();
    process.stderr.write(`[verify-gate] Passed.\n`);
    process.exit(0);
  }

  // --- Failure path: bounded self-repair loop ---
  const state = readState();
  // attempts = number of self-repair passes the builder has already been asked to make.
  const priorAttempts = state.attempts;

  // maxRepairAttempts === 0 disables self-repair: escalate immediately on first failure.
  if (priorAttempts >= maxRepairAttempts) {
    // Exhausted the self-repair budget — ESCALATE with the captured error attached.
    clearState();
    const escalation = {
      escalated: true,
      command,
      exitCode,
      attempts: priorAttempts,
      maxRepairAttempts,
      capturedError: cmdOutput,
      timestamp: new Date().toISOString(),
    };
    writeEscalation(escalation);
    const reason =
      `[verify-gate] ESCALATED — verify gate still failing after ${priorAttempts} ` +
      `self-repair attempt(s) (exit ${exitCode}): ${command}\n` +
      (cmdOutput ? `\nCaptured error:\n${cmdOutput}\n` : "") +
      `\nThis ticket could not be auto-repaired within ${maxRepairAttempts} attempt(s). ` +
      `The failure above is attached for human/reviewer follow-up ` +
      `(see ${ESCALATION_PATH}). Stopping the self-repair loop to avoid an endless cycle.`;
    process.stderr.write(reason + "\n");
    // Do NOT emit a `block` decision: blocking again would re-prompt and loop forever.
    // We surface the escalation (no silent strand) and let the session exit so the
    // board's review / stranded-reconciler can pick it up with the captured error in
    // hand. `continue: true` is an explicit "allow the stop" signal for the harness.
    process.stdout.write(JSON.stringify({ continue: true, reason }) + "\n");
    process.exit(0);
  }

  // Still within budget — increment the counter and feed the failure back to the
  // builder to drive another self-repair pass.
  const attemptNumber = priorAttempts + 1;
  writeState({ attempts: attemptNumber, command, lastExitCode: exitCode });

  const reason =
    `[verify-gate] FAILED (exit ${exitCode}): ${command}\n` +
    `[verify-gate] Self-repair attempt ${attemptNumber} of ${maxRepairAttempts}.\n` +
    (cmdOutput ? `\n${cmdOutput}\n` : "") +
    `\nFix the above errors before this workspace can be merged, then stop again to re-verify. ` +
    `${maxRepairAttempts - attemptNumber} repair attempt(s) remain before this ticket is escalated.`;
  process.stderr.write(reason + "\n");
  // Structured block decision re-prompts Claude with the failure as feedback.
  process.stdout.write(JSON.stringify({ decision: "block", reason }) + "\n");
  process.exit(1);
}

main().catch((e) => {
  process.stderr.write(`[verify-gate] Unexpected error: ${e.message}\n`);
  process.exit(1);
});

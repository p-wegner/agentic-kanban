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

const { execFileSync, spawn } = require("child_process");
const { readFileSync, writeFileSync, existsSync, unlinkSync } = require("fs");
const { join, dirname } = require("path");
const { tmpdir } = require("os");

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

// --- Post-run zombie sweep (#172) ---
// Windows does not tear down a process tree when only its root exits: a `pnpm test`
// run that forks a vitest worker pool can leave those workers alive long after the
// launching shell has returned control here (vitest's Windows fork pool is the
// observed repeat offender — 18-20 orphaned node.exe per worktree). Best-effort,
// self-contained (no board deps, ships to any scaffolded repo): after the verify
// command finishes, find any process whose command line still references `cwd` and
// isn't part of this runner's own ancestor chain, and kill it.
function listProcessesForSweep() {
  try {
    if (process.platform === "win32") {
      const script =
        "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress";
      const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 10000,
      });
      const raw = out && out.trim() ? out : "[]";
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        const controlCharPattern = new RegExp("[\\x00-\\x1f]", "g");
        parsed = JSON.parse(raw.replace(controlCharPattern, " "));
      }
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      return rows
        .map((row) => ({
          pid: Number(row.ProcessId),
          ppid: Number(row.ParentProcessId) || 0,
          commandLine: String(row.CommandLine || ""),
        }))
        .filter((row) => Number.isInteger(row.pid) && row.pid > 0);
    }
    const out = execFileSync("ps", ["-eo", "pid=,ppid=,args="], { encoding: "utf8", timeout: 10000 });
    return out
      .split("\n")
      .map((line) => {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
        if (!match) return null;
        return { pid: Number(match[1]), ppid: Number(match[2]), commandLine: match[3] || "" };
      })
      .filter((row) => row && Number.isInteger(row.pid) && row.pid > 0);
  } catch {
    return [];
  }
}

function killPidTree(pid) {
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { timeout: 5000, windowsHide: true });
    } else {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        process.kill(pid, "SIGKILL");
      }
    }
  } catch {
    /* already gone — best-effort */
  }
}

// A leaked test worker never holds a listening TCP socket. A dev server does — and a
// dev server is routinely started DETACHED (this project's own dev-server workflow
// spawns it with its launching shell exiting immediately), which makes it look
// identical to an orphaned zombie worker under the orphan+path heuristic alone. This
// hook fires on every passing Stop-hook cycle, not just true session end, so without
// this check a `pnpm dev` left running for visual verification in the same worktree
// would get torn down by the very next green verify pass. Skip any orphan whose tree
// owns a listening port.
function listListeningPids() {
  try {
    if (process.platform === "win32") {
      // Do NOT parse `netstat`'s STATE column text (e.g. "LISTENING") — it is
      // localized by the OS UI language (observed as "ABHÖREN" on German Windows),
      // so a plain substring match silently returns zero listeners on any
      // non-English machine and this whole protection goes dark. `-State Listen`
      // filters on the .NET enum NAME, which is culture-invariant.
      const script =
        "Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess | ConvertTo-Json -Compress";
      const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 10000,
      });
      const raw = out && out.trim() ? out : "[]";
      const parsed = JSON.parse(raw);
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      const pids = new Set();
      for (const row of rows) {
        const pid = Number(row);
        if (Number.isInteger(pid) && pid > 0) pids.add(pid);
      }
      return pids;
    }
    const out = execFileSync("lsof", ["-iTCP", "-sTCP:LISTEN", "-P", "-n"], {
      encoding: "utf8",
      timeout: 10000,
    });
    const pids = new Set();
    for (const line of out.split("\n").slice(1)) {
      const parts = line.trim().split(/\s+/);
      const pid = Number(parts[1]);
      if (Number.isInteger(pid) && pid > 0) pids.add(pid);
    }
    return pids;
  } catch {
    return new Set();
  }
}

function buildChildrenMap(processes) {
  const children = new Map();
  for (const proc of processes) {
    if (!children.has(proc.ppid)) children.set(proc.ppid, []);
    children.get(proc.ppid).push(proc);
  }
  return children;
}

function collectTreePids(rootPid, childrenMap, seen) {
  if (seen.has(rootPid)) return seen;
  seen.add(rootPid);
  for (const child of childrenMap.get(rootPid) || []) {
    collectTreePids(child.pid, childrenMap, seen);
  }
  return seen;
}

function killDirDescendants(cwd) {
  if (!cwd) return;
  const processes = listProcessesForSweep();
  if (processes.length === 0) return;
  const byPid = new Map(processes.map((p) => [p.pid, p]));
  const childrenMap = buildChildrenMap(processes);
  const listeningPids = listListeningPids();

  // Never kill this runner or anything in its own ancestor chain (the agent/session
  // process, the harness, etc.) even if their command line happens to reference cwd.
  const ancestors = new Set([process.pid]);
  let cursor = byPid.get(process.pid);
  for (let i = 0; cursor && i < 15; i++) {
    const parentPid = cursor.ppid;
    if (!parentPid || ancestors.has(parentPid)) break;
    ancestors.add(parentPid);
    cursor = byPid.get(parentPid);
  }

  const dirNormalized = cwd.replace(/\\/g, "/").toLowerCase();
  for (const proc of processes) {
    if (ancestors.has(proc.pid)) continue;
    // Path match alone is not enough — that would kill ANY live process anywhere
    // on the machine that happens to reference this cwd (a manually-started `pnpm
    // dev` server for this same worktree, another agent's session, etc.), which is
    // exactly the "kill other agents' worktree servers" hazard this project's hard
    // constraints forbid. By the time this runs, the verify command's own launching
    // shell has already exited (execFileSync is synchronous) — so a genuine leaked
    // worker is always an ORPHAN: its recorded parent PID is no longer alive. A live
    // dev server or agent session still has a live parent and is skipped.
    if (byPid.has(proc.ppid)) continue;
    const cmdNormalized = proc.commandLine.replace(/\\/g, "/").toLowerCase();
    if (!commandReferencesDir(cmdNormalized, dirNormalized)) continue;
    const treePids = collectTreePids(proc.pid, childrenMap, new Set());
    let ownsListener = false;
    for (const pid of treePids) {
      if (listeningPids.has(pid)) {
        ownsListener = true;
        break;
      }
    }
    if (ownsListener) continue;
    killPidTree(proc.pid);
  }
}

// Plain substring matching would let a worktree dir that is a NAME PREFIX of a
// sibling worktree (e.g. ".../feature_ak-17" vs ".../feature_ak-172") cross-match
// and kill the sibling's processes — ticket numbers are sequential so this
// collision is common. Require the match to end at a path/quote/space boundary.
function commandReferencesDir(cmdNormalized, dirNormalized) {
  let searchFrom = 0;
  for (;;) {
    const idx = cmdNormalized.indexOf(dirNormalized, searchFrom);
    if (idx === -1) return false;
    const next = cmdNormalized[idx + dirNormalized.length];
    if (next === undefined || next === "/" || next === '"' || next === "'" || next === " ") {
      return true;
    }
    searchFrom = idx + 1;
  }
}

// The sweep enumerates every OS process (a multi-second PowerShell/WMI round trip on
// Windows) — synchronous, that latency lands on every single Stop-hook invocation,
// not just ones that actually leaked something. Run it as a detached, unref'd child
// instead: the gate's own pass/fail decision returns immediately, and the sweep
// re-invokes this same script with --sweep-only in the background.
function spawnBackgroundSweep(cwd) {
  if (!cwd) return;
  try {
    const child = spawn(process.execPath, [process.argv[1], "--sweep-only", cwd], {
      // NOT hookDir/cwd — a detached child inheriting the caller's cwd holds an OS
      // handle on that directory for as long as it runs, which would block that
      // worktree/hook dir from being removed or reused while the sweep is in flight.
      cwd: tmpdir(),
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  } catch {
    /* best-effort */
  }
}

// Mirrors translatePosixWrapperForWindows in @agentic-kanban/shared/lib/setup-script.ts
// (#181) — cmd.exe parses `./gradlew` as the command `.` and fails outright, so a
// `./gradlew`/`./mvnw`-style verify command must be rewritten to the `.bat`/`.cmd` form
// before it reaches cmd.exe. Duplicated here because this file is a standalone scaffold
// copy shipped into scaffolded repos, not an importer of the shared package.
// Keep the separator class in sync with the shared copy: `&&` alone missed the second
// half of every chained script (`... || ./gradlew clean`, `cd app; ./gradlew build`,
// multi-line), which then failed on cmd.exe exactly as before the fix.
function translatePosixWrapperForWindows(command) {
  return command
    .replace(/(^|[\r\n;&|(])(\s*)\.\/gradlew\b/g, "$1$2.\\gradlew.bat")
    .replace(/(^|[\r\n;&|(])(\s*)\.\/mvnw\b/g, "$1$2.\\mvnw.cmd");
}

function runVerifyCommand(command, cwd) {
  const isWindows = process.platform === "win32";
  const shell = isWindows ? "cmd.exe" : "/bin/sh";
  const shellCommand = isWindows ? translatePosixWrapperForWindows(command) : command;
  const shellArgs = isWindows ? ["/c", shellCommand] : ["-c", command];

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
  if (process.argv[2] === "--sweep-only") {
    // Background sweep worker spawned by spawnBackgroundSweep — not a real hook
    // invocation, just does the dir-scoped kill and exits.
    killDirDescendants(process.argv[3]);
    process.exit(0);
  }

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
    // Session is actually exiting on this path: safe to reap leftover worker fleets.
    // Best-effort, non-blocking: never let the sweep (or its cost) affect the gate's
    // own pass/fail decision or latency.
    try {
      spawnBackgroundSweep(cwd);
    } catch {
      /* best-effort */
    }
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
    // Session is actually exiting on this path too (no more `block` decisions coming):
    // safe to reap leftover worker fleets. Best-effort, non-blocking.
    try {
      spawnBackgroundSweep(cwd);
    } catch {
      /* best-effort */
    }
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

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const RUNNER_SRC = join(__dirname, "../scaffold/verify-gate-runner.js");

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Run the gate with the runner copied into hookDir so process.argv[1] resolves
 * to hookDir — matching the deployed layout where runner and config are siblings.
 */
function runGate(opts: {
  hookDir: string;
  stdin?: string;
  env?: Record<string, string>;
}): RunResult {
  const { hookDir, stdin = "{}", env = {} } = opts;
  const runnerInHookDir = join(hookDir, "verify-gate-runner.js");
  // Copy runner into hookDir so argv[1] resolves there (config lookup uses argv[1]'s dir)
  copyFileSync(RUNNER_SRC, runnerInHookDir);
  const result = spawnSync(process.execPath, [runnerInHookDir], {
    cwd: hookDir,
    input: stdin,
    encoding: "utf8",
    env: { ...process.env, ...env },
    windowsHide: true,
    timeout: 30_000,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "verify-gate-test-"));
}

describe("verify-gate-runner", () => {
  let hookDir: string;
  let projectDir: string;

  beforeEach(async () => {
    // hookDir simulates .claude/hooks/ — the runner lives here alongside the config
    hookDir = await tmp();
    projectDir = await tmp();
  });

  afterEach(async () => {
    await rm(hookDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  });

  it("exits 0 (no-op) when no config file and no env var", () => {
    const result = runGate({ hookDir });
    expect(result.status).toBe(0);
  });

  it("exits 0 when config file has empty command string", async () => {
    await writeFile(join(hookDir, "verify-gate.config.json"), JSON.stringify({ command: "  " }));
    const result = runGate({ hookDir });
    expect(result.status).toBe(0);
  });

  it("exits 0 when command succeeds (zero exit)", async () => {
    const cmd = process.platform === "win32" ? "exit 0" : "true";
    await writeFile(join(hookDir, "verify-gate.config.json"), JSON.stringify({ command: cmd }));
    const result = runGate({ hookDir });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("[verify-gate] Passed.");
  });

  it("exits 1 when command fails (non-zero exit)", async () => {
    const cmd = process.platform === "win32" ? "exit 1" : "false";
    await writeFile(join(hookDir, "verify-gate.config.json"), JSON.stringify({ command: cmd }));
    const result = runGate({ hookDir });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("[verify-gate] FAILED");
    expect(result.stderr).toContain("Fix the above errors");
    // Structured block decision on stdout so Claude can display the failure reason.
    const decision = JSON.parse(result.stdout.trim());
    expect(decision.decision).toBe("block");
    expect(decision.reason).toContain("[verify-gate] FAILED");
  });

  it("reads command from VERIFY_GATE_COMMAND env var when no config file", () => {
    const cmd = process.platform === "win32" ? "exit 0" : "true";
    const result = runGate({ hookDir, env: { VERIFY_GATE_COMMAND: cmd } });
    expect(result.status).toBe(0);
  });

  it("env var command failure exits 1", () => {
    const cmd = process.platform === "win32" ? "exit 1" : "false";
    const result = runGate({ hookDir, env: { VERIFY_GATE_COMMAND: cmd } });
    expect(result.status).toBe(1);
  });

  it("config file takes precedence over env var", async () => {
    // config says pass, env says fail — config should win
    const passcmd = process.platform === "win32" ? "exit 0" : "true";
    const failcmd = process.platform === "win32" ? "exit 1" : "false";
    await writeFile(join(hookDir, "verify-gate.config.json"), JSON.stringify({ command: passcmd }));
    const result = runGate({ hookDir, env: { VERIFY_GATE_COMMAND: failcmd } });
    expect(result.status).toBe(0);
  });

  it("exits 0 on stop_hook_active=true (loop safety)", async () => {
    const failcmd = process.platform === "win32" ? "exit 1" : "false";
    await writeFile(join(hookDir, "verify-gate.config.json"), JSON.stringify({ command: failcmd }));
    const result = runGate({ hookDir, stdin: JSON.stringify({ stop_hook_active: true }) });
    expect(result.status).toBe(0);
  });

  it("exits 2 on malformed config JSON", async () => {
    await writeFile(join(hookDir, "verify-gate.config.json"), "not json {{{");
    const result = runGate({ hookDir });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Bad JSON");
  });

  it("exits 0 when config exists but has no command key", async () => {
    await writeFile(join(hookDir, "verify-gate.config.json"), JSON.stringify({ timeout: 60 }));
    const result = runGate({ hookDir });
    expect(result.status).toBe(0);
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const RUNNER_SRC = join(__dirname, "../scaffold/verify-gate-runner.js");
// The dev checkout's LIVE hook — a deliberate copy of the canonical (tested) scaffold source.
const DEPLOYED_HOOK = join(__dirname, "../../../../.claude/hooks/verify-gate-runner.js");

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

describe("verify-gate-runner — source identity (#952)", () => {
  it("the deployed .claude/hooks copy is byte-identical to the canonical tested scaffold source", async () => {
    // Two copies exist on purpose: packages/server/src/scaffold/verify-gate-runner.js is the
    // canonical source (tested here, shipped to dist/scaffold/hooks/ by copy-assets.mjs), and
    // .claude/hooks/verify-gate-runner.js is this checkout's live Stop hook. If they drift,
    // the tested artifact no longer matches the deployed one — keep them in sync manually
    // (edit the scaffold source, copy to .claude/hooks/).
    const canonical = await readFile(RUNNER_SRC, "utf8");
    const deployed = await readFile(DEPLOYED_HOOK, "utf8");
    expect(deployed).toBe(canonical);
  });
});

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

  it("exits 1 and blocks (re-prompt) on the first failure within the repair budget", async () => {
    const cmd = process.platform === "win32" ? "exit 1" : "false";
    await writeFile(join(hookDir, "verify-gate.config.json"), JSON.stringify({ command: cmd }));
    const result = runGate({ hookDir });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("[verify-gate] FAILED");
    expect(result.stderr).toContain("Fix the above errors");
    // First failure is self-repair attempt 1 of the default 3.
    expect(result.stderr).toContain("Self-repair attempt 1 of 3");
    // Structured block decision on stdout re-prompts the builder with the failure.
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

  // #181: cmd.exe parses `./gradlew` as the command `.` and fails outright, so a
  // `./gradlew`-style verify_script/hook command must resolve through the translated
  // `.\gradlew.bat` form instead of being handed to cmd.exe verbatim.
  it.runIf(process.platform === "win32")(
    "resolves a ./gradlew-style command via the translated .bat form on win32",
    async () => {
      await writeFile(
        join(hookDir, "gradlew.bat"),
        "@echo off\r\nexit /b 0\r\n",
      );
      await writeFile(join(hookDir, "verify-gate.config.json"), JSON.stringify({ command: "./gradlew build" }));
      const result = runGate({ hookDir });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain("[verify-gate] Passed.");
    },
  );

  // The translation used to recognise only `^` and `&&`, so a chained command's SECOND
  // wrapper invocation reached cmd.exe as `./gradlew` and failed the gate anyway.
  it.runIf(process.platform === "win32")(
    "translates a wrapper invocation after a separator other than && on win32",
    async () => {
      await writeFile(join(hookDir, "gradlew.bat"), "@echo off\r\nexit /b 0\r\n");
      await writeFile(
        join(hookDir, "verify-gate.config.json"),
        JSON.stringify({ command: "echo pre; ./gradlew build" }),
      );
      const result = runGate({ hookDir });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain("[verify-gate] Passed.");
    },
  );
});

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("verify-gate-runner — zombie process sweep (#172)", () => {
  let hookDir: string;
  let projectDir: string;

  beforeEach(async () => {
    hookDir = await tmp();
    projectDir = await tmp();
  });

  afterEach(async () => {
    await rm(hookDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  });

  it("kills a detached descendant left running under cwd after the gate command exits", async () => {
    // Simulates the vitest-worker-fleet leak: the command's own process (like `pnpm
    // test`'s shell) exits cleanly, but it spawned a detached, unref'd descendant
    // (like a vitest fork worker) that keeps running under the SAME worktree path.
    // Windows never tears that descendant down just because its ancestor exited.
    const markerWorker = join(projectDir, "marker-worker.js");
    await writeFile(markerWorker, "setInterval(() => {}, 1000);\n");
    const lingerScript = join(projectDir, "linger.js");
    const pidFile = join(projectDir, "linger.pid");
    await writeFile(
      lingerScript,
      [
        "const fs = require('fs');",
        "const { spawn } = require('child_process');",
        `const child = spawn(process.execPath, [${JSON.stringify(markerWorker)}], { detached: true, stdio: 'ignore' });`,
        `fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
        "child.unref();",
      ].join("\n"),
    );

    // No quotes around the path: embedding a quoted arg inside the command string here
    // collides with execFileSync's own Windows cmd.exe argument re-quoting. Test tmp
    // dirs never contain spaces, so this is safe.
    await writeFile(join(hookDir, "verify-gate.config.json"), JSON.stringify({ command: `node ${lingerScript}` }));
    const result = runGate({ hookDir, stdin: JSON.stringify({ cwd: projectDir }) });
    expect(result.status).toBe(0);

    const pid = Number(await readFile(pidFile, "utf8"));
    expect(Number.isInteger(pid)).toBe(true);

    // The sweep that reaps the descendant runs as a detached background process (so
    // the gate itself returns immediately, unaffected by the sweep's own OS-process-
    // enumeration latency) — poll instead of asserting immediately after runGate returns.
    const deadline = Date.now() + 15_000;
    let alive = isPidAlive(pid);
    while (alive && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      alive = isPidAlive(pid);
    }
    expect(alive).toBe(false);
  }, 20_000);

  it("does not kill an orphaned descendant under cwd that owns a listening TCP port (#172 regression)", async () => {
    // Simulates a `pnpm dev` server left running for visual verification, per this
    // project's dev-server workflow: it's routinely started DETACHED (so its
    // launching shell exits immediately), making it look identical to an orphaned
    // zombie test worker under the orphan+path heuristic ALONE. The only thing that
    // actually distinguishes a leaked test worker (never listens) from a dev server
    // (always listens) is whether it owns a listening socket — the sweep must check
    // that before killing an orphan.
    const listenerWorker = join(projectDir, "listener-worker.js");
    await writeFile(
      listenerWorker,
      [
        "const http = require('http');",
        "const fs = require('fs');",
        "const server = http.createServer((_req, res) => res.end('ok'));",
        `server.listen(0, () => fs.writeFileSync(${JSON.stringify(join(projectDir, "listener.port"))}, String(server.address().port)));`,
      ].join("\n"),
    );
    const lingerScript = join(projectDir, "linger-listener.js");
    const pidFile = join(projectDir, "linger-listener.pid");
    await writeFile(
      lingerScript,
      [
        "const fs = require('fs');",
        "const { spawn } = require('child_process');",
        `const child = spawn(process.execPath, [${JSON.stringify(listenerWorker)}], { detached: true, stdio: 'ignore' });`,
        `fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
        "child.unref();",
      ].join("\n"),
    );

    await writeFile(join(hookDir, "verify-gate.config.json"), JSON.stringify({ command: `node ${lingerScript}` }));
    const result = runGate({ hookDir, stdin: JSON.stringify({ cwd: projectDir }) });
    expect(result.status).toBe(0);

    const pid = Number(await readFile(pidFile, "utf8"));
    expect(Number.isInteger(pid)).toBe(true);

    try {
      // Give the background sweep the same window used elsewhere to do its (wrong) kill.
      await new Promise((resolve) => setTimeout(resolve, 5000));
      expect(isPidAlive(pid)).toBe(true);
    } finally {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }, 20_000);

  it("does not kill an unrelated live process whose parent is still alive, even if its command line references cwd (#172 regression)", async () => {
    // Simulates a legitimate `pnpm dev` server (or another agent's session) that is
    // still running in the SAME worktree cwd when this gate happens to fire. Its
    // process tree has nothing to do with the gate's own command, and its parent
    // (this test process) is alive the whole time — the sweep must not path-match
    // its way into killing it. Regression for the bug where killDirDescendants
    // matched ANY process referencing cwd, not just orphaned descendants of the
    // already-completed verify command.
    const liveServerScript = join(projectDir, "live-server.js");
    await writeFile(liveServerScript, "setInterval(() => {}, 1000);\n");
    // Not detached — stays parented to this test process, which stays alive for the
    // duration of the test, so its recorded ppid is always present in the snapshot.
    const { spawn } = await import("node:child_process");
    const liveServerProc = spawn(process.execPath, [liveServerScript, `--workdir=${projectDir}`], {
      stdio: "ignore",
    });
    expect(liveServerProc.pid).toBeDefined();

    try {
      await writeFile(join(hookDir, "verify-gate.config.json"), JSON.stringify({ command: "node -e \"process.exit(0)\"" }));
      const result = runGate({ hookDir, stdin: JSON.stringify({ cwd: projectDir }) });
      expect(result.status).toBe(0);

      // Give the background sweep the same window used above to do its (wrong) kill.
      await new Promise((resolve) => setTimeout(resolve, 3000));
      expect(isPidAlive(liveServerProc.pid as number)).toBe(true);
    } finally {
      liveServerProc.kill("SIGKILL");
    }
  }, 20_000);
});

describe("verify-gate-runner — bounded self-repair loop (#795)", () => {
  let hookDir: string;
  const FAIL = process.platform === "win32" ? "exit 1" : "false";
  const PASS = process.platform === "win32" ? "exit 0" : "true";
  // A failing command that also emits a recognizable error to stderr.
  const FAIL_WITH_OUTPUT =
    process.platform === "win32" ? "echo BUILD_BROKEN 1>&2 && exit 1" : "echo BUILD_BROKEN 1>&2; false";

  beforeEach(async () => {
    hookDir = await mkdtemp(join(tmpdir(), "verify-gate-loop-"));
  });
  afterEach(async () => {
    await rm(hookDir, { recursive: true, force: true });
  });

  async function writeConfig(cfg: Record<string, unknown>): Promise<void> {
    await writeFile(join(hookDir, "verify-gate.config.json"), JSON.stringify(cfg));
  }

  it("blocks for each attempt up to maxRepairAttempts, then escalates (no silent strand)", async () => {
    await writeConfig({ command: FAIL_WITH_OUTPUT, maxRepairAttempts: 2 });

    // Attempt 1 — blocks, re-prompting the builder.
    const r1 = runGate({ hookDir });
    expect(r1.status).toBe(1);
    expect(JSON.parse(r1.stdout.trim()).decision).toBe("block");
    expect(r1.stderr).toContain("Self-repair attempt 1 of 2");

    // Attempt 2 — still within budget, blocks again.
    const r2 = runGate({ hookDir });
    expect(r2.status).toBe(1);
    expect(JSON.parse(r2.stdout.trim()).decision).toBe("block");
    expect(r2.stderr).toContain("Self-repair attempt 2 of 2");

    // Budget exhausted — escalates: exits 0 (allows stop), no `block` decision,
    // and surfaces the captured error rather than silently stranding.
    const r3 = runGate({ hookDir });
    expect(r3.status).toBe(0);
    const d3 = JSON.parse(r3.stdout.trim());
    expect(d3.decision).toBeUndefined();
    expect(r3.stderr).toContain("ESCALATED");
    expect(r3.stderr).toContain("BUILD_BROKEN"); // captured error attached
  });

  it("writes an escalation file with the captured error on exhaustion", async () => {
    await writeConfig({ command: FAIL_WITH_OUTPUT, maxRepairAttempts: 1 });
    runGate({ hookDir }); // attempt 1 → block
    runGate({ hookDir }); // exhausted → escalate

    const escalationPath = join(hookDir, ".verify-gate-escalation.json");
    expect(existsSync(escalationPath)).toBe(true);
    const esc = JSON.parse(await readFile(escalationPath, "utf8"));
    expect(esc.escalated).toBe(true);
    expect(esc.attempts).toBe(1);
    expect(esc.maxRepairAttempts).toBe(1);
    expect(esc.capturedError).toContain("BUILD_BROKEN");
  });

  it("maxRepairAttempts=0 escalates immediately on the first failure (no repair pass)", async () => {
    await writeConfig({ command: FAIL_WITH_OUTPUT, maxRepairAttempts: 0 });
    const r = runGate({ hookDir });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim()).decision).toBeUndefined();
    expect(r.stderr).toContain("ESCALATED");
    expect(r.stderr).toContain("BUILD_BROKEN");
  });

  it("a passing command mid-loop clears the attempt counter so the budget resets", async () => {
    await writeConfig({ command: FAIL, maxRepairAttempts: 3 });
    runGate({ hookDir }); // attempt 1
    runGate({ hookDir }); // attempt 2
    expect(existsSync(join(hookDir, ".verify-gate-state.json"))).toBe(true);

    // Now the build passes — state must be cleared.
    await writeConfig({ command: PASS, maxRepairAttempts: 3 });
    const pass = runGate({ hookDir });
    expect(pass.status).toBe(0);
    expect(existsSync(join(hookDir, ".verify-gate-state.json"))).toBe(false);

    // A subsequent failure starts a fresh budget at attempt 1.
    await writeConfig({ command: FAIL, maxRepairAttempts: 3 });
    const again = runGate({ hookDir });
    expect(again.status).toBe(1);
    expect(again.stderr).toContain("Self-repair attempt 1 of 3");
  });

  it("defaults to 3 repair attempts when maxRepairAttempts is omitted", async () => {
    await writeConfig({ command: FAIL });
    const r1 = runGate({ hookDir });
    expect(r1.stderr).toContain("Self-repair attempt 1 of 3");
    const r2 = runGate({ hookDir });
    expect(r2.stderr).toContain("Self-repair attempt 2 of 3");
    const r3 = runGate({ hookDir });
    expect(r3.stderr).toContain("Self-repair attempt 3 of 3");
    const r4 = runGate({ hookDir });
    expect(r4.status).toBe(0);
    expect(r4.stderr).toContain("ESCALATED");
  });

  it("honors VERIFY_GATE_MAX_REPAIR_ATTEMPTS env override", async () => {
    const r1 = runGate({ hookDir, env: { VERIFY_GATE_COMMAND: FAIL, VERIFY_GATE_MAX_REPAIR_ATTEMPTS: "1" } });
    expect(r1.status).toBe(1);
    expect(r1.stderr).toContain("Self-repair attempt 1 of 1");
    const r2 = runGate({ hookDir, env: { VERIFY_GATE_COMMAND: FAIL, VERIFY_GATE_MAX_REPAIR_ATTEMPTS: "1" } });
    expect(r2.status).toBe(0);
    expect(r2.stderr).toContain("ESCALATED");
  });
});

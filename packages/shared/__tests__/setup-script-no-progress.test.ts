import { describe, it, expect } from "vitest";
import { runSetupScript, DEFAULT_NO_PROGRESS_TIMEOUT_MS } from "../src/lib/setup-script.js";

/**
 * #903 — a hung verify child (idle workers, no stdout/stderr) is invisible below the (up to 3h)
 * wall-clock `timeoutMs` ceiling. This is the earlier, cheaper no-progress backstop: kill+fail
 * once the process has produced NO output for `noProgressTimeoutMs`, distinct from a genuine
 * wall-clock timeout — a caller must be able to tell "stopped making progress" apart from
 * "still producing output but simply slow" and from "ran to completion and failed".
 */
describe("runSetupScript no-progress watchdog (#903)", () => {
  it("kills and resolves with noProgress:true when the process produces no output within the budget", async () => {
    // Long wall-clock timeout so only the no-progress watchdog can fire; a silent sleep well
    // past the tiny noProgressTimeoutMs but comfortably under the timeoutMs budget.
    const sleepScript = process.platform === "win32" ? "ping -n 10 127.0.0.1 >NUL" : "sleep 5";
    const result = await runSetupScript(process.cwd(), sleepScript, {
      timeoutMs: 60_000,
      noProgressTimeoutMs: 300,
    });
    expect(result.noProgress).toBe(true);
    expect(result.timedOut).toBeFalsy();
    expect(result.exitCode).not.toBe(0);
  }, 15000);

  it("does not fire the watchdog when the process keeps producing output", async () => {
    // Emits output in a loop, well within the no-progress budget between each emission.
    const script =
      process.platform === "win32"
        ? "for /L %i in (1,1,3) do (echo tick & ping -n 2 127.0.0.1 >NUL)"
        : "for i in 1 2 3; do echo tick; sleep 0.3; done";
    const result = await runSetupScript(process.cwd(), script, {
      timeoutMs: 15_000,
      noProgressTimeoutMs: 2000,
    });
    expect(result.noProgress).toBeFalsy();
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("tick");
  }, 15000);

  it("noProgressTimeoutMs: 0 disables the watchdog entirely", async () => {
    const sleepScript = process.platform === "win32" ? "ping -n 2 127.0.0.1 >NUL" : "sleep 1";
    const result = await runSetupScript(process.cwd(), sleepScript, {
      timeoutMs: 10_000,
      noProgressTimeoutMs: 0,
    });
    expect(result.noProgress).toBeFalsy();
    expect(result.exitCode).toBe(0);
  }, 15000);

  it("defaults noProgressTimeoutMs to DEFAULT_NO_PROGRESS_TIMEOUT_MS (15 minutes)", () => {
    expect(DEFAULT_NO_PROGRESS_TIMEOUT_MS).toBe(15 * 60 * 1000);
  });
});

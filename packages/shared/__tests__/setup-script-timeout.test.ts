import { describe, it, expect } from "vitest";
import { runSetupScript, DEFAULT_SETUP_SCRIPT_TIMEOUT_MS } from "../src/lib/setup-script.js";

/**
 * Regression for #192: a hardcoded, non-configurable 5-minute timeout became a hard
 * ceiling on project size (a cold-cache compiled-stack build routinely exceeds it) and,
 * worse, a kill was reported identically to a genuine build/test failure. Verify:
 *  - `timeoutMs` is configurable per call (no more fixed 5-minute constant),
 *  - a kill resolves the promise (never rejects) with `timedOut: true`, distinguishing
 *    "didn't finish in time" from "ran and failed".
 */
describe("runSetupScript timeout (#192)", () => {
  it("resolves with timedOut:true (never rejects) when the script exceeds the configured timeoutMs", async () => {
    const sleepScript = process.platform === "win32" ? "ping -n 5 127.0.0.1 >NUL" : "sleep 3";
    const result = await runSetupScript(process.cwd(), sleepScript, { timeoutMs: 300 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  }, 15000);

  it("timedOut is false when the script finishes within its budget", async () => {
    const result = await runSetupScript(process.cwd(), "echo ok", { timeoutMs: DEFAULT_SETUP_SCRIPT_TIMEOUT_MS });
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
  });
});

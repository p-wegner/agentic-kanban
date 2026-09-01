import { describe, it, expect } from "vitest";
import { runSetupScript } from "../src/lib/setup-script.js";

/**
 * #989 — the abort seam. The base-health probe holds the box's single verify slot for up to 45
 * minutes while its verify child runs, and a merge gate arriving a minute in queues behind it for
 * the rest. The probe therefore has to be able to KILL its own child mid-run and hand the slot
 * over, which needs an abort door on the one adapter that spawns it.
 *
 * The contract that matters is `aborted: true` + never-reject: it is the THIRD non-verdict beside
 * `timedOut` and `noProgress`, and a caller must be able to tell "we stopped it" from "it ran and
 * failed". Recording an abort as a red base would withhold every merge on the project.
 */
describe("runSetupScript abort signal (#989)", () => {
  const sleepScript = process.platform === "win32" ? "ping -n 20 127.0.0.1 >NUL" : "sleep 10";

  it("kills the child and resolves with aborted:true when the signal fires mid-run", async () => {
    const abort = new AbortController();
    const startedAt = Date.now();
    const promise = runSetupScript(process.cwd(), sleepScript, {
      timeoutMs: 60_000,
      noProgressTimeoutMs: 0,
      signal: abort.signal,
    });
    setTimeout(() => abort.abort(), 150);

    const result = await promise;
    expect(result.aborted).toBe(true);
    // Not a verdict about the script: the other two non-answers must stay off.
    expect(result.timedOut).toBeFalsy();
    expect(result.noProgress).toBeFalsy();
    expect(result.exitCode).not.toBe(0);
    // It really stopped early rather than waiting the script out (10s / 20 pings).
    expect(Date.now() - startedAt).toBeLessThan(5000);
  }, 15000);

  it("RESOLVES rather than rejecting — an abort is not a failure verdict", async () => {
    const abort = new AbortController();
    const promise = runSetupScript(process.cwd(), sleepScript, {
      timeoutMs: 60_000,
      noProgressTimeoutMs: 0,
      signal: abort.signal,
    });
    setTimeout(() => abort.abort(), 100);
    // The whole point: `.catch` in the probe maps a rejection to `exitCode: 1`, which would have
    // been recorded as a RED base — a false red withholds every merge on the project.
    await expect(promise).resolves.toMatchObject({ aborted: true });
  }, 15000);

  it("an ALREADY-aborted signal stops the run immediately", async () => {
    const result = await runSetupScript(process.cwd(), sleepScript, {
      timeoutMs: 60_000,
      noProgressTimeoutMs: 0,
      signal: AbortSignal.abort(),
    });
    expect(result.aborted).toBe(true);
  }, 15000);

  it("does not mark a run aborted when the signal never fires", async () => {
    const abort = new AbortController();
    const result = await runSetupScript(process.cwd(), "echo hello", {
      timeoutMs: 15_000,
      noProgressTimeoutMs: 0,
      signal: abort.signal,
    });
    expect(result.aborted).toBeFalsy();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello");
  }, 15000);

  it("aborting AFTER the run finished changes nothing — the promise already settled", async () => {
    const abort = new AbortController();
    const result = await runSetupScript(process.cwd(), "echo done", {
      timeoutMs: 15_000,
      noProgressTimeoutMs: 0,
      signal: abort.signal,
    });
    expect(result.exitCode).toBe(0);
    // The listener is removed on exit, so this is a no-op rather than a late resolve attempt on a
    // settled promise (harmless either way, but the removal is what keeps a long-lived signal from
    // retaining this call's buffered stdout).
    abort.abort();
    expect(result.aborted).toBeFalsy();
  }, 15000);

  it("works without a signal at all — the option is optional", async () => {
    const result = await runSetupScript(process.cwd(), "echo plain", { timeoutMs: 15_000, noProgressTimeoutMs: 0 });
    expect(result.exitCode).toBe(0);
    expect(result.aborted).toBeFalsy();
  }, 15000);
});

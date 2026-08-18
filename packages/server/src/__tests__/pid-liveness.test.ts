/**
 * #545 — one PID-liveness rule, and the half that actually mattered is EPERM.
 *
 * Four hand-rolled copies of `process.kill(pid, 0)` existed and they split two-two on what a
 * thrown EPERM means. That is not a stylistic difference: EPERM says the process EXISTS but
 * belongs to another user or is otherwise protected, so reading it as "dead" is a false
 * negative about a RUNNING agent. `startup-tasks` did exactly that and marked such an agent
 * "stopped" on every restart, resetting its workspace out from under it (#574);
 * `zombie-fix-session-reconciler` had the same polarity and would have "recovered" a session
 * whose process was still working.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { isPidAlive } from "../lib/pid.js";

function throwingKill(code: string) {
  return vi.spyOn(process, "kill").mockImplementation(() => {
    const err = new Error(code) as NodeJS.ErrnoException;
    err.code = code;
    throw err;
  });
}

afterEach(() => vi.restoreAllMocks());

describe("isPidAlive", () => {
  it("is true for a process that exists (this one)", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it("probes with signal 0, which sends nothing", () => {
    const spy = vi.spyOn(process, "kill").mockReturnValue(true);
    isPidAlive(4242);
    expect(spy).toHaveBeenCalledWith(4242, 0);
  });

  it("is false for ESRCH — no such process", () => {
    throwingKill("ESRCH");
    expect(isPidAlive(4242)).toBe(false);
  });

  it("is TRUE for EPERM — the process exists, we just may not signal it", () => {
    throwingKill("EPERM");
    expect(isPidAlive(4242)).toBe(true);
  });

  it("is false for an unexpected error — only EPERM proves existence", () => {
    throwingKill("EINVAL");
    expect(isPidAlive(4242)).toBe(false);
  });

  it("is false when the error carries no code at all", () => {
    vi.spyOn(process, "kill").mockImplementation(() => { throw new Error("boom"); });
    expect(isPidAlive(4242)).toBe(false);
  });
});

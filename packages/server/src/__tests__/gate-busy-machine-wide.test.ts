import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGateBusy, isBaseHealthProbeDue } from "../services/base-branch-health-reprobe.service.js";
import {
  MACHINE_LOCK_DIR_ENV,
  MACHINE_LOCK_ENV,
  MACHINE_LOCK_STALE_MS,
  machineVerifyLockPath,
} from "../lib/machine-verify-lock.js";

/**
 * #957's third design question: a machine-wide lock OVERLAPS #931's `buildGateBusy()` signal, and
 * the two should be RECONCILED rather than stacked.
 *
 * They are reconciled into one function. `gateBusy` keeps meaning exactly what it meant —
 * "heavyweight verification is running right now, so the probe yields" — and only its REACH
 * changed: it can now see a holder in another process, which is precisely the blindness the
 * ticket exists to remove. A separate `machineLockBusy` input would have forced every caller to
 * re-derive the same disjunction, which is how two signals drift into disagreeing.
 */
describe("resolveGateBusy: one signal, machine-wide (#957 / #931)", () => {
  let lockDir: string;

  const writeHolder = (over: Record<string, unknown> = {}) =>
    writeFileSync(
      machineVerifyLockPath(),
      JSON.stringify({
        pid: process.pid,
        hostname: hostname(),
        role: "gate",
        holder: "another process's gate",
        acquiredAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        ...over,
      }),
    );

  beforeEach(() => {
    lockDir = mkdtempSync(join(tmpdir(), "ak-gate-busy-"));
    process.env[MACHINE_LOCK_DIR_ENV] = lockDir;
  });
  afterEach(() => {
    delete process.env[MACHINE_LOCK_ENV];
    delete process.env[MACHINE_LOCK_DIR_ENV];
    rmSync(lockDir, { recursive: true, force: true });
  });

  it("is false on a quiet box", () => {
    expect(resolveGateBusy()).toBe(false);
  });

  it("ignores the machine lock entirely while the switch is off", () => {
    writeHolder({ pid: 1 });
    expect(resolveGateBusy()).toBe(false);
  });

  it("is TRUE when another process holds the machine lock — the #957 blind spot, now seen", () => {
    process.env[MACHINE_LOCK_ENV] = "1";
    // pid 1 always exists and is not us, so this reads as a live holder in another process.
    writeHolder({ pid: 1 });
    expect(resolveGateBusy()).toBe(true);
  });

  it("does NOT count a lock held by our OWN pid — that is already what buildGateBusy reports", () => {
    process.env[MACHINE_LOCK_ENV] = "1";
    writeHolder({ pid: process.pid });
    // Double-counting our own holder would make a probe that legitimately holds the lock
    // consider itself busy and yield to itself.
    expect(resolveGateBusy()).toBe(false);
  });

  it("does NOT count a stale, provably-dead holder — a crashed process must not starve the probe", () => {
    process.env[MACHINE_LOCK_ENV] = "1";
    writeHolder({
      pid: 0x7ffffffe, // unreachable -> ESRCH -> dead
      heartbeatAt: new Date(Date.now() - MACHINE_LOCK_STALE_MS - 60_000).toISOString(),
    });
    expect(resolveGateBusy()).toBe(false);
  });

  it("feeds the probe decision: a machine-wide busy gate defers it, exactly as an in-process one did", () => {
    // The decision function is unchanged — this is the point of reconciling into ONE input.
    expect(isBaseHealthProbeDue({ nowMs: Date.now(), intervalMs: 1000, gateBusy: true })).toEqual({
      due: false,
      reason: "gate_running",
    });
    // Deferred, never starved: with the gate quiet, the same input is due again.
    expect(isBaseHealthProbeDue({ nowMs: Date.now(), intervalMs: 1000, gateBusy: false }).due).toBe(true);
  });
});

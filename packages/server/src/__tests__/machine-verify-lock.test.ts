import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  MACHINE_LOCK_DIR_ENV,
  MACHINE_LOCK_ENV,
  MACHINE_LOCK_LIVE_HOLDER_MAX_MS,
  MACHINE_LOCK_STALE_MS,
  MACHINE_VERIFY_ROLES,
  acquireMachineVerifyLock,
  attemptMachineVerifyLock,
  inspectMachineVerifyLock,
  machineVerifyLockEnabled,
  machineVerifyLockPath,
  withMachineVerifyLock,
} from "../lib/machine-verify-lock.js";

/**
 * #957 — the verify-chain semaphore is in-process only, so a builder agent's own test run, a
 * worktree dev server and a second board process were all invisible to it. This is the
 * cross-process, machine-scoped lock that closes that, in `repo-lock.ts`'s shape but keyed on
 * the machine rather than on a repoPath.
 *
 * The acceptance criterion these suites encode: two independent acquirers are observably
 * SERIALIZED (not merely both slowed), and one that cannot acquire within its bound SAYS SO
 * rather than proceeding silently.
 */

let lockDir: string;

beforeEach(() => {
  lockDir = mkdtempSync(join(tmpdir(), "ak-machine-lock-"));
  process.env[MACHINE_LOCK_DIR_ENV] = lockDir;
  process.env[MACHINE_LOCK_ENV] = "1";
});

afterEach(() => {
  delete process.env[MACHINE_LOCK_DIR_ENV];
  delete process.env[MACHINE_LOCK_ENV];
  rmSync(lockDir, { recursive: true, force: true });
});

/** Write a lockfile as if some OTHER process held it. */
function plantForeignHolder(over: Partial<Record<string, unknown>> = {}) {
  const contents = {
    // A pid that cannot exist, so the same-host probe reports ESRCH ("dead") unless overridden.
    pid: 0x7ffffffe,
    hostname: hostname(),
    role: "gate",
    holder: "someone else",
    acquiredAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    ...over,
  };
  writeFileSync(machineVerifyLockPath(), JSON.stringify(contents));
  return contents;
}

describe("machine-verify-lock: the switch", () => {
  it("is off unless explicitly enabled — an unset box behaves exactly as before", () => {
    expect(machineVerifyLockEnabled({})).toBe(false);
    expect(machineVerifyLockEnabled({ [MACHINE_LOCK_ENV]: "" })).toBe(false);
    expect(machineVerifyLockEnabled({ [MACHINE_LOCK_ENV]: "0" })).toBe(false);
    expect(machineVerifyLockEnabled({ [MACHINE_LOCK_ENV]: "false" })).toBe(false);
    for (const on of ["1", "true", "yes", "YES"]) {
      expect(machineVerifyLockEnabled({ [MACHINE_LOCK_ENV]: on })).toBe(true);
    }
  });

  it("runs the work directly, with no note, when disabled", async () => {
    delete process.env[MACHINE_LOCK_ENV];
    const res = await withMachineVerifyLock(MACHINE_VERIFY_ROLES.gate, "g", async () => "done");
    expect(res.ran).toBe(true);
    expect(res.ran && res.result).toBe("done");
    expect(res.lockNote).toBeNull();
    // Nothing was written — a disabled lock leaves no trace on the box.
    expect(existsSync(machineVerifyLockPath())).toBe(false);
  });
});

describe("machine-verify-lock: acquisition", () => {
  it("acquires when free, and records pid/host/role so a waiter can name the holder", () => {
    const attempt = attemptMachineVerifyLock(MACHINE_VERIFY_ROLES.gate, "workspace-42");
    expect(attempt.outcome).toBe("acquired");
    const written = JSON.parse(readFileSync(machineVerifyLockPath(), "utf8"));
    expect(written.pid).toBe(process.pid);
    expect(written.hostname).toBe(hostname());
    expect(written.role).toBe("gate");
    expect(written.holder).toBe("workspace-42");
  });

  it("REFUSES a second acquisition while a live holder exists — this is the serialization", () => {
    plantForeignHolder({ pid: process.pid }); // our own pid: provably alive
    const second = attemptMachineVerifyLock(MACHINE_VERIFY_ROLES.gate, "second");
    expect(second.outcome).toBe("contended");
  });

  it("releases only its own lock, never someone else's", () => {
    const attempt = attemptMachineVerifyLock(MACHINE_VERIFY_ROLES.gate, "mine");
    if (attempt.outcome !== "acquired") throw new Error("expected to acquire");
    // Someone else reclaimed and re-acquired in the meantime. Ownership is `pid + acquiredAt`,
    // so the planted record must differ in at least one of them — and `acquiredAt` has only
    // millisecond resolution, so defaulting it to `now` collides with the acquire above on a
    // fast machine and this test then "proves" the opposite of its name (observed as a flake).
    // Pinning an explicitly older timestamp makes the distinctness a property of the test rather
    // than of the clock. Deliberately keeping OUR pid: it isolates `acquiredAt` as the
    // discriminator, which is the half a same-pid reclaim actually turns on.
    plantForeignHolder({
      pid: process.pid,
      holder: "someone else",
      acquiredAt: new Date(Date.now() - 5_000).toISOString(),
    });
    attempt.handle.release();
    expect(existsSync(machineVerifyLockPath())).toBe(true);
    expect(JSON.parse(readFileSync(machineVerifyLockPath(), "utf8")).holder).toBe("someone else");
  });

  it("reclaims a lock whose same-host holder pid is confirmed DEAD, even inside the staleness window", () => {
    plantForeignHolder(); // unreachable pid -> ESRCH -> dead, fresh heartbeat
    const status = inspectMachineVerifyLock();
    expect(status?.ownerProcessDead).toBe(true);
    expect(status?.isStale).toBe(false);
    expect(attemptMachineVerifyLock(MACHINE_VERIFY_ROLES.gate, "next").outcome).toBe("acquired");
  });

  it("refuses to steal a STALE-heartbeat lock whose holder is provably alive", () => {
    // Our own pid is alive; heartbeat far past the staleness window but inside the live bound.
    plantForeignHolder({
      pid: process.pid,
      heartbeatAt: new Date(Date.now() - MACHINE_LOCK_STALE_MS - 60_000).toISOString(),
    });
    const status = inspectMachineVerifyLock();
    expect(status?.isStale).toBe(true);
    expect(status?.ownerProcessAlive).toBe(true);
    const attempt = attemptMachineVerifyLock(MACHINE_VERIFY_ROLES.gate, "thief");
    expect(attempt.outcome).toBe("contended");
    expect(attempt.outcome === "contended" && attempt.reason).toMatch(/ALIVE/);
  });

  it("DOES reclaim a provably-alive holder past the live-holder bound, so a recycled pid cannot wedge the box", () => {
    plantForeignHolder({
      pid: process.pid,
      heartbeatAt: new Date(Date.now() - MACHINE_LOCK_LIVE_HOLDER_MAX_MS - 60_000).toISOString(),
    });
    expect(attemptMachineVerifyLock(MACHINE_VERIFY_ROLES.gate, "next").outcome).toBe("acquired");
  });

  it("DISCARDS an unreadable lockfile rather than blocking the box forever", () => {
    // A truncated / half-written / hand-edited lockfile names no holder, so nobody can judge it
    // stale and nobody could ever reclaim it — reporting contention here wedges every verifier
    // on the machine permanently. An unreadable lock protects nothing, so it is replaced.
    writeFileSync(machineVerifyLockPath(), "{ not json");
    expect(inspectMachineVerifyLock()).toBeNull();
    const attempt = attemptMachineVerifyLock(MACHINE_VERIFY_ROLES.gate, "next");
    expect(attempt.outcome).toBe("acquired");
    expect(JSON.parse(readFileSync(machineVerifyLockPath(), "utf8")).holder).toBe("next");
  });

  it("an empty (mid-write) lockfile is discarded the same way", () => {
    writeFileSync(machineVerifyLockPath(), "");
    expect(attemptMachineVerifyLock(MACHINE_VERIFY_ROLES.gate, "next").outcome).toBe("acquired");
  });

  it("a HEARTBEAT never leaves the lockfile momentarily unreadable — the torn-write race", () => {
    // The reason `writeLockFile` uses a temp file + `renameSync` for every rewrite. `writeFileSync`
    // TRUNCATES and then writes, so a concurrent acquirer reading in that window sees a partial
    // record, judges it corrupt, and takes the discard path above — deleting a LIVE holder's lock
    // and acquiring beside it. Measured: two processes both acquired. The discard path is correct
    // and must stay, so the safety has to come from the write never being observable half-done.
    //
    // A single-threaded test CANNOT catch this by reading the file back — the window it is about
    // does not exist between two synchronous statements, so an in-place write passes such a check
    // just as happily (verified: it does). The discriminating property is HOW the swap happens:
    // an atomic rewrite REPLACES the file, so the live path gets a NEW identity each heartbeat,
    // while a truncate-then-write keeps the same one. `ino` is that identity on POSIX; on Windows
    // it is not maintained, so `birthtimeMs` carries the same "this is a different file" signal.
    const held = attemptMachineVerifyLock(MACHINE_VERIFY_ROLES.gate, "the-holder");
    if (held.outcome !== "acquired") throw new Error("expected to acquire");
    const lockPath = machineVerifyLockPath();
    const identity = () => {
      const s = statSync(lockPath);
      return `${s.ino}:${s.birthtimeMs}`;
    };
    try {
      const before = identity();
      held.handle.heartbeat();
      const after = identity();
      // Replaced, not rewritten in place — the file the reader may be holding open is never the
      // one being mutated, which is precisely what closes the race.
      expect(after).not.toBe(before);
      // ...and it still reads back as a complete record naming us.
      expect(inspectMachineVerifyLock()?.contents.holder).toBe("the-holder");
      // No temp file is left behind to be mistaken for a lock.
      expect(existsSync(`${lockPath}.${process.pid}.tmp`)).toBe(false);
    } finally {
      held.handle.release();
    }
  });

  it("a cross-host holder is neither dead nor alive, so it waits out the heartbeat instead", () => {
    plantForeignHolder({ hostname: "some-other-box" });
    const status = inspectMachineVerifyLock();
    expect(status?.ownerProcessDead).toBe(false);
    expect(status?.ownerProcessAlive).toBe(false);
    // Fresh heartbeat + unprovable liveness = contended, exactly as repo-lock behaves.
    expect(attemptMachineVerifyLock(MACHINE_VERIFY_ROLES.gate, "next").outcome).toBe("contended");
  });
});

describe("machine-verify-lock: SERIALIZATION (the acceptance criterion)", () => {
  it("two independent acquirers do not overlap — the second's region starts after the first's ends", async () => {
    const events: string[] = [];
    let releaseFirst: () => void = () => {};
    const firstHeld = new Promise<void>((r) => { releaseFirst = r; });

    const first = withMachineVerifyLock(MACHINE_VERIFY_ROLES.gate, "first", async () => {
      events.push("first-enter");
      await firstHeld;
      events.push("first-exit");
    });

    // Let the first actually take the lock before the second tries.
    await new Promise((r) => setTimeout(r, 20));

    const second = withMachineVerifyLock(
      MACHINE_VERIFY_ROLES.gate,
      "second",
      async () => { events.push("second-enter"); },
      { pollMs: 5 },
    );

    // While the first holds it, the second must be WAITING — not running slowly, not running.
    await new Promise((r) => setTimeout(r, 40));
    expect(events).toEqual(["first-enter"]);

    releaseFirst();
    await Promise.all([first, second]);

    expect(events).toEqual(["first-enter", "first-exit", "second-enter"]);
  });

  it("reports the wait to the acquirer that queued, and zero to the one that did not", async () => {
    let releaseFirst: () => void = () => {};
    const firstHeld = new Promise<void>((r) => { releaseFirst = r; });
    const first = withMachineVerifyLock(MACHINE_VERIFY_ROLES.gate, "first", async () => { await firstHeld; });
    await new Promise((r) => setTimeout(r, 20));
    const second = withMachineVerifyLock(MACHINE_VERIFY_ROLES.gate, "second", async () => "ok", { pollMs: 5 });
    await new Promise((r) => setTimeout(r, 40));
    releaseFirst();
    const [a, b] = await Promise.all([first, second]);
    // `waitedMs` is wall-clock around the acquire, so an UNCONTENDED one is not exactly 0 — it
    // is however small. The distinction that matters is queued-vs-not, and the second waited out
    // a ~40ms hold, so the two are separated by an order of magnitude, not by a tie-break.
    expect(a.waitedMs).toBeLessThan(20);
    expect(b.waitedMs).toBeGreaterThan(20);
  });

  it("releases the lock even when the work throws, so one failure cannot wedge the machine", async () => {
    await expect(
      withMachineVerifyLock(MACHINE_VERIFY_ROLES.gate, "boom", async () => { throw new Error("boom"); }),
    ).rejects.toThrow("boom");
    expect(existsSync(machineVerifyLockPath())).toBe(false);
    // And the next acquirer gets in immediately.
    const next = await withMachineVerifyLock(MACHINE_VERIFY_ROLES.gate, "next", async () => "fine");
    expect(next.ran && next.result).toBe("fine");
  });
});

describe("machine-verify-lock: a process that cannot acquire SAYS SO", () => {
  /** A holder that is never released, so every wait below runs to its deadline. */
  const holdForever = () => plantForeignHolder({ pid: process.pid });

  it("a `proceed` role runs anyway and returns a note naming the holder it could not outlast", async () => {
    holdForever();
    const logs: string[] = [];
    const outcome = await acquireMachineVerifyLock(MACHINE_VERIFY_ROLES.gate, "queued-gate", {
      waitMs: 30,
      pollMs: 5,
      log: (m) => logs.push(m),
    });
    expect(outcome.acquired).toBe(false);
    expect(outcome.acquired === false && outcome.proceed).toBe(true);
    expect(outcome.note).toMatch(/UNSERIALIZED/);
    expect(outcome.note).toContain("someone else");
    // Not silent: it also said so on the way past.
    expect(logs.join("\n")).toMatch(/UNSERIALIZED/);
  });

  it("a `skip` role does NOT run, and says why", async () => {
    holdForever();
    const outcome = await acquireMachineVerifyLock(MACHINE_VERIFY_ROLES.probe, "base-probe", {
      waitMs: 30,
      pollMs: 5,
      log: () => {},
    });
    expect(outcome.acquired).toBe(false);
    expect(outcome.acquired === false && outcome.proceed).toBe(false);
    expect(outcome.note).toMatch(/SKIPPED/);
  });

  it("withMachineVerifyLock surfaces the note on a proceed, and does not run the work on a skip", async () => {
    holdForever();
    let gateRan = false;
    const gate = await withMachineVerifyLock(
      MACHINE_VERIFY_ROLES.gate,
      "g",
      async () => { gateRan = true; return "v"; },
      { waitMs: 30, pollMs: 5, log: () => {} },
    );
    expect(gateRan).toBe(true);
    expect(gate.ran).toBe(true);
    expect(gate.lockNote).toMatch(/UNSERIALIZED/);

    let probeRan = false;
    const probe = await withMachineVerifyLock(
      MACHINE_VERIFY_ROLES.probe,
      "p",
      async () => { probeRan = true; return "v"; },
      { waitMs: 30, pollMs: 5, log: () => {} },
    );
    expect(probeRan).toBe(false);
    expect(probe.ran).toBe(false);
    expect(probe.lockNote).toMatch(/SKIPPED/);
  });

  it("an UNAVAILABLE lock path never blocks verification — it proceeds, loudly", async () => {
    const logs: string[] = [];
    const outcome = await acquireMachineVerifyLock(MACHINE_VERIFY_ROLES.gate, "g", {
      // A path that can never be locked. The distinction that matters (repo-lock's #230): this
      // is NOT contention, so waiting can never fix it and the caller must not poll forever.
      attempt: () => ({ outcome: "unavailable", code: "EACCES", reason: "denied" }),
      waitMs: 60_000,
      pollMs: 5,
      log: (m) => logs.push(m),
    });
    expect(outcome.acquired).toBe(false);
    expect(outcome.acquired === false && outcome.proceed).toBe(true);
    // It did not wait out the 60s bound — it returned at once.
    expect(outcome.waitedMs).toBeLessThan(1000);
    expect(logs.join("\n")).toMatch(/UNAVAILABLE/);
  });
});

describe("machine-verify-lock: the role table (#957's wait-timeout question)", () => {
  it("declares a distinct bound per role — one number does not serve all three", () => {
    const waits = Object.values(MACHINE_VERIFY_ROLES).map((r) => r.waitMs);
    expect(new Set(waits).size).toBe(waits.length);
    // The ordering IS the argument: a gate's verdict gates a merge, a builder's inner loop must
    // not stall a ticket, and the probe is the least urgent spawner and yields first (#931).
    expect(MACHINE_VERIFY_ROLES.gate.waitMs).toBeGreaterThan(MACHINE_VERIFY_ROLES["builder-test"].waitMs);
    expect(MACHINE_VERIFY_ROLES["builder-test"].waitMs).toBeGreaterThan(MACHINE_VERIFY_ROLES.probe.waitMs);
  });

  it("only the probe skips; work whose result is awaited proceeds and labels itself", () => {
    expect(MACHINE_VERIFY_ROLES.probe.onTimeout).toBe("skip");
    expect(MACHINE_VERIFY_ROLES.gate.onTimeout).toBe("proceed");
    expect(MACHINE_VERIFY_ROLES["builder-test"].onTimeout).toBe("proceed");
  });

  it("every role carries a rationale — a bound with no argument cannot be reviewed", () => {
    for (const [key, role] of Object.entries(MACHINE_VERIFY_ROLES)) {
      expect(role.name, `role "${key}" name must match its key`).toBe(key);
      expect(role.rationale.length, `role "${key}" needs a real rationale`).toBeGreaterThan(40);
    }
  });

  it("no role can wait longer than the live-holder reclaim bound, or the lock could wedge", () => {
    for (const role of Object.values(MACHINE_VERIFY_ROLES)) {
      expect(role.waitMs).toBeLessThan(MACHINE_LOCK_LIVE_HOLDER_MAX_MS);
    }
  });
});

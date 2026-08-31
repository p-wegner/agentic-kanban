// A DELIBERATE MIRROR of `packages/shared/src/lib/machine-verify-lock.ts` (#957).
//
// Why a mirror rather than an import â€” the same reason `test-mine.mjs` states for
// `isAlwaysRunMarked`, and it is a hard constraint, not a preference: `test-mine.mjs` runs as
// bare `node scripts/test-mine.mjs` with no build step and no guarantee that
// `packages/shared/dist` exists â€” worktrees frequently do not have it. A test runner that
// cannot run until something is built is a bootstrap problem. The shared module cannot import
// this one either: `packages/server` ships only `dist/`, so a published install importing a
// repo-root script would crash on load.
//
// So the ON-DISK PROTOCOL is the contract, and `machine-verify-lock-mirror.test.ts` holds the two
// implementations to it with real lockfiles rather than by comment â€” a lock whose two halves
// disagree about the file format is a lock that serializes nothing while appearing to work,
// which is strictly worse than no lock at all.
//
// This half implements only what a builder's `pnpm test:mine` needs: acquire with a bound,
// heartbeat, release, and SAY SO when it could not acquire. It has no role table (it is always
// the `builder-test` role) and no skip path (a builder always proceeds).

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

/** Must equal `LOCK_FILE_NAME` in the shared module. Pinned by the mirror test. */
export const LOCK_FILE_NAME = "agentic-kanban-machine-verify.lock";

/** Must equal `MACHINE_LOCK_STALE_MS` in the shared module. */
export const MACHINE_LOCK_STALE_MS = 60 * 1000;

/** Must equal `MACHINE_LOCK_LIVE_HOLDER_MAX_MS` in the shared module. */
export const MACHINE_LOCK_LIVE_HOLDER_MAX_MS = 4 * 60 * 60 * 1000;

/** Must equal `MACHINE_LOCK_HEARTBEAT_INTERVAL_MS` in the shared module. */
export const MACHINE_LOCK_HEARTBEAT_INTERVAL_MS = 15 * 1000;

export const MACHINE_LOCK_ENV = "KANBAN_MACHINE_VERIFY_LOCK";
export const MACHINE_LOCK_DIR_ENV = "KANBAN_MACHINE_VERIFY_LOCK_DIR";

/**
 * The `builder-test` role's bound, mirroring `MACHINE_VERIFY_ROLES["builder-test"]`.
 *
 * Short on purpose, and this is the ticket's "one number will not serve all three": a builder
 * blocked for a gate's full duration has stopped being a builder. It waits a bounded while and
 * then runs anyway, having said that it is running unserialized.
 */
export const BUILDER_TEST_WAIT_MS = 20 * 60 * 1000;

export const ROLE_NAME = "builder-test";

export function machineVerifyLockEnabled(env = process.env) {
  return /^(1|true|yes)$/i.test((env[MACHINE_LOCK_ENV] || "").trim());
}

export function machineVerifyLockPath(env = process.env) {
  const dir = (env[MACHINE_LOCK_DIR_ENV] || "").trim() || tmpdir();
  return join(dir, LOCK_FILE_NAME);
}

/** Parse a lockfile, returning null for anything that is not a complete record. */
export function readLockContents(lockPath) {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8"));
    const complete =
      typeof parsed?.pid === "number" &&
      typeof parsed?.hostname === "string" &&
      typeof parsed?.role === "string" &&
      typeof parsed?.holder === "string" &&
      typeof parsed?.acquiredAt === "string" &&
      typeof parsed?.heartbeatAt === "string";
    return complete ? parsed : null;
  } catch {
    return null;
  }
}

/** Same tri-state as the shared module: "dead" | "alive" | "unknown". */
function probeHolderProcess(contents) {
  if (contents.hostname !== hostname()) return "unknown";
  try {
    process.kill(contents.pid, 0);
    return "alive";
  } catch (err) {
    return err?.code === "ESRCH" ? "dead" : "unknown";
  }
}

export function inspectMachineVerifyLock(nowMs = Date.now(), env = process.env) {
  const lockPath = machineVerifyLockPath(env);
  if (!existsSync(lockPath)) return null;
  const contents = readLockContents(lockPath);
  if (!contents) return null;
  const heartbeatMs = Date.parse(contents.heartbeatAt);
  const ageMs = Number.isNaN(heartbeatMs) ? Number.POSITIVE_INFINITY : Math.max(0, nowMs - heartbeatMs);
  const probe = probeHolderProcess(contents);
  return {
    path: lockPath,
    contents,
    ageMs,
    isStale: ageMs > MACHINE_LOCK_STALE_MS,
    ownerProcessDead: probe === "dead",
    ownerProcessAlive: probe === "alive",
  };
}

/** One acquisition attempt. Mirrors `attemptMachineVerifyLock`'s three outcomes. */
export function attemptMachineVerifyLock(holder, nowMs = Date.now(), env = process.env) {
  const lockPath = machineVerifyLockPath(env);
  const existing = inspectMachineVerifyLock(nowMs, env);
  if (existing) {
    if (!existing.isStale && !existing.ownerProcessDead) {
      return { outcome: "contended", reason: describeHolder(existing) };
    }
    // A stale heartbeat is only presumptive evidence of death; a provably-alive holder is
    // mid-verify and merely lagged. Stealing there is what the whole lock exists to prevent.
    if (existing.ownerProcessAlive && existing.ageMs <= MACHINE_LOCK_LIVE_HOLDER_MAX_MS) {
      return {
        outcome: "contended",
        reason: `stale-heartbeat lock refused: holder pid=${existing.contents.pid} is ALIVE on this host (heartbeat age ${Math.round(existing.ageMs / 1000)}s)`,
      };
    }
    const current = readLockContents(lockPath);
    if (!current || JSON.stringify(current) !== JSON.stringify(existing.contents)) {
      return { outcome: "contended", reason: "another acquirer recovered or reacquired the stale lock first" };
    }
    try {
      rmSync(lockPath, { force: true });
    } catch (err) {
      return {
        outcome: "unavailable",
        code: err?.code ?? "UNKNOWN",
        reason: `the stale lockfile ${lockPath} could not be removed (${err?.code ?? "UNKNOWN"})`,
      };
    }
  }

  const contents = {
    pid: process.pid,
    hostname: hostname(),
    role: ROLE_NAME,
    holder,
    acquiredAt: new Date(nowMs).toISOString(),
    heartbeatAt: new Date(nowMs).toISOString(),
  };
  try {
    mkdirSync(join(lockPath, ".."), { recursive: true });
    writeLockFile(lockPath, contents, "wx");
  } catch (err) {
    if (err?.code === "EEXIST") {
      // A file exists but `inspectMachineVerifyLock` read no holder from it â€” corrupt, not held.
      // Left as contention it wedges every verifier on the box permanently: nobody can parse it,
      // so nobody can judge it stale, so nobody can ever reclaim it. Mirrors the shared module.
      // Read TWICE â€” a single read can catch a WRITE in progress, and treating a torn read as
      // corruption is how two racing processes both acquired (measured). `writeLockFile` makes
      // every rewrite atomic, so this second read only has to cover a file written by an older
      // build: a genuinely corrupt file is corrupt in both reads, a torn one is not.
      if (!existing && readLockContents(lockPath) === null && readLockContents(lockPath) === null) {
        try {
          rmSync(lockPath, { force: true });
          writeLockFile(lockPath, contents, "wx");
          console.warn(`[machine-verify-lock] discarded an unreadable lockfile at ${lockPath} and acquired`);
          return { outcome: "acquired", handle: buildHandle(lockPath, contents) };
        } catch (retryErr) {
          if (retryErr?.code === "EEXIST") {
            return { outcome: "contended", reason: "another acquirer took the lock while an unreadable one was being discarded" };
          }
          return {
            outcome: "unavailable",
            code: retryErr?.code ?? "UNKNOWN",
            reason: `an unreadable lockfile at ${lockPath} could not be replaced (${retryErr?.code ?? "UNKNOWN"})`,
          };
        }
      }
      return { outcome: "contended", reason: "lost the race to another acquirer (EEXIST)" };
    }
    return {
      outcome: "unavailable",
      code: err?.code ?? "UNKNOWN",
      reason: `the lockfile ${lockPath} could not be written (${err?.code ?? "UNKNOWN"})`,
    };
  }

  return { outcome: "acquired", handle: buildHandle(lockPath, contents) };
}

/**
 * Write the lock record so a concurrent reader can never see it half-written. Mirrors the server
 * module: `"wx"` goes straight to the target (exclusive creation IS the atomic primitive, and a
 * rename would clobber a lock somebody else won), every other write goes via a pid-unique temp
 * file and an atomic `rename`. `writeFileSync` truncates before writing, so a reader landing in
 * that window sees a partial record â€” which is how two racing processes both acquired.
 */
function writeLockFile(lockPath, contents, flag) {
  if (flag === "wx") {
    writeFileSync(lockPath, JSON.stringify(contents), { flag: "wx" });
    return;
  }
  const tmp = `${lockPath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(contents));
  renameSync(tmp, lockPath);
}

/**
 * The handle over a lockfile we just wrote. Heartbeat and release both re-read first and no-op
 * unless it is still ours, so a reclaimed handle can never revive or delete someone else's lock.
 */
function buildHandle(lockPath, contents) {
  const stillOurs = () => {
    const current = readLockContents(lockPath);
    return !!current && current.pid === contents.pid && current.acquiredAt === contents.acquiredAt;
  };
  return {
    path: lockPath,
    contents,
    heartbeat: () => {
      if (!stillOurs()) return;
      contents.heartbeatAt = new Date().toISOString();
      try {
        writeLockFile(lockPath, contents);
      } catch {
        // Best-effort â€” a failed heartbeat only makes staleness recovery kick in sooner.
      }
    },
    release: () => {
      if (!stillOurs()) return;
      try {
        rmSync(lockPath, { force: true });
      } catch {
        // Best-effort.
      }
    },
  };
}

export function describeHolder(status) {
  const heldForS = Math.round(Math.max(0, Date.now() - Date.parse(status.contents.acquiredAt)) / 1000);
  return (
    `${status.contents.role} "${status.contents.holder}" (pid=${status.contents.pid} ` +
    `host=${status.contents.hostname}, holding for ${heldForS}s)`
  );
}

/**
 * Acquire for a builder's own test run, bounded by {@link BUILDER_TEST_WAIT_MS}.
 *
 * Resolves to `{ handle, note }`. `note` is non-null exactly when the run is proceeding WITHOUT
 * the lock â€” the caller MUST print it. That is the ticket's acceptance criterion: a process that
 * cannot acquire within its timeout says so rather than proceeding silently.
 *
 * Never throws and never blocks forever: a builder that cannot verify is worse than a builder
 * that verifies under contention and labels the result.
 */
export async function acquireForBuilderTest(
  holder,
  {
    waitMs = BUILDER_TEST_WAIT_MS,
    pollMs = 2000,
    // No injected clock seam here on purpose. The wait is bounded by `waitMs` and driven by the
    // injectable `sleep`/`attempt` seams, which is all the tests need — and a `now: () => number`
    // parameter would add a fifth use of a spelling that `time-injection-spelling-ratchet.test.ts`
    // grandfathers shrink-only (#614/#721). Reading `Date.now()` inline keeps the sanctioned
    // vocabulary intact rather than growing a baseline that exists to shrink.
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    attempt = (h) => attemptMachineVerifyLock(h),
    log = (m) => console.log(m),
    env = process.env,
  } = {},
) {
  if (!machineVerifyLockEnabled(env)) return { handle: null, note: null };
  const startedAt = Date.now();
  const deadline = startedAt + waitMs;
  let announced = false;
  for (;;) {
    const res = attempt(holder);
    if (res.outcome === "acquired") {
      if (announced) {
        log(`[machine-verify-lock] ${ROLE_NAME} "${holder}" acquired the machine lock after ${Math.round((Date.now() - startedAt) / 1000)}s queued`);
      }
      return { handle: res.handle, note: null };
    }
    if (res.outcome === "unavailable") {
      const note =
        `[machine-verify-lock] the machine-wide verify lock is UNAVAILABLE on this box ` +
        `(${res.code}) â€” this test run is UNSERIALIZED against any other verification here. ${res.reason}`;
      log(note);
      return { handle: null, note };
    }
    if (!announced) {
      announced = true;
      log(
        `[machine-verify-lock] ${ROLE_NAME} "${holder}" is QUEUED behind ${res.reason} â€” ` +
          `serializing across processes, because N full suites at 1/N speed finish no sooner and ` +
          `starve each other (#957). Waiting up to ${Math.round(waitMs / 1000)}s.`,
      );
    }
    if (Date.now() >= deadline) {
      const note =
        `[machine-verify-lock] ran UNSERIALIZED: waited ${Math.round((Date.now() - startedAt) / 1000)}s for the ` +
        `machine verify lock (held by ${res.reason}) and proceeded anyway â€” these results were produced ` +
        `while another heavyweight verification was running on this box.`;
      log(note);
      return { handle: null, note };
    }
    await sleep(pollMs);
  }
}

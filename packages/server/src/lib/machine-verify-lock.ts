import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

/**
 * Cross-process, MACHINE-scoped lock for heavyweight verification (#957).
 *
 * `services/verify-chain-semaphore.ts` (#903/#949) serializes every heavyweight verification the
 * SERVER PROCESS runs — the gate's verify chain, the boot/render smoke check, the E2E lane, the
 * base-health probe. It is plain in-process module state (`let active`, `waiters[]`), so three
 * real consumers on one box are invisible to it:
 *
 *   1. a BUILDER AGENT running its own `pnpm test:mine` — a separate process tree, and with WIP
 *      2-3 the single largest uncounted load;
 *   2. a WORKTREE DEV SERVER (`pnpm dev` in `.worktrees/...`) running its own gate/probe;
 *   3. a SECOND BOARD SERVER at all (a tsx-watch restart overlap).
 *
 * So a 16-core box could sit at 100% CPU with one gate correctly serialized and three
 * unserialized test runners beside it — the live symptom #949 was filed against, with only the
 * board's own contribution bounded.
 *
 * WHY IT LIVES IN `packages/server/src/lib` and not in `shared/lib`: only this package consumes
 * it (#730's single-consumer rule — `shared/lib` is for code more than one package needs, and a
 * module parked there costs a second package on every commit that touches it). The `scripts/`
 * mirror is not a package consumer: it deliberately re-implements the protocol rather than
 * importing anything, because `test-mine.mjs` runs as bare `node` in worktrees that have no
 * built `dist/`. See `machine-verify-lock-mirror.test.ts`, which binds the two to one protocol.
 *
 * This is `shared/lib/repo-lock.ts`'s shape keyed on the MACHINE rather than on a `repoPath`, because the
 * contended resource is the box: three processes verifying three DIFFERENT repos starve each
 * other exactly as much as three verifying one. Everything about the on-disk protocol is
 * deliberately identical to `repo-lock` — atomic `wx` creation, a pid/hostname/heartbeat record,
 * heartbeat staleness as the host-agnostic death signal, and the same tri-state pid probe so a
 * confirmed-dead holder is reclaimed at once while a provably-alive one is never stolen from.
 *
 * THREE THINGS ARE DELIBERATELY DIFFERENT, and they are the ticket's open design questions:
 *
 * - **Where it lives.** Not under a `.git` (there is no one repo), but a single file in the OS
 *   temp dir. That is per-machine and per-boot, which is the right lifetime: a lock is only ever
 *   meaningful while the processes holding it exist.
 *
 * - **The wait timeout is PER ROLE, not one number.** `repo-lock`'s 90-minute default is tuned
 *   for a merge. A queued gate behind two others plausibly wants longer; a builder's `test:mine`
 *   wants much shorter, because a builder that waits 90 minutes for a slot has failed at being a
 *   builder. {@link MACHINE_VERIFY_ROLES} makes that a declared table rather than a constant each
 *   caller re-guesses.
 *
 * - **A caller that cannot acquire SAYS SO and proceeds** (see {@link MachineVerifyRole.onTimeout}),
 *   rather than either blocking forever or degrading silently. The gate's own rule — "a level may
 *   only weaken verification VISIBLY" — applies to the CONDITIONS a verdict was produced under,
 *   and "this ran unserialized alongside an unknown other verification" is one of them.
 *
 * OPT-IN, and that is not timidity. A lock nobody else takes is pure latency: it can only ever
 * make the FIRST adopter wait for holders that, until every consumer on the box adopts it, may
 * not exist. `KANBAN_MACHINE_VERIFY_LOCK=1` turns it on; unset, every entry point below runs its
 * work directly and the box behaves exactly as it does today.
 */

/** Basename of the machine lock. One per machine, per boot (temp dirs are cleared). */
const LOCK_FILE_NAME = "agentic-kanban-machine-verify.lock";

/** A heartbeat older than this means the holder is presumed dead. Matches `repo-lock`. */
export const MACHINE_LOCK_STALE_MS = 60 * 1000;

/**
 * Upper bound on how long a PROVABLY-ALIVE holder can block reclaim on a stale heartbeat alone.
 *
 * Same reasoning as `repo-lock`'s twin: `process.kill(pid, 0)` proving a pid alive normally means
 * the holder is still working and merely lagged its heartbeat (blocked event loop, sleep/resume,
 * an AV-locked write on Windows), and reclaiming there steals the lock from a running verify. But
 * a pid can be RECYCLED, so an unconditional refusal would wedge the machine with no recovery but
 * deleting the file by hand. Generous enough to exceed any legitimate hold — the longest role
 * bound below is 3h.
 */
export const MACHINE_LOCK_LIVE_HOLDER_MAX_MS = 4 * 60 * 60 * 1000;

/** How often a held lock's heartbeat is refreshed while work is in flight. */
export const MACHINE_LOCK_HEARTBEAT_INTERVAL_MS = 15 * 1000;

/** Env switch. Absent/false = every entry point runs its work directly (see the module header). */
export const MACHINE_LOCK_ENV = "KANBAN_MACHINE_VERIFY_LOCK";

/** Env override for the lock file's directory — the seam tests acquire a real lock through. */
export const MACHINE_LOCK_DIR_ENV = "KANBAN_MACHINE_VERIFY_LOCK_DIR";

/** Is the machine lock switched on for this process? */
export function machineVerifyLockEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes)$/i.test((env[MACHINE_LOCK_ENV] || "").trim());
}

/** Absolute path of the machine lock file. */
export function machineVerifyLockPath(env: NodeJS.ProcessEnv = process.env): string {
  const dir = (env[MACHINE_LOCK_DIR_ENV] || "").trim() || tmpdir();
  return join(dir, LOCK_FILE_NAME);
}

/**
 * What a holder is DOING, and how long the same kind of work is willing to wait for a slot.
 *
 * The ticket's first design question is "one number will not serve all three", and this is the
 * answer: the bound is a property of the ROLE, declared once, next to the reason for it. A caller
 * names its role; it does not pick a timeout.
 *
 * `onTimeout` is the second design question — what a process does when it cannot acquire. Both
 * answers are legitimate and neither is silent:
 *  - `"proceed"` — run anyway, having SAID that it is running unserialized. Correct for work whose
 *    result is needed (a merge gate's verdict, a builder's own test run): refusing to produce it
 *    is strictly worse than producing it under contention and labelling it as such.
 *  - `"skip"` — do not run at all. Correct only for work that is genuinely optional and will come
 *    round again, which on this board is the base-health probe (#931 already has it yield to a
 *    busy gate; timing out here is the same yield through a wider door).
 */
export interface MachineVerifyRole {
  /** Stable id, recorded in the lockfile so a waiter can name who holds it. */
  readonly name: string;
  /** How long this kind of work waits for a slot before {@link onTimeout} applies. */
  readonly waitMs: number;
  /** What to do when the wait is exhausted. Never "block forever"; never "fail silently". */
  readonly onTimeout: "proceed" | "skip";
  /** Why this bound, in one line — so the next reader can judge a change to it. */
  readonly rationale: string;
}

/**
 * The declared roles. Add one here rather than passing a bare number at a call site: a timeout
 * chosen inline is a number nobody can review against the others.
 */
export const MACHINE_VERIFY_ROLES = {
  /**
   * A pre-merge gate's verify chain / smoke check / E2E lane. The longest bound: its result is
   * what lets a branch merge, and a gate that gave up would withhold a merge for a reason that
   * has nothing to do with the branch.
   */
  gate: {
    name: "gate",
    waitMs: 3 * 60 * 60 * 1000,
    onTimeout: "proceed",
    rationale:
      "a gate behind two others legitimately waits hours; giving up would withhold a merge for machine load, so it proceeds and the tier message names the contention",
  },
  /**
   * A base-branch health probe. Shortest patience AND the only role that skips: it is the least
   * urgent of the three test-spawning paths (#931 already makes it yield to a busy gate), its
   * result is not time-critical, and the sweep brings it round again next interval.
   */
  probe: {
    name: "probe",
    waitMs: 5 * 60 * 1000,
    onTimeout: "skip",
    rationale:
      "the least urgent spawner (#931) and the sweep re-offers it every interval, so waiting out a gate buys nothing a later probe would not",
  },
  /**
   * A builder agent's own `pnpm test:mine`. Short on purpose: a builder blocked for an hour has
   * stopped being a builder, and its run is a fast inner loop, not a merge gate. It proceeds on
   * timeout — an unserialized test run is worth far more than no test run.
   */
  "builder-test": {
    name: "builder-test",
    waitMs: 20 * 60 * 1000,
    onTimeout: "proceed",
    rationale:
      "a builder's inner loop; blocking it for a gate's full duration stalls the ticket, so it waits a bounded while and then says it ran unserialized",
  },
} as const satisfies Record<string, MachineVerifyRole>;

export type MachineVerifyRoleName = keyof typeof MACHINE_VERIFY_ROLES;

export interface MachineLockContents {
  pid: number;
  hostname: string;
  /** The {@link MachineVerifyRole} name — so a waiter can say WHAT it is queued behind. */
  role: string;
  /** Free-text detail (a workspace id, a package label) for the log line. */
  holder: string;
  acquiredAt: string;
  heartbeatAt: string;
}

export interface MachineLockHandle {
  path: string;
  contents: MachineLockContents;
  /** Refresh the on-disk heartbeat. No-op once released or stolen. */
  heartbeat: () => void;
  /** Remove the lockfile, but only if it is still ours. */
  release: () => void;
}

function readLockContents(lockPath: string): MachineLockContents | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<MachineLockContents>;
    if (
      typeof parsed.pid === "number" &&
      typeof parsed.hostname === "string" &&
      typeof parsed.role === "string" &&
      typeof parsed.holder === "string" &&
      typeof parsed.acquiredAt === "string" &&
      typeof parsed.heartbeatAt === "string"
    ) {
      return parsed as MachineLockContents;
    }
    return null;
  } catch {
    return null;
  }
}

function heartbeatAgeMs(contents: MachineLockContents, nowMs: number): number {
  const heartbeatMs = Date.parse(contents.heartbeatAt);
  if (Number.isNaN(heartbeatMs)) return Number.POSITIVE_INFINITY;
  return Math.max(0, nowMs - heartbeatMs);
}

/**
 * Tri-state probe of the recorded holder pid — the three outcomes drive three different
 * decisions, which is why it cannot be a boolean. Identical in meaning to `repo-lock`'s:
 *  - `"dead"`    → same host, ESRCH: reclaim immediately, even inside the staleness window.
 *  - `"alive"`   → same host, signal delivered: refuse reclaim; the holder is working.
 *  - `"unknown"` → cross-host, EPERM, or an unexpected error: fall back to heartbeat staleness.
 */
function probeHolderProcess(contents: MachineLockContents): "dead" | "alive" | "unknown" {
  if (contents.hostname !== hostname()) return "unknown";
  try {
    process.kill(contents.pid, 0);
    return "alive";
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? (err as NodeJS.ErrnoException).code : undefined;
    return code === "ESRCH" ? "dead" : "unknown";
  }
}

export interface MachineLockStatus {
  path: string;
  contents: MachineLockContents;
  ageMs: number;
  isStale: boolean;
  ownerProcessDead: boolean;
  ownerProcessAlive: boolean;
}

/** Inspect the current holder (if any) without acquiring or mutating anything. */
export function inspectMachineVerifyLock(
  nowMs = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
): MachineLockStatus | null {
  const lockPath = machineVerifyLockPath(env);
  if (!existsSync(lockPath)) return null;
  const contents = readLockContents(lockPath);
  if (!contents) return null;
  const probe = probeHolderProcess(contents);
  const ageMs = heartbeatAgeMs(contents, nowMs);
  return {
    path: lockPath,
    contents,
    ageMs,
    isStale: ageMs > MACHINE_LOCK_STALE_MS,
    ownerProcessDead: probe === "dead",
    ownerProcessAlive: probe === "alive",
  };
}

function errnoCode(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? (err as NodeJS.ErrnoException).code : undefined;
}

/**
 * Why one attempt did not produce a handle. Same three-way split as `repo-lock`, for the same
 * reason: `contended` means keep waiting, `unavailable` means waiting can never help, and
 * collapsing them into `null` is what turns a broken path into a process that polls forever.
 */
export type MachineLockAttempt =
  | { outcome: "acquired"; handle: MachineLockHandle }
  | { outcome: "contended"; reason: string; heldBy?: MachineLockContents }
  | { outcome: "unavailable"; reason: string; code: string };

/**
 * Force-remove a lock only if it is still the exact entry we inspected — prevents a TOCTOU race
 * where the holder heartbeats, or a new holder acquires, between inspection and recovery.
 */
function recoverIfUnchanged(
  lockPath: string,
  expected: MachineLockContents,
): { outcome: "recovered" } | { outcome: "changed" } | { outcome: "error"; code: string; message: string } {
  const current = readLockContents(lockPath);
  if (!current || JSON.stringify(current) !== JSON.stringify(expected)) return { outcome: "changed" };
  try {
    rmSync(lockPath, { force: true });
    return { outcome: "recovered" };
  } catch (err) {
    return { outcome: "error", code: errnoCode(err) ?? "UNKNOWN", message: errorMessage(err) };
  }
}

/** One acquisition attempt, no waiting. */
export function attemptMachineVerifyLock(
  role: MachineVerifyRole,
  holder: string,
  nowMs = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
): MachineLockAttempt {
  const lockPath = machineVerifyLockPath(env);
  const existing = inspectMachineVerifyLock(nowMs, env);
  if (existing) {
    if (!existing.isStale && !existing.ownerProcessDead) {
      return {
        outcome: "contended",
        reason: describeHolder(existing),
        heldBy: existing.contents,
      };
    }
    // A stale heartbeat is only PRESUMPTIVE evidence of death, and the presumption is simply
    // wrong for a holder that is mid-verify but failed to refresh in time. Reclaiming there
    // hands a second full suite to the box the lock exists to protect.
    if (existing.ownerProcessAlive && existing.ageMs <= MACHINE_LOCK_LIVE_HOLDER_MAX_MS) {
      return {
        outcome: "contended",
        reason: `stale-heartbeat lock refused: holder pid=${existing.contents.pid} is ALIVE on this host (heartbeat age ${Math.round(existing.ageMs / 1000)}s)`,
        heldBy: existing.contents,
      };
    }
    console.warn(
      `[machine-verify-lock] recovering ${existing.ownerProcessDead ? "DEAD-holder" : "stale"} lock at ${lockPath}: ` +
        `pid=${existing.contents.pid} host=${existing.contents.hostname} role=${existing.contents.role} ` +
        `heartbeat age=${Math.round(existing.ageMs / 1000)}s`,
    );
    const recovery = recoverIfUnchanged(lockPath, existing.contents);
    if (recovery.outcome === "changed") {
      return { outcome: "contended", reason: "another acquirer recovered or reacquired the stale lock first" };
    }
    if (recovery.outcome === "error") {
      return {
        outcome: "unavailable",
        code: recovery.code,
        reason: `the stale lockfile ${lockPath} could not be removed (${recovery.code}: ${recovery.message}) — waiting cannot fix this`,
      };
    }
  }

  const contents: MachineLockContents = {
    pid: process.pid,
    hostname: hostname(),
    role: role.name,
    holder,
    acquiredAt: new Date(nowMs).toISOString(),
    heartbeatAt: new Date(nowMs).toISOString(),
  };

  try {
    // The temp dir always exists; an explicit KANBAN_MACHINE_VERIFY_LOCK_DIR may not.
    mkdirSync(join(lockPath, ".."), { recursive: true });
    writeLockFile(lockPath, contents, "wx");
  } catch (err) {
    const code = errnoCode(err);
    // EEXIST is the ONE contention case: we lost the race between the staleness check and the
    // `wx` write. Every other errno means this path cannot be locked at all, and reporting those
    // as contention is what makes a caller poll forever instead of failing (repo-lock's #230).
    if (code === "EEXIST") {
      // A file exists but `inspectMachineVerifyLock` read no HOLDER from it — so it is corrupt
      // (truncated, half-written, hand-edited), not held. Left as contention this wedges every
      // verifier on the box permanently: nobody can parse it, so nobody can ever judge it stale,
      // so nobody can ever reclaim it. An unreadable lock names no holder and therefore protects
      // nothing; removing it and retrying once is the only outcome that recovers.
      //
      // CONFIRMED TWICE, and the interval matters. A single read can catch a WRITE in progress
      // — measured: two processes racing here both acquired, because one read the other's
      // half-written file, called it corrupt, deleted it and took the lock. `writeLockFile`
      // below now makes every write atomic (write a unique temp file, then rename), which
      // removes the torn read at the source. The second read is belt-and-braces for a file
      // written by an older build that still wrote in place: a genuinely corrupt file is
      // corrupt in both reads, whereas a torn one resolves the moment the writer finishes.
      if (!existing && readLockContents(lockPath) === null && readLockContents(lockPath) === null) {
        try {
          rmSync(lockPath, { force: true });
          writeLockFile(lockPath, contents, "wx");
          console.warn(`[machine-verify-lock] discarded an unreadable lockfile at ${lockPath} and acquired`);
          return { outcome: "acquired", handle: buildHandle(lockPath, contents) };
        } catch (retryErr) {
          // Someone legitimately acquired in the gap, or the path is genuinely unwritable.
          const retryCode = errnoCode(retryErr);
          if (retryCode === "EEXIST") {
            return { outcome: "contended", reason: "another acquirer took the lock while an unreadable one was being discarded" };
          }
          return {
            outcome: "unavailable",
            code: retryCode ?? "UNKNOWN",
            reason: `an unreadable lockfile at ${lockPath} could not be replaced (${retryCode ?? "UNKNOWN"}: ${errorMessage(retryErr)}) — waiting cannot fix this`,
          };
        }
      }
      return { outcome: "contended", reason: "lost the race to another acquirer (EEXIST)" };
    }
    return {
      outcome: "unavailable",
      code: code ?? "UNKNOWN",
      reason: `the lockfile ${lockPath} could not be written (${code ?? "UNKNOWN"}: ${errorMessage(err)}) — waiting cannot fix this`,
    };
  }

  return { outcome: "acquired", handle: buildHandle(lockPath, contents) };
}

/**
 * Write the lock record so a concurrent reader can never see it half-written.
 *
 * `"wx"` (initial acquisition) goes straight to the target: exclusive creation IS the atomic
 * primitive we are relying on, and a rename would destroy it by clobbering a lock somebody else
 * won the race to.
 *
 * Every OTHER write — i.e. the heartbeat, which rewrites an existing file every 15s — goes to a
 * unique temp file and is RENAMED into place. `writeFileSync` truncates and then writes, so a
 * reader landing in that window reads a partial record, judges it unparseable, and (before this)
 * deleted a live lock and took it. Measured: two processes racing acquisition both acquired.
 * `rename` over an existing file is atomic on POSIX and on Windows/NTFS, so a reader sees either
 * the old record or the new one and never a torn one. The temp name carries the pid so two
 * processes heartbeating at once cannot collide on it.
 */
function writeLockFile(lockPath: string, contents: MachineLockContents, flag?: "wx"): void {
  if (flag === "wx") {
    writeFileSync(lockPath, JSON.stringify(contents), { flag: "wx" });
    return;
  }
  const tmp = `${lockPath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(contents));
  renameSync(tmp, lockPath);
}

/**
 * The handle over a lockfile WE just wrote. Both heartbeat and release re-read the file first and
 * no-op unless it is still ours — so a handle whose lock was reclaimed (stale, or discarded as
 * unreadable) can never heartbeat someone else's lock back to life, nor delete it.
 */
function buildHandle(lockPath: string, contents: MachineLockContents): MachineLockHandle {
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
        // Best-effort — a failed heartbeat only makes staleness recovery kick in sooner.
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

/** One human-readable line naming who holds the lock and for how long. */
export function describeHolder(status: MachineLockStatus): string {
  const heldForS = Math.round(Math.max(0, Date.now() - Date.parse(status.contents.acquiredAt)) / 1000);
  return (
    `${status.contents.role} "${status.contents.holder}" (pid=${status.contents.pid} ` +
    `host=${status.contents.hostname}, holding for ${heldForS}s)`
  );
}

/**
 * How an acquisition ended — and, for the two non-acquired outcomes, WHY, in words a caller can
 * put in front of a human. Nothing here is silent by construction: a caller that proceeds
 * unserialized gets a `note` it is expected to surface.
 */
export type MachineLockOutcome =
  /** The lock is held; `release` it when the work is done. */
  | { acquired: true; handle: MachineLockHandle; waitedMs: number; note?: undefined }
  /** Not acquired, and the role says run anyway. `note` says so, and must be reported. */
  | { acquired: false; proceed: true; waitedMs: number; note: string }
  /** Not acquired, and the role says do not run. `note` says why. */
  | { acquired: false; proceed: false; waitedMs: number; note: string };

export interface MachineLockWaitOptions {
  // No injected clock seam on purpose. The wait is bounded by `waitMs` and driven by the
  // injectable `sleep`/`attempt` seams, which is everything a test needs to script a contended
  // or unavailable outcome deterministically — none of them advance a clock. A
  // `now?: () => number` field would add a FIFTH use of a spelling that
  // `time-injection-spelling-ratchet.test.ts` grandfathers shrink-only (#614/#721), so the
  // elapsed times below read `Date.now()` inline rather than growing a baseline whose whole
  // purpose is to shrink.
  /** Sleep between polls, injected so a test need not actually wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Acquisition attempt, injected so a test can script contended/unavailable outcomes. */
  attempt?: (role: MachineVerifyRole, holder: string) => MachineLockAttempt;
  pollMs?: number;
  /** Override the role's own bound (tests, and an operator escape hatch). */
  waitMs?: number;
  /** Where the log/queue notes go. */
  log?: (message: string) => void;
}

/**
 * Wait for the machine lock, bounded by the ROLE's own patience, and resolve to an outcome that
 * always says what happened.
 *
 * Three ways out, and each is explicit rather than a `null` the caller has to interpret:
 *  - acquired (possibly after a wait, which is reported so a gate can put it in its message);
 *  - not acquired but the role proceeds — WITH a note naming the holder it could not wait out;
 *  - not acquired and the role skips.
 *
 * An `unavailable` lock path (permission denied, an unremovable lockfile) never blocks anyone:
 * the machine lock is an optimisation for a shared box, not a correctness guarantee about a
 * repository the way `repo-lock` is, so a machine that cannot host the lockfile at all must keep
 * verifying rather than stop. It resolves as proceed-with-a-note, loudly.
 */
export async function acquireMachineVerifyLock(
  role: MachineVerifyRole,
  holder: string,
  opts: MachineLockWaitOptions = {},
): Promise<MachineLockOutcome> {
  const now = Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const attemptFn = opts.attempt ?? ((r, h) => attemptMachineVerifyLock(r, h));
  const log = opts.log ?? ((m: string) => console.log(m));
  const pollMs = opts.pollMs ?? 1000;
  const waitMs = opts.waitMs ?? role.waitMs;

  const startedAt = now();
  const deadline = startedAt + waitMs;
  let announced = false;
  for (;;) {
    const attempt = attemptFn(role, holder);
    if (attempt.outcome === "acquired") {
      const waitedMs = now() - startedAt;
      if (waitedMs > 0 && announced) {
        log(`[machine-verify-lock] ${role.name} "${holder}" acquired the machine lock after ${Math.round(waitedMs / 1000)}s queued`);
      }
      return { acquired: true, handle: attempt.handle, waitedMs };
    }
    if (attempt.outcome === "unavailable") {
      const note =
        `the machine-wide verify lock is UNAVAILABLE on this box (${attempt.code}) — ` +
        `${role.name} "${holder}" is running UNSERIALIZED against any other verification here. ${attempt.reason}`;
      log(`[machine-verify-lock] ${note}`);
      return { acquired: false, proceed: true, waitedMs: now() - startedAt, note };
    }
    if (!announced) {
      announced = true;
      log(
        `[machine-verify-lock] ${role.name} "${holder}" is QUEUED behind ${attempt.reason} — ` +
          `serializing across processes, because N full suites at 1/N speed finish no sooner and starve each other (#957). ` +
          `Waiting up to ${Math.round(waitMs / 1000)}s (role "${role.name}": ${role.rationale}).`,
      );
    }
    if (now() >= deadline) {
      const waitedMs = now() - startedAt;
      const waited = Math.round(waitedMs / 1000);
      if (role.onTimeout === "skip") {
        const note =
          `${role.name} "${holder}" did not get the machine verify lock within ${waited}s ` +
          `(held by ${attempt.reason}) — SKIPPED rather than run alongside it.`;
        log(`[machine-verify-lock] ${note}`);
        return { acquired: false, proceed: false, waitedMs, note };
      }
      const note =
        `ran UNSERIALIZED: ${role.name} "${holder}" waited ${waited}s for the machine verify lock ` +
        `(held by ${attempt.reason}) and proceeded anyway — this result was produced while another ` +
        `heavyweight verification was running on this box.`;
      log(`[machine-verify-lock] ${note}`);
      return { acquired: false, proceed: true, waitedMs, note };
    }
    await sleep(pollMs);
  }
}

/**
 * Run `work` under the machine lock, with an automatic heartbeat and guaranteed release.
 *
 * The result carries `lockNote` — non-null exactly when the work ran WITHOUT the lock — so the
 * caller can surface it (a gate puts it in its tier message). `skipped` is returned only for a
 * role whose `onTimeout` is `"skip"`; those callers must handle it, which is why it is in the
 * type rather than swallowed into a thrown error.
 *
 * With the lock disabled (the default, see the module header) this runs `work` immediately and
 * returns no note — there is nothing to report about a mechanism that is off.
 */
export async function withMachineVerifyLock<T>(
  role: MachineVerifyRole,
  holder: string,
  work: () => Promise<T>,
  opts: MachineLockWaitOptions & { env?: NodeJS.ProcessEnv } = {},
): Promise<{ ran: true; result: T; waitedMs: number; lockNote: string | null } | { ran: false; waitedMs: number; lockNote: string }> {
  if (!machineVerifyLockEnabled(opts.env ?? process.env)) {
    return { ran: true, result: await work(), waitedMs: 0, lockNote: null };
  }
  const outcome = await acquireMachineVerifyLock(role, holder, opts);
  if (!outcome.acquired) {
    if (!outcome.proceed) return { ran: false, waitedMs: outcome.waitedMs, lockNote: outcome.note };
    return { ran: true, result: await work(), waitedMs: outcome.waitedMs, lockNote: outcome.note };
  }
  const timer = setInterval(() => outcome.handle.heartbeat(), MACHINE_LOCK_HEARTBEAT_INTERVAL_MS);
  // A heartbeat timer must never be the reason a process cannot exit.
  timer.unref?.();
  try {
    return { ran: true, result: await work(), waitedMs: outcome.waitedMs, lockNote: null };
  } finally {
    clearInterval(timer);
    outcome.handle.release();
  }
}

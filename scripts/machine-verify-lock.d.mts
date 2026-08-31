// Types for machine-verify-lock.mjs, so `machine-verify-lock-mirror.test.ts` — the suite that
// binds this mirror to `packages/shared/src/lib/machine-verify-lock.ts` — can import it without
// `tsc` falling back to `any` (TS7016).
//
// Hand-written, matching `test-mine.d.mts` / `security-scan.d.mts` (#827). The script is
// deliberately plain `.mjs` with no build step: `scripts/test-mine.mjs` imports it and runs as
// bare `node` in worktrees that have no `packages/shared/dist`, so a compile step between the
// runner and the lock it takes is one more thing that can disagree with itself.
//
// Drift is not silent: the mirror suite EXECUTES the real module against real lockfiles, so a
// declaration for an export that no longer exists fails at import time, not at type-check time.

/** The lockfile's basename. Must equal the shared module's; pinned by the mirror suite. */
export declare const LOCK_FILE_NAME: string;

/** A heartbeat older than this means the holder is presumed dead. */
export declare const MACHINE_LOCK_STALE_MS: number;

/** Upper bound on how long a provably-alive holder blocks reclaim on a stale heartbeat alone. */
export declare const MACHINE_LOCK_LIVE_HOLDER_MAX_MS: number;

/** How often a held lock's heartbeat is refreshed while work is in flight. */
export declare const MACHINE_LOCK_HEARTBEAT_INTERVAL_MS: number;

/** Env switch enabling the lock; absent/false means every entry point is a no-op. */
export declare const MACHINE_LOCK_ENV: string;

/** Env override for the lock file's directory — the seam tests acquire a real lock through. */
export declare const MACHINE_LOCK_DIR_ENV: string;

/** The `builder-test` role's wait bound, mirroring the shared role table's entry. */
export declare const BUILDER_TEST_WAIT_MS: number;

/** The role this half always acts as. */
export declare const ROLE_NAME: string;

export interface MachineLockContents {
  pid: number;
  hostname: string;
  role: string;
  holder: string;
  acquiredAt: string;
  heartbeatAt: string;
}

export interface MachineLockHandle {
  path: string;
  contents: MachineLockContents;
  heartbeat(): void;
  release(): void;
}

export interface MachineLockStatus {
  path: string;
  contents: MachineLockContents;
  ageMs: number;
  isStale: boolean;
  ownerProcessDead: boolean;
  ownerProcessAlive: boolean;
}

export type MachineLockAttempt =
  | { outcome: "acquired"; handle: MachineLockHandle }
  | { outcome: "contended"; reason: string }
  | { outcome: "unavailable"; reason: string; code: string };

/** Is the machine lock switched on for this process? */
export declare function machineVerifyLockEnabled(env?: Record<string, string | undefined>): boolean;

/** Absolute path of the machine lock file. */
export declare function machineVerifyLockPath(env?: Record<string, string | undefined>): string;

/** Parse a lockfile, returning null for anything that is not a complete record. */
export declare function readLockContents(lockPath: string): MachineLockContents | null;

/** Inspect the current holder (if any) without acquiring or mutating anything. */
export declare function inspectMachineVerifyLock(
  nowMs?: number,
  env?: Record<string, string | undefined>,
): MachineLockStatus | null;

/** One acquisition attempt, no waiting. */
export declare function attemptMachineVerifyLock(
  holder: string,
  nowMs?: number,
  env?: Record<string, string | undefined>,
): MachineLockAttempt;

/** One human-readable line naming who holds the lock and for how long. */
export declare function describeHolder(status: MachineLockStatus): string;

/**
 * Acquire for a builder's own test run, bounded by {@link BUILDER_TEST_WAIT_MS}.
 *
 * `note` is non-null exactly when the run is proceeding WITHOUT the lock, and the caller must
 * print it — a process that cannot acquire within its timeout says so rather than proceeding
 * silently (#957's acceptance criterion).
 */
export declare function acquireForBuilderTest(
  holder: string,
  opts?: {
    waitMs?: number;
    pollMs?: number;
    sleep?: (ms: number) => Promise<void>;
    attempt?: (holder: string) => MachineLockAttempt;
    log?: (message: string) => void;
    env?: Record<string, string | undefined>;
  },
): Promise<{ handle: MachineLockHandle | null; note: string | null }>;

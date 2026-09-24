// @gate:always-run when:scripts/machine-verify-lock.mjs,packages/server/src/lib/machine-verify-lock.ts - imports a repo-root script (scripts/machine-verify-lock.mjs) that lives
// outside every package's module graph, so `vitest related` cannot select this suite from a
// change to the script half — which is exactly the half whose drift it exists to catch.
/**
 * #957 — the machine verify lock has TWO implementations, and this holds them to one protocol.
 *
 * Why two at all (neither side can import the other, and both constraints are hard):
 *   - `scripts/test-mine.mjs` runs as bare `node` with no build step, and a worktree frequently
 *     has no built `dist/` at all — so it cannot import TypeScript from `packages/server`. A
 *     test runner that cannot run until something is built is a bootstrap problem, and it is
 *     the same reasoning `test-mine.mjs` already records for `isAlwaysRunMarked`.
 *   - `packages/server` ships only `dist/`, so shipped server code importing a repo-root script
 *     would crash on load — the same reasoning `pre-merge-gate-tier.ts` records for its own
 *     deliberate mirror.
 *
 * The precedent for binding a mirror by an executable check rather than by comment is
 * `always-run-dirs-lockstep.test.ts`, and the stakes here are higher than a miscounted message:
 * a lock whose two halves disagree about the file name, the record shape, or the staleness rule
 * SERIALIZES NOTHING while appearing to work. That is strictly worse than no lock, because the
 * box then looks protected.
 *
 * So this asserts on real lockfiles in a temp dir — the actual contract — not on source text.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as script from "../../../../scripts/machine-verify-lock.mjs";
import {
  MACHINE_LOCK_DIR_ENV,
  MACHINE_LOCK_ENV,
  MACHINE_LOCK_HEARTBEAT_INTERVAL_MS,
  MACHINE_LOCK_LIVE_HOLDER_MAX_MS,
  MACHINE_LOCK_STALE_MS,
  MACHINE_VERIFY_ROLES,
  attemptMachineVerifyLock,
  machineVerifyLockPath,
} from "../lib/machine-verify-lock.js";

let lockDir: string;

beforeEach(() => {
  lockDir = mkdtempSync(join(tmpdir(), "ak-lock-mirror-"));
  process.env[MACHINE_LOCK_DIR_ENV] = lockDir;
  process.env[MACHINE_LOCK_ENV] = "1";
});

afterEach(() => {
  delete process.env[MACHINE_LOCK_DIR_ENV];
  delete process.env[MACHINE_LOCK_ENV];
  rmSync(lockDir, { recursive: true, force: true });
});

describe("machine verify lock: shared module vs scripts/ mirror", () => {
  it("agrees on the lock FILE PATH — two paths means two locks and no serialization at all", () => {
    expect(script.machineVerifyLockPath()).toBe(machineVerifyLockPath());
  });

  it("agrees on the env switch, so one half cannot be on while the other is off", () => {
    for (const value of ["1", "true", "yes", "0", "false", ""]) {
      expect(script.machineVerifyLockEnabled({ [MACHINE_LOCK_ENV]: value })).toBe(
        /^(1|true|yes)$/i.test(value),
      );
    }
  });

  it("agrees on every timing constant", () => {
    expect(script.MACHINE_LOCK_STALE_MS).toBe(MACHINE_LOCK_STALE_MS);
    expect(script.MACHINE_LOCK_LIVE_HOLDER_MAX_MS).toBe(MACHINE_LOCK_LIVE_HOLDER_MAX_MS);
    expect(script.MACHINE_LOCK_HEARTBEAT_INTERVAL_MS).toBe(MACHINE_LOCK_HEARTBEAT_INTERVAL_MS);
  });

  it("mirrors the builder-test role's bound and name from the shared role table", () => {
    expect(script.ROLE_NAME).toBe(MACHINE_VERIFY_ROLES["builder-test"].name);
    expect(script.BUILDER_TEST_WAIT_MS).toBe(MACHINE_VERIFY_ROLES["builder-test"].waitMs);
  });

  it("each half can READ the record the other WROTE — the on-disk shape is the contract", () => {
    const mine = attemptMachineVerifyLock(MACHINE_VERIFY_ROLES.gate, "from-shared");
    if (mine.outcome !== "acquired") throw new Error("expected to acquire");
    const seenByScript = script.inspectMachineVerifyLock();
    expect(seenByScript?.contents.holder).toBe("from-shared");
    expect(seenByScript?.contents.role).toBe("gate");
    expect(seenByScript?.contents.pid).toBe(process.pid);
    mine.handle.release();

    const theirs = script.attemptMachineVerifyLock("from-script");
    if (theirs.outcome !== "acquired") throw new Error("expected to acquire");
    const seenByShared = JSON.parse(readFileSync(machineVerifyLockPath(), "utf8"));
    expect(seenByShared.holder).toBe("from-script");
    expect(seenByShared.role).toBe("builder-test");
    theirs.handle.release();
  });

  it("MUTUALLY EXCLUDES: the script cannot acquire while the shared module holds it", async () => {
    const held = attemptMachineVerifyLock(MACHINE_VERIFY_ROLES.gate, "the-gate");
    if (held.outcome !== "acquired") throw new Error("expected to acquire");
    try {
      expect(script.attemptMachineVerifyLock("a-builder").outcome).toBe("contended");
      // ...and the builder's bounded wait ends in a PROCEED with a note that names the gate,
      // rather than in silence. This pair is the ticket's whole acceptance criterion.
      const { handle, note } = await script.acquireForBuilderTest("a-builder", {
        waitMs: 30,
        pollMs: 5,
        log: () => {},
      });
      expect(handle).toBeNull();
      expect(note).toMatch(/UNSERIALIZED/);
      expect(note).toContain("the-gate");
    } finally {
      held.handle.release();
    }
  });

  it("MUTUALLY EXCLUDES the other way: the shared module cannot acquire while the script holds it", () => {
    const held = script.attemptMachineVerifyLock("a-builder");
    if (held.outcome !== "acquired") throw new Error("expected to acquire");
    try {
      const blocked = attemptMachineVerifyLock(MACHINE_VERIFY_ROLES.gate, "the-gate");
      expect(blocked.outcome).toBe("contended");
      expect(blocked.outcome === "contended" && blocked.reason).toContain("a-builder");
    } finally {
      held.handle.release();
    }
  });

  it("the script releases only its own lock, never the shared module's", () => {
    const theirs = script.attemptMachineVerifyLock("a-builder");
    if (theirs.outcome !== "acquired") throw new Error("expected to acquire");
    theirs.handle.release();
    const mine = attemptMachineVerifyLock(MACHINE_VERIFY_ROLES.gate, "the-gate");
    if (mine.outcome !== "acquired") throw new Error("expected to acquire");
    // The script's stale handle must not remove the gate's lock.
    theirs.handle.release();
    expect(existsSync(machineVerifyLockPath())).toBe(true);
    expect(JSON.parse(readFileSync(machineVerifyLockPath(), "utf8")).holder).toBe("the-gate");
    mine.handle.release();
  });

  it("both halves DISCARD an unreadable lockfile rather than wedging the box", () => {
    writeFileSync(machineVerifyLockPath(), "{ not json");
    const byScript = script.attemptMachineVerifyLock("a-builder");
    if (byScript.outcome !== "acquired") throw new Error("script should discard and acquire");
    byScript.handle.release();

    writeFileSync(machineVerifyLockPath(), "{ not json");
    const byShared = attemptMachineVerifyLock(MACHINE_VERIFY_ROLES.gate, "the-gate");
    if (byShared.outcome !== "acquired") throw new Error("shared should discard and acquire");
    byShared.handle.release();
  });

  it("both halves REPLACE the lockfile on heartbeat rather than rewriting it in place", () => {
    // The torn-write race, mirrored. An in-place `writeFileSync` truncates first, so a concurrent
    // acquirer can read a partial record, call it corrupt, and discard a LIVE holder's lock —
    // measured, with both processes acquiring. Each half must therefore swap the file atomically
    // (write to a temp name, `rename` over the target) rather than truncate-and-rewrite in place.
    //
    // NOT `ino:birthtimeMs` (the original assertion here, #1217): comparing the identity of
    // `stat(path)` before and after only proves the replacement if the OS never recycles the freed
    // file id, and never lands the new file on the same birthtime tick. Neither holds under load —
    // NTFS reuses a just-freed file id immediately, and mtime/birthtime granularity is coarse
    // enough for two `rename`s a few ms apart to collide — so a genuine replace can read as an
    // in-place rewrite by that key alone. (An fd held open across the heartbeat and compared by
    // `fstat` was tried too and is worse on Windows: `rename` onto a path with an open read handle
    // either fails outright (EPERM) or, when it succeeds, NTFS is free to keep serving the SAME
    // file id through the stale handle — there is no portable "orphaned inode" signal here.)
    //
    // The deterministic, portable proof instead: plant a lockfile at the target path that is
    // LONGER than a real record, carrying a marker field — `{"padding":"xxxxxxxxxx...", ...}`.
    // A rewrite-in-place (`writeFileSync` without a prior truncate) only overwrites the LEADING
    // bytes of a longer existing file, so the marker in the tail survives on disk; a real
    // rename-replace can only ever produce content that is EXACTLY the new record, so the marker
    // is gone. This depends on nothing OS-specific — no identity key, no timing, no granularity.
    const plantOversizedForeign = (contents: unknown) => {
      const real = JSON.stringify(contents);
      const padded = `${real.slice(0, -1)},"padding":"${"x".repeat(4096)}"}`;
      writeFileSync(machineVerifyLockPath(), padded);
    };
    const rawContents = () => readFileSync(machineVerifyLockPath(), "utf8");

    const byShared = attemptMachineVerifyLock(MACHINE_VERIFY_ROLES.gate, "the-gate");
    if (byShared.outcome !== "acquired") throw new Error("expected to acquire");
    plantOversizedForeign(byShared.handle.contents);
    expect(rawContents().length).toBeGreaterThan(4096);
    byShared.handle.heartbeat();
    const afterShared = JSON.parse(rawContents());
    // The proof: the planted "padding" key is gone. A rewrite-in-place (`writeFileSync` without a
    // prior truncate) only overwrites the LEADING bytes of a longer existing file, so the planted
    // tail — including "padding" — would still be there, either dangling after the new JSON's
    // closing brace (making the whole read unparseable) or, worse, silently absorbed as valid
    // trailing bytes some parsers ignore. A real rename-replace can only ever produce content that
    // is EXACTLY the new record, so "padding" surviving in valid, parseable JSON is only possible
    // if the disk still holds our planted object underneath the real fields.
    expect(afterShared).not.toHaveProperty("padding");
    expect(afterShared.pid).toBe(process.pid);
    byShared.handle.release();

    const byScript = script.attemptMachineVerifyLock("a-builder");
    if (byScript.outcome !== "acquired") throw new Error("expected to acquire");
    plantOversizedForeign(byScript.handle.contents);
    expect(rawContents().length).toBeGreaterThan(4096);
    byScript.handle.heartbeat();
    const afterScript = JSON.parse(rawContents());
    expect(afterScript).not.toHaveProperty("padding");
    expect(afterScript.pid).toBe(process.pid);
    byScript.handle.release();
  });

  it("the script's builder acquisition is a no-op when the switch is off", async () => {
    const { handle, note } = await script.acquireForBuilderTest("a-builder", { env: {} });
    expect(handle).toBeNull();
    expect(note).toBeNull();
    expect(existsSync(machineVerifyLockPath())).toBe(false);
  });
});

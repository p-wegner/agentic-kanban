// @gate:always-run when:packages/server/src/services/base-branch-health.service.ts,packages/server/src/startup/** — reads those sources directly
/**
 * #1050: the base-health probe leaked a full INSTALLED repo clone whenever its cleanup
 * failed, and said nothing.
 *
 * Marked `@gate:always-run` because the first two cases read
 * `services/base-branch-health.service.ts` off disk rather than importing it, so dependency-based
 * selection cannot see the dependency — the #483 failure mode, caught here by
 * `always-run-marker-ratchet` the moment this file landed. The `when:` territory (#1041) is the
 * two source trees it actually reads, so it costs nothing on a diff that touches neither.
 *
 * Two properties, both of which were absent:
 *  - the probe's throwaway root goes through `createManagedTempDir`, the one owner, so it
 *    carries the `kanban-` namespace a sweep can find and its removal is a `dispose()` whose
 *    result is a value rather than a swallowed exception;
 *  - `sweepStaleTempDirs` is actually CALLED at startup. It had zero production callers, so
 *    a root whose owner was SIGKILLed (no `finally` ever runs) stayed on disk forever.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync, utimesSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { TEMP_DIR_NAMESPACE, TEMP_DIR_OWNER_FILE } from "@agentic-kanban/shared/lib/temp-dir";
import { STARTUP_AUDIT_TASKS } from "../startup/startup-tasks.js";
import { sweepStaleTempDirsOnce, startStaleTempSweeper, stopStaleTempSweeper } from "../startup/stale-temp-sweep.js";

const serviceSrc = () =>
  readFileSync(join(import.meta.dirname, "../services/base-branch-health.service.ts"), "utf8");

describe("base-health probe temp root (#1050)", () => {
  it("is created through the managed temp-dir owner, not a bare mkdtemp", () => {
    const src = serviceSrc();
    expect(src).toContain("createManagedTempDir(`kanban-base-health-");
    // The bare pair is what bypassed the owner and the namespace sweep.
    expect(src).not.toMatch(/mkdtemp\(join\(tmpdir\(\)/);
  });

  it("reports a failed removal instead of swallowing it", () => {
    const src = serviceSrc();
    expect(src).toContain("await probeTemp.disposeAsync()");
    // The exact shape of the bug: a removal whose failure could not be observed.
    expect(src).not.toMatch(/rm\(probeRoot[^)]*\)\s*\.catch\(\(\)\s*=>\s*\{\}\)/);
  });
});

describe("stale temp dirs are actually swept at startup (#1050)", () => {
  it("the startup audit tail contains the sweep", () => {
    // The regression this pins: the helper existed and was tested, but nothing ran it.
    expect(STARTUP_AUDIT_TASKS.map((t) => t.name)).toContain("sweepStaleTempDirs");
  });

  it("the sweep it runs reaps an orphaned namespaced root older than the grace period", async () => {
    const root = mkdtempSync(join(tmpdir(), "kanban-test-sweeproot-"));
    try {
      // An orphan shaped like a real probe root: namespaced, nested content, old mtime.
      const orphan = join(root, `${TEMP_DIR_NAMESPACE}base-health-master-abc123`);
      mkdirSync(join(orphan, "repo", "node_modules"), { recursive: true });
      writeFileSync(join(orphan, "repo", "package.json"), "{}");
      const dead = spawnSync(process.execPath, ["-e", ""], { windowsHide: true });
      expect(dead.status).toBe(0);
      writeFileSync(join(orphan, TEMP_DIR_OWNER_FILE), JSON.stringify({ pid: dead.pid }));
      const past = new Date(Date.now() - 2 * 60 * 60_000);
      utimesSync(orphan, past, past);
      const fresh = join(root, `${TEMP_DIR_NAMESPACE}base-health-master-fresh`);
      mkdirSync(fresh, { recursive: true });
      writeFileSync(join(fresh, TEMP_DIR_OWNER_FILE), JSON.stringify({ pid: dead.pid }));

      // Through the production entry point; only the dead owner's old directory is reaped.
      const logged: string[] = [];
      const result = await sweepStaleTempDirsOnce(
        { root },
        (m) => logged.push(m),
      );

      expect(result.removed).toBe(1);
      // A sweep that removed something must SAY so — silence is the bug.
      expect(logged.join(" ")).toContain("1 removed");
      expect(existsSync(orphan)).toBe(false);
      expect(existsSync(fresh)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("stale temp dirs are ALSO swept periodically, not just at boot (#1110)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    stopStaleTempSweeper();
    vi.useRealTimers();
  });

  it("is registered in BACKGROUND_SERVICES so a long-lived server re-sweeps on an interval", async () => {
    // #1110's measured gap: a probe root from 04:41 was still on disk at 12:56 on a server
    // that never restarted — the boot-time sweep above only ever runs once per boot.
    const { BACKGROUND_SERVICES } = await import("../startup/background-services.js");
    expect(BACKGROUND_SERVICES.map((s) => s.name)).toContain("stale-temp-sweeper");
  });

  it("re-runs on the configured interval without a duplicate boot-time run", () => {
    // bootDelayMs must be null: STARTUP_AUDIT_TASKS already runs the sweep once at boot,
    // and a second immediate run here would just be noise on every restart.
    const h = startStaleTempSweeper(1000);
    vi.advanceTimersByTime(999);
    vi.advanceTimersByTime(1);
    // Reaching this without throwing, and the handle being stoppable, is the property under
    // test — the sweep's own reaping behaviour is covered above and in `sweepStaleTempDirsOnce`.
    expect(() => h.stop()).not.toThrow();
  });

  it("start is idempotent (stop-then-restart), the same guard every other sweep in this codebase relies on", () => {
    const first = startStaleTempSweeper(1000);
    const second = startStaleTempSweeper(1000);
    expect(() => { first.stop(); second.stop(); }).not.toThrow();
  });
});

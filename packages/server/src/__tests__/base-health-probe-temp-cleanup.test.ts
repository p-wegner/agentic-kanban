/**
 * #1050: the base-health probe leaked a full INSTALLED repo clone whenever its cleanup
 * failed, and said nothing.
 *
 * Two properties, both of which were absent:
 *  - the probe's throwaway root goes through `createManagedTempDir`, the one owner, so it
 *    carries the `kanban-` namespace a sweep can find and its removal is a `dispose()` whose
 *    result is a value rather than a swallowed exception;
 *  - `sweepStaleTempDirs` is actually CALLED at startup. It had zero production callers, so
 *    a root whose owner was SIGKILLed (no `finally` ever runs) stayed on disk forever.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { TEMP_DIR_NAMESPACE } from "@agentic-kanban/shared/lib/temp-dir";
import { STARTUP_AUDIT_TASKS } from "../startup/startup-tasks.js";
import { sweepStaleTempDirsOnce } from "../startup/stale-temp-sweep.js";

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
    expect(src).toContain("probeTemp.dispose()");
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
      const fresh = join(root, `${TEMP_DIR_NAMESPACE}base-health-master-fresh`);
      mkdirSync(fresh, { recursive: true });

      // `nowMs` two hours on, so the orphan is past the default hour of grace and the
      // freshly-made one is not — a live probe must never be swept out from under itself.
      // Through the production entry point, so the test exercises what startup runs.
      const logged: string[] = [];
      const result = sweepStaleTempDirsOnce(
        { root, nowMs: Date.now() + 2 * 60 * 60_000, olderThanMs: 90 * 60_000 },
        (m) => logged.push(m),
      );

      expect(result.removed).toBe(2);
      // A sweep that removed something must SAY so — silence is the bug.
      expect(logged.join(" ")).toContain("2 removed");
      expect(existsSync(orphan)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

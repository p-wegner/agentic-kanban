// @gate:always-run when:scripts/promote-lock.mjs,scripts/pack-worker.mjs,packages/server/src/services/worker-build.service.ts — imports the repo's promote-lock script (#1724).
// #1724: a worker tarball build never writes into the board's own checkout, and yields to a promote.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildPackArgs, createWorkerBuildService, isPromoteLockHeld } from "../services/worker-build.service.js";
// @ts-expect-error plain .mjs helper without types
import { acquirePromoteLock, releasePromoteLock } from "../../../../scripts/promote-lock.mjs";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "ak-wb-1724-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("worker-build never builds in the board checkout (#1724)", () => {
  it("always packs the existing dist with --skip-build", () => {
    expect(buildPackArgs("/repo", "/out")).toContain("--skip-build");
  });

  it("answers building (and does not pack) while a promote holds the lock", async () => {
    let packs = 0;
    const svc = createWorkerBuildService({
      repoRoot: tmp(),
      cacheDir: tmp(),
      resolveBuildId: async () => "a".repeat(40),
      pack: async () => {
        packs++;
        throw new Error("should not pack");
      },
      promoteLockHeld: () => true,
    });
    expect(await svc.getBuild()).toEqual({ state: "building" });
    expect(packs).toBe(0);
  });

  it("the promote lock is visible to worker-build from acquire to release, and stale locks are ignored", () => {
    const root = tmp();
    expect(isPromoteLockHeld(root)).toBe(false);
    acquirePromoteLock(root, { nowMs: 1_000 });
    expect(isPromoteLockHeld(root, 2_000)).toBe(true);
    expect(isPromoteLockHeld(root, 1_000 + 46 * 60 * 1000)).toBe(false);
    releasePromoteLock(root);
    expect(isPromoteLockHeld(root)).toBe(false);
    mkdirSync(join(root, ".kanban"), { recursive: true });
    writeFileSync(join(root, ".kanban", "promote.lock"), "garbage");
    expect(isPromoteLockHeld(root)).toBe(true);
  });
});

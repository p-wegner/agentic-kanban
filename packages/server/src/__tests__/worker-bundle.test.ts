// #1460: the advertised worker build follows the worker bundle, not the board's HEAD.
import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { compareWorkerBuild } from "@agentic-kanban/shared/lib/worker-build-freshness";
import { workerBundleFiles } from "../lib/worker-bundle.js";

const ROOT = resolve(__dirname, "../../../..");

describe("worker bundle (#1460)", () => {
  const files = workerBundleFiles(ROOT);

  it("includes the worker entry graph and packaging inputs", () => {
    expect(files).toContain("packages/server/src/worker/worker-cli.ts");
    expect(files).toContain("packages/server/src/worker/worker-updater.ts");
    expect(files).toContain("packages/server/src/lib/worker-bundle.ts".replace("worker-bundle", "worker-update"));
    expect(files).toContain("scripts/pack-worker.mjs");
  });

  it("excludes board-only code, so a change there cannot move the build id", () => {
    expect(files).not.toContain("packages/server/src/services/implement-exit-check.service.ts");
    expect(files.some((f) => f.startsWith("packages/server/src/routes/"))).toBe(false);
    expect(files.some((f) => f.startsWith("packages/server/src/db/"))).toBe(false);
  });

  it("a worker stamped with the bundle commit is in-sync however far HEAD moved", () => {
    const bundleCommit = "a".repeat(40);
    expect(compareWorkerBuild("0.1.9-dev.aaaaaaa", "0.1.9", bundleCommit)).toBe("in-sync");
    expect(compareWorkerBuild("0.1.9-dev.bbbbbbb", "0.1.9", bundleCommit)).toBe("different-build");
  });
});

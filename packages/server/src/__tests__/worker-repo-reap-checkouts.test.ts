// #850 — a worker's checkout directories under `<work-root>/checkouts/` outlive the git
// worktree registration that names them whenever the daemon that created them stopped,
// disconnected, or crashed mid-session. Nothing ever revisited that directory, so a
// long-lived worker accumulated whole repo clones with no reaper reaching them.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { rmOrReportHolder } from "./helpers/rm-or-report-holder.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitExecOrThrow } from "@agentic-kanban/shared/lib/git-exec";
import { reapOrphanedCheckouts } from "../worker/worker-repo.js";

describe("reapOrphanedCheckouts", () => {
  let workRoot: string;

  beforeEach(() => {
    // #839 — fixture dirs live inside an `ak-` directory so the reaper sweeps them.
    workRoot = mkdtempSync(join(tmpdir(), "ak-worker-reap-"));
  });

  afterEach(async () => {
    await rmOrReportHolder(workRoot);
  });

  it("removes a checkout dir whose worktree registration is gone, keeps one that is still live", async () => {
    const cacheDir = join(workRoot, "repos", "proj-1");
    mkdirSync(cacheDir, { recursive: true });
    await gitExecOrThrow(["init", "-b", "master", cacheDir], {});
    writeFileSync(join(cacheDir, "README.md"), "hello\n");
    await gitExecOrThrow(["add", "."], { cwd: cacheDir });
    await gitExecOrThrow(["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-m", "init"], { cwd: cacheDir });

    const checkoutsDir = join(workRoot, "checkouts");
    mkdirSync(checkoutsDir, { recursive: true });

    const liveCheckout = join(checkoutsDir, "sess-live");
    await gitExecOrThrow(["worktree", "add", "-b", "kanban/sess-live", liveCheckout, "master"], { cwd: cacheDir });

    // An orphan: a directory sitting under checkouts/ that git never registered as a
    // worktree at all (the shape a crashed daemon that never finished provisioning, or
    // whose cache clone vanished, leaves behind).
    const orphanCheckout = join(checkoutsDir, "sess-orphan");
    mkdirSync(orphanCheckout, { recursive: true });
    writeFileSync(join(orphanCheckout, "stray-file.txt"), "leftover\n");

    const report = await reapOrphanedCheckouts(workRoot);

    expect(report.scanned).toBe(2);
    expect(report.reaped).toEqual([orphanCheckout]);
    expect(report.errored).toEqual([]);
    expect(existsSync(orphanCheckout)).toBe(false);
    expect(existsSync(liveCheckout)).toBe(true);
  });

  it("treats every checkout as orphaned when its project cache is gone entirely", async () => {
    const checkoutsDir = join(workRoot, "checkouts");
    const orphanCheckout = join(checkoutsDir, "sess-no-cache");
    mkdirSync(orphanCheckout, { recursive: true });
    // No repos/ dir at all — the reported #850 scenario for a repo whose cache was itself removed.

    const report = await reapOrphanedCheckouts(workRoot);

    expect(report.scanned).toBe(1);
    expect(report.reaped).toEqual([orphanCheckout]);
    expect(existsSync(orphanCheckout)).toBe(false);
  });

  it("is a no-op when there is no checkouts directory yet", async () => {
    const report = await reapOrphanedCheckouts(workRoot);
    expect(report).toEqual({ scanned: 0, reaped: [], errored: [] });
  });
});

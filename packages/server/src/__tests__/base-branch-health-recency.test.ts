// The base-branch health sweep re-ran a FULL verify for every project after every dev-server
// restart, because its only overlap guard (`tickInFlight`) is per-process and each restart is
// a new process. `tsx watch` restarts on every merge, and `INITIAL_DELAY_MS` is two minutes,
// so a run of merges kept re-arming it from scratch.
//
// Measured on this board: it was running a second complete copy of
// `pnpm check:arch && pnpm typecheck && pnpm test:mine` on the main checkout while a developer
// ran the same suite — the most likely source of the `Worker exited unexpectedly` crashes and
// the 5s guard-suite timeouts that then read as unrelated test failures.
//
// Persisted recency is the fix, because it is the only thing a restart cannot forget.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { projects } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { recordBaseBranchHealth } from "../repositories/base-branch-health.repository.js";

const verifyBaseBranchHealth = vi.fn(async () => {});
// Only the probe itself is stubbed; the sweep also reads this module's start-stamp key and
// probe-ceiling constant (#712), and a partial mock would leave those undefined — which the
// sweep's per-project try/catch would swallow into "check failed", making every assertion
// below pass or fail for the wrong reason.
vi.mock("../services/base-branch-health.service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    verifyBaseBranchHealth: (...args: Parameters<typeof verifyBaseBranchHealth>) => verifyBaseBranchHealth(...args),
  };
});

const { runBaseBranchHealthCheckOnce } = await import("../startup/base-branch-health-reconciler.js");

const INTERVAL_MS = 30 * 60 * 1000;

describe("base-branch health sweep respects persisted recency across restarts", () => {
  let db: ReturnType<typeof createTestDb>["db"];
  let projectId: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ db } = createTestDb());
    projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      name: "p",
      repoPath: "C:/repo",
      repoName: "repo",
      createdAt: new Date().toISOString(),
    });
  });

  it("verifies a project that has never been checked", async () => {
    await runBaseBranchHealthCheckOnce(db, INTERVAL_MS, Date.now());

    expect(verifyBaseBranchHealth).toHaveBeenCalledTimes(1);
  });

  it("skips a project checked less than one interval ago — the restart-storm case", async () => {
    await recordBaseBranchHealth(
      { projectId, sha: "abc", branch: "master", outcome: "green" },
      db,
    );

    // A restart two minutes later: a fresh process, so tickInFlight is false and the old
    // code would have re-run the whole verify here.
    await runBaseBranchHealthCheckOnce(db, INTERVAL_MS, Date.now() + 2 * 60 * 1000);

    expect(verifyBaseBranchHealth).not.toHaveBeenCalled();
  });

  it("still verifies once the interval has genuinely elapsed", async () => {
    await recordBaseBranchHealth(
      { projectId, sha: "abc", branch: "master", outcome: "green" },
      db,
    );

    await runBaseBranchHealthCheckOnce(db, INTERVAL_MS, Date.now() + INTERVAL_MS + 1000);

    expect(verifyBaseBranchHealth).toHaveBeenCalledTimes(1);
  });
});

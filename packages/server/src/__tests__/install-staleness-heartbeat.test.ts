// @covers repos.installState [concurrency, recovery]
//
// #714 — the install-staleness reconciler (#685) had two defects that made it MANUFACTURE the
// false merge blocks it exists to remove:
//
//  1. The reclaim `UPDATE` carried no state predicate, and it ran against rows read by an
//     earlier `SELECT`. A row that reached `done` in between was clobbered to `failed` — and
//     since the background runner writes the same row, the state then oscillates.
//  2. `installUpdatedAt` only ever moved on a state TRANSITION, and the background runner
//     installs at concurrency 1. So "stale" meant "started a while ago": a single install
//     longer than the 30-minute window (allowed — `sibling_install_timeout_ms_<projectId>`
//     goes to three hours) and the `pending` TAIL of a multi-repo queue were both reclaimed
//     while the runner was alive and healthy.
//
// These tests pin the fixes as a pair, because either alone still loses a live install: the
// compare-and-swap protects the row the runner just finished, the heartbeat protects the ones
// it has not reached yet.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { projects, projectStatuses, issues, workspaces, repos } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import type { OutstandingRepoInstallRow } from "../startup/install-staleness-reconciler.js";

const runSetupScriptMock = vi.fn();
vi.mock("@agentic-kanban/shared/lib/setup-script", () => ({
  runSetupScript: (...args: unknown[]) => runSetupScriptMock(...args),
  DEFAULT_SETUP_SCRIPT_TIMEOUT_MS: 300_000,
}));

// `listOutstandingRepoInstallRows` is the SELECT half of the TOCTOU window, so the only way to
// express "the row advanced between the read and the write" is to control what the pass read.
// Everything else in the module stays real — the compare-and-swap under test is
// `failRepoInstallIfStillIn`, and the heartbeat is `touchOutstandingRepoInstalls`.
const actualRepoRepo = await vi.importActual<typeof import("../repositories/repo.repository.js")>(
  "../repositories/repo.repository.js",
);
const listOutstandingMock = vi.fn();
vi.mock("../repositories/repo.repository.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../repositories/repo.repository.js")>()),
  listOutstandingRepoInstallRows: (...args: unknown[]) => listOutstandingMock(...args),
}));

const { reconcileStaleInstalls, INSTALL_STALE_TIMEOUT_MS } = await import(
  "../startup/install-staleness-reconciler.js"
);
const { runBackgroundSiblingInstalls } = await import("../services/workspace-repos.service.js");
const { touchOutstandingRepoInstalls } = actualRepoRepo;

type Db = ReturnType<typeof createTestDb>["db"];

const NOW_MS = Date.parse("2026-08-22T12:00:00.000Z");
/** Well past the 30-minute window, and past it by more than any beat interval. */
const STALE_ISO = new Date(NOW_MS - INSTALL_STALE_TIMEOUT_MS - 10 * 60 * 1000).toISOString();

const SIBLING_A = "C:/repos/sibling-a";
const SIBLING_B = "C:/repos/sibling-b";

let db: Db;
let projectId: string;
let workspaceId: string;

/** One live workspace with two workspace-scoped sibling repo rows, plus the project-scoped
 *  rows the background runner reads to find each repo's setup script. */
async function seed(opts: { installState: string | null; installUpdatedAt?: string | null } = { installState: "pending" }) {
  projectId = randomUUID();
  workspaceId = randomUUID();
  const statusId = randomUUID();
  const issueId = randomUUID();
  await db.insert(projects).values({ id: projectId, name: "p", repoPath: "C:/repos/leading" });
  await db.insert(projectStatuses).values({ id: statusId, projectId, name: "In Progress", sortOrder: 1 });
  await db.insert(issues).values({ id: issueId, issueNumber: 1, title: "T", statusId, projectId });
  await db.insert(workspaces).values({ id: workspaceId, issueId, branch: "feature/ak-714", status: "active" });
  for (const path of [SIBLING_A, SIBLING_B]) {
    // project-scoped row: carries the setup script
    await db.insert(repos).values({ id: randomUUID(), projectId, path, name: path.split("/").pop()!, setupScript: "install" });
    // workspace-scoped row: carries the install state the sweep reads
    await db.insert(repos).values({
      id: randomUUID(),
      workspaceId,
      projectId,
      path,
      name: path.split("/").pop()!,
      worktreePath: `${path}/.worktrees/b`,
      branch: "feature/ak-714",
      installState: opts.installState,
      installUpdatedAt: opts.installUpdatedAt === undefined ? STALE_ISO : opts.installUpdatedAt,
    });
  }
}

async function stateOf(path: string): Promise<{ installState: string | null; installUpdatedAt: string | null; installDetail: string | null }> {
  const rows = await db
    .select({ installState: repos.installState, installUpdatedAt: repos.installUpdatedAt, installDetail: repos.installDetail })
    .from(repos)
    .where(and(eq(repos.workspaceId, workspaceId), eq(repos.path, path)));
  return rows[0]!;
}

function outstandingView(path: string, installState: string, installUpdatedAt = STALE_ISO): OutstandingRepoInstallRow {
  return { workspaceId, path, name: path.split("/").pop()!, installState, installUpdatedAt };
}

beforeEach(async () => {
  vi.clearAllMocks();
  ({ db } = createTestDb());
  runSetupScriptMock.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
  listOutstandingMock.mockImplementation((...args: unknown[]) =>
    (actualRepoRepo.listOutstandingRepoInstallRows as (...a: unknown[]) => unknown)(...args),
  );
});

describe("the reclaim is a compare-and-swap on the state it read (#714)", () => {
  it("does NOT clobber a row that reached `done` between the SELECT and the UPDATE", async () => {
    // The row is `done` on disk; the pass is holding the `pending` view it read a moment ago.
    await seed({ installState: "done", installUpdatedAt: new Date(NOW_MS - 1000).toISOString() });
    listOutstandingMock.mockResolvedValue([outstandingView(SIBLING_A, "pending")]);

    const result = await reconcileStaleInstalls({ database: db, nowMs: NOW_MS, log: () => {} });

    const after = await stateOf(SIBLING_A);
    expect(after.installState).toBe("done");
    expect(after.installDetail).toBeNull();
    // …and it reports honestly: it acted on nothing.
    expect(result.failed).toEqual([]);
    expect(result.acted).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.reasons.map((r) => r.reason).join(" ")).toContain("advanced");
  });

  it("still reclaims a row that really is where the pass left it — the swap is not a no-op", async () => {
    await seed({ installState: "pending" });
    listOutstandingMock.mockResolvedValue([outstandingView(SIBLING_A, "pending")]);

    const result = await reconcileStaleInstalls({ database: db, nowMs: NOW_MS, log: () => {} });

    const after = await stateOf(SIBLING_A);
    expect(after.installState).toBe("failed");
    expect(after.installDetail).toContain("timed out");
    expect(result.failed).toEqual([{ workspaceId, path: SIBLING_A }]);
  });

  it("does not clobber a `running` row when the pass read it as `pending` — a transition IS progress", async () => {
    await seed({ installState: "running", installUpdatedAt: new Date(NOW_MS - 1000).toISOString() });
    listOutstandingMock.mockResolvedValue([outstandingView(SIBLING_A, "pending")]);

    await reconcileStaleInstalls({ database: db, nowMs: NOW_MS, log: () => {} });

    expect((await stateOf(SIBLING_A)).installState).toBe("running");
  });
});

describe("staleness measures lack of PROGRESS, not elapsed time (#714)", () => {
  it("holds an install past the window that is still heartbeating", async () => {
    await seed({ installState: "running" });
    // What a live runner does every beat: re-stamp its outstanding rows.
    await touchOutstandingRepoInstalls(
      { workspaceId, paths: [SIBLING_A, SIBLING_B], now: new Date(NOW_MS - 30_000).toISOString() },
      db,
    );

    const result = await reconcileStaleInstalls({ database: db, nowMs: NOW_MS, log: () => {} });

    expect(result.failed).toEqual([]);
    expect((await stateOf(SIBLING_A)).installState).toBe("running");
    // The `pending` tail of the queue is protected by the same beat — the #714 case where a
    // healthy 16-repo run had its last repos flipped to `failed`.
    expect((await stateOf(SIBLING_B)).installState).toBe("running");
  });

  it("still reclaims a genuinely silent install past the window", async () => {
    await seed({ installState: "running" });

    const result = await reconcileStaleInstalls({ database: db, nowMs: NOW_MS, log: () => {} });

    expect(result.failed).toHaveLength(2);
    expect((await stateOf(SIBLING_A)).installState).toBe("failed");
    expect((await stateOf(SIBLING_B)).installState).toBe("failed");
  });

  it("the heartbeat can never resurrect a settled row — it is scoped to pending/running", async () => {
    await seed({ installState: "done" });
    await touchOutstandingRepoInstalls(
      { workspaceId, paths: [SIBLING_A, SIBLING_B], now: new Date(NOW_MS).toISOString() },
      db,
    );
    expect((await stateOf(SIBLING_A)).installUpdatedAt).toBe(STALE_ISO);
  });
});

describe("the background runner heartbeats while it works (#714)", () => {
  /** The stamp on the still-`pending` TAIL row, read from INSIDE the first install. */
  async function tailStampDuringFirstInstall(heartbeatIntervalMs: number): Promise<string | null> {
    let tailStamp: string | null | undefined;
    runSetupScriptMock.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 60));
      if (tailStamp === undefined) tailStamp = (await stateOf(SIBLING_B)).installUpdatedAt;
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    await runBackgroundSiblingInstalls({
      workspaceId,
      projectId,
      database: db,
      installMode: "background",
      heartbeatIntervalMs,
      siblings: [SIBLING_A, SIBLING_B].map((path) => ({
        path,
        name: path.split("/").pop()!,
        worktreePath: `${path}/.worktrees/b`,
        branch: "feature/ak-714",
        baseBranch: "main",
        baseCommitSha: "sha",
        composeFile: null,
        installDeferred: true,
      })),
    });
    return tailStamp ?? null;
  }

  it("advances the queued tail's stamp while the head is still installing", async () => {
    await seed({ installState: "pending" });

    const midRun = await tailStampDuringFirstInstall(5);

    // A beat, not a transition: the tail row is still `pending` and its stamp is now WALL-CLOCK
    // fresh. (Asserted against the real clock rather than `NOW_MS` — the heartbeat stamps
    // `Date.now()`, and the synthetic staleness above is a fixed date, not an offset from it.)
    expect(midRun).not.toBe(STALE_ISO);
    expect(Date.now() - Date.parse(midRun!)).toBeLessThan(60_000);
  });

  it("without the heartbeat the tail keeps its create-time stamp — the defect, pinned", async () => {
    await seed({ installState: "pending" });

    expect(await tailStampDuringFirstInstall(0)).toBe(STALE_ISO);
  });
});

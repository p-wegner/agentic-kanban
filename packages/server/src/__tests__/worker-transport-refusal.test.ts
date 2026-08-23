/**
 * #748 — a repo shape the git transport cannot carry is REFUSED, not dispatched.
 *
 * `Placement.repo` is one `projectId/repoPath/branch`; the transport serves one
 * `/git/:projectId` route; the worker provisions one checkout, without
 * `--recurse-submodules` and with no `/info/lfs` endpoint to resolve pointers
 * against. Three project shapes do not fit through that, and the defect was never
 * that they are unsupported — it was that nothing refused them:
 *
 *   - a multi-repo project's builder saw the LEADING repo only, so a sibling-only
 *     ticket found nothing to change, pushed nothing, and exited 0. A result that
 *     looks legitimate is strictly worse than a refusal.
 *   - LFS and submodules failed LATE, in a clone on someone else's machine.
 *
 * The rule these tests pin is the one #651 established for the profile allowlist:
 * the board cannot serve this remotely, so it does not go remote. Fall back to the
 * host — which handles every one of these shapes — or, for a project that forbids
 * the host fallback, HOLD with the reason.
 *
 * A filesystem-sharing worker is exempt by construction: it reads the board's own
 * worktrees, siblings and LFS objects included.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { preferences, projects as projectsTable, repos } from "@agentic-kanban/shared/schema";
import type { WSContext } from "hono/ws";
import { gitExecOrThrow } from "@agentic-kanban/shared/lib/git-exec";
import { createTestDb } from "./helpers/test-db.js";
import type { PlacementReasonId } from "../lib/placement-explain.types.js";
import type { Database } from "../db/index.js";
import {
  getWorkerFleet,
  resolveWorkerPlacement,
  projectCanDispatch,
  workerDispatchPrefKey,
  workerStrictPrefKey,
  SHARES_FILESYSTEM_LABEL,
  WorkerDispatchUnavailableError,
  type WorkerFleet,
} from "../services/worker-fleet.service.js";
import {
  scanTransportFeatures,
  remoteDispatchBlockedByRepoShape,
} from "../services/worker-transport-support.service.js";
import { __resetWorkerSlotReservations } from "../services/worker-slot-reservation.service.js";

const PROJECT_ID = "dddd1111-2222-3333-4444-555566667777";

/**
 * The fleet grew a protocol handshake while this suite was being written, so
 * `registerWorker` now refuses a worker that reports no version. Declared through an
 * intersection rather than by importing the new constant: this suite is about
 * placement, and it should not go red either way over a field it does not test.
 */
type RegisterWorkerInput = Parameters<WorkerFleet["registry"]["registerWorker"]>[0] & {
  protocolVersion?: number;
};
const SPEAKS_CURRENT_PROTOCOL: Pick<RegisterWorkerInput, "protocolVersion"> = { protocolVersion: 1 };


function fakeWs(): WSContext {
  return { send: () => {}, close: () => {} } as unknown as WSContext;
}

/** A real git repo on disk — the detector shells out to `git ls-files`. */
async function makeRepo(): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "kanban-transport-"));
  await gitExecOrThrow(["init", "-q", "-b", "master"], { cwd: dir });
  await gitExecOrThrow(["config", "user.email", "t@example.com"], { cwd: dir });
  await gitExecOrThrow(["config", "user.name", "T"], { cwd: dir });
  writeFileSync(path.join(dir, "README.md"), "hello\n");
  await gitExecOrThrow(["add", "README.md"], { cwd: dir });
  await gitExecOrThrow(["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

async function commitFile(repoPath: string, relative: string, content: string): Promise<void> {
  const full = path.join(repoPath, relative);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
  await gitExecOrThrow(["add", "--", relative], { cwd: repoPath });
  await gitExecOrThrow(["commit", "-q", "-m", `add ${relative}`], { cwd: repoPath });
}

describe("scanTransportFeatures (#748)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("passes a plain repo", async () => {
    const repo = await makeRepo();
    dirs.push(repo);
    expect(await scanTransportFeatures(repo)).toEqual({ kind: "ok", unsupported: [] });
  });

  it("finds an LFS filter in a tracked .gitattributes, at the root or nested", async () => {
    const repo = await makeRepo();
    dirs.push(repo);
    await commitFile(repo, "assets/.gitattributes", "*.psd filter=lfs diff=lfs merge=lfs -text\n");
    const scan = await scanTransportFeatures(repo);
    expect(scan.kind).toBe("ok");
    const found = scan.kind === "ok" ? scan.unsupported : [];
    expect(found).toHaveLength(1);
    // The reason has to say WHY it cannot work remotely, not just name the feature.
    expect(found[0]).toMatch(/LFS/);
    expect(found[0]).toMatch(/info\/lfs/);
  });

  it("does not cry LFS over a .gitattributes that has no LFS filter", async () => {
    const repo = await makeRepo();
    dirs.push(repo);
    await commitFile(repo, ".gitattributes", "* text=auto eol=lf\n");
    expect(await scanTransportFeatures(repo)).toEqual({ kind: "ok", unsupported: [] });
  });

  it("finds submodules", async () => {
    const repo = await makeRepo();
    dirs.push(repo);
    await commitFile(repo, ".gitmodules", '[submodule "vendor/x"]\n\tpath = vendor/x\n\turl = https://example.com/x\n');
    const scan = await scanTransportFeatures(repo);
    expect(scan.kind).toBe("ok");
    const found = scan.kind === "ok" ? scan.unsupported : [];
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/submodule/i);
  });

  it("separates 'not a git repo' from 'could not tell'", async () => {
    // These must not collapse into one answer. A path that is not a work tree cannot
    // produce a SILENT partial — the worker's clone fails immediately — so refusing
    // it would turn a clear error into a quiet host fallback. A repo that would not
    // ANSWER is the refusal, because an LFS filter could be hiding behind it.
    const dir = mkdtempSync(path.join(tmpdir(), "kanban-not-a-repo-"));
    dirs.push(dir);
    expect(await scanTransportFeatures(dir)).toEqual({ kind: "not-a-repo" });
  });
});

describe("resolveWorkerPlacement refuses an unservable repo shape (#748)", () => {
  let db: Database;
  let fleet: WorkerFleet;
  const dirs: string[] = [];

  beforeEach(() => {
    __resetWorkerSlotReservations();
    db = createTestDb().db as unknown as Database;
    fleet = getWorkerFleet(db);
  });

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function seed(repoPath: string, strict = false) {
    await db.insert(preferences).values({ key: workerDispatchPrefKey(PROJECT_ID), value: "true" });
    if (strict) await db.insert(preferences).values({ key: workerStrictPrefKey(PROJECT_ID), value: "true" });
    await db.insert(projectsTable).values({
      id: PROJECT_ID,
      name: "transport-fixture",
      repoPath,
      defaultBranch: "master",
    } as typeof projectsTable.$inferInsert);
  }

  async function addSibling(name: string, repoPath: string) {
    await db.insert(repos).values({
      id: `sibling-${name}`,
      projectId: PROJECT_ID,
      workspaceId: null,
      path: repoPath,
      name,
      isLeading: false,
    } as typeof repos.$inferInsert);
  }

  async function connectWorker(sharesFilesystem = false) {
    const { pairingToken } = fleet.registry.mintPairingToken();
    const result = await fleet.registry.registerWorker({
      pairingToken,
      name: "w",
      labels: sharesFilesystem ? [SHARES_FILESYSTEM_LABEL] : undefined,
      ...SPEAKS_CURRENT_PROTOCOL,
    });
    if (!result.ok) throw new Error(result.error);
    fleet.connections.handleOpen(result.workerId, fakeWs());
    return result.workerId;
  }

  const place = () =>
    resolveWorkerPlacement({
      database: db,
      projectId: PROJECT_ID,
      providerName: "claude",
      branch: "feature/748",
      baseBranch: "master",
    });

  it("still places a plain single-repo project remotely — the refusal is narrow", async () => {
    const repo = await makeRepo();
    dirs.push(repo);
    await seed(repo);
    const workerId = await connectWorker();
    const placement = await place();
    expect(placement.kind).toBe("remote");
    expect(placement.kind === "remote" && placement.workerId).toBe(workerId);
    expect(placement.kind === "remote" && placement.repo?.repoPath).toBe(repo);
  });

  it("falls back to the host for a MULTI-REPO project instead of shipping the leading repo alone", async () => {
    const repo = await makeRepo();
    dirs.push(repo);
    await seed(repo);
    await addSibling("web", "C:/some/web");
    await connectWorker();
    // Before this, the placement was remote and the worker built against a checkout
    // that did not contain `web` at all.
    const placement = await place();
    expect(placement).toEqual({
      kind: "host",
      reason: { id: "repo_transport_shape" satisfies PlacementReasonId, detail: expect.any(String) },
    });
    expect(placement.reason?.detail).toContain("multi-repo");
  });

  it("HOLDS a multi-repo project that forbids the host fallback, naming the shape", async () => {
    const repo = await makeRepo();
    dirs.push(repo);
    await seed(repo, true);
    await addSibling("web", "C:/some/web");
    await connectWorker();
    await expect(place()).rejects.toThrow(WorkerDispatchUnavailableError);
    await expect(place()).rejects.toThrow(/multi-repo/);
  });

  it("refuses a repo that uses LFS, and says where it would have failed", async () => {
    const repo = await makeRepo();
    dirs.push(repo);
    await commitFile(repo, ".gitattributes", "*.bin filter=lfs diff=lfs merge=lfs -text\n");
    await seed(repo, true);
    await connectWorker();
    await expect(place()).rejects.toThrow(/LFS/);
  });

  it("refuses a repo with submodules", async () => {
    const repo = await makeRepo();
    dirs.push(repo);
    await commitFile(repo, ".gitmodules", '[submodule "vendor/x"]\n\tpath = vendor/x\n\turl = https://example.com/x\n');
    await seed(repo, true);
    await connectWorker();
    await expect(place()).rejects.toThrow(/submodule/i);
  });

  it("exempts a filesystem-sharing worker — it needs no transport at all", async () => {
    const repo = await makeRepo();
    dirs.push(repo);
    await seed(repo);
    await addSibling("web", "C:/some/web");
    await commitFile(repo, ".gitmodules", '[submodule "vendor/x"]\n\tpath = vendor/x\n\turl = https://example.com/x\n');
    const workerId = await connectWorker(true);
    const placement = await place();
    // It reads the board's own worktrees, so every shape above is fine there.
    expect(placement).toEqual({
      kind: "remote",
      workerId,
      strict: false,
      reservationId: expect.any(String),
      reason: { id: "eligible_worker" satisfies PlacementReasonId, detail: expect.any(String) },
    });
    expect(placement.reason?.detail).toContain("shares this filesystem");
  });

  it("tells the monitor the real reason instead of letting it start and fall back", async () => {
    const repo = await makeRepo();
    dirs.push(repo);
    await seed(repo, true);
    await addSibling("web", "C:/some/web");
    await connectWorker();
    const verdict = await projectCanDispatch({ database: db, projectId: PROJECT_ID, providerName: "claude" });
    expect(verdict.available).toBe(false);
    expect(!verdict.available && verdict.reason).toMatch(/multi-repo/);
  });

  it("does not report a filesystem-sharing fleet as unavailable for a multi-repo project", async () => {
    const repo = await makeRepo();
    dirs.push(repo);
    await seed(repo, true);
    await addSibling("web", "C:/some/web");
    await connectWorker(true);
    const verdict = await projectCanDispatch({ database: db, projectId: PROJECT_ID, providerName: "claude" });
    expect(verdict.available).toBe(true);
  });

  it("fails CLOSED when a real repo will not say whether it uses LFS", async () => {
    const repo = await makeRepo();
    dirs.push(repo);
    const verdict = await remoteDispatchBlockedByRepoShape({
      projectId: PROJECT_ID,
      repoPath: repo,
      database: db,
      scan: async () => ({ kind: "unknown", detail: "git said nothing" }),
    });
    expect(verdict.blocked).toBe(true);
    expect(verdict.blocked && verdict.reason).toMatch(/could not be inspected/);
  });

  it("does NOT refuse a path that is not a git repo — that failure is already loud", async () => {
    const notARepo = mkdtempSync(path.join(tmpdir(), "kanban-not-a-repo-"));
    dirs.push(notARepo);
    const verdict = await remoteDispatchBlockedByRepoShape({
      projectId: PROJECT_ID,
      repoPath: notARepo,
      database: db,
    });
    expect(verdict.blocked).toBe(false);
  });
});

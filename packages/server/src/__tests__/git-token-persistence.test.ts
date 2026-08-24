/**
 * #775 — a git token issued by ONE board process must still work in the NEXT one.
 *
 * The scope lived only in an in-memory `createExpiringDigestStore`, so a board restart made
 * the board forget every token it had issued: a worker finishing its run pushed with a token
 * nobody recognised and got a 401 on every retry, leaving the work as an orphan
 * `kanban/<sessionId>` branch in its cache clone. This suite is the restart: two
 * `startGitHttpServer` calls over the SAME database, with the first one closed in between —
 * which is exactly what the in-memory store cannot survive.
 *
 * #776 lives here too: the pinned-port invariant is the other half of "a worker can still
 * reach the board after a restart", and it is checked against the same fixture.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitExecOrThrow } from "@agentic-kanban/shared/lib/git-exec";
import { projects, workerGitTokens } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import type { Database } from "../db/index.js";
import {
  startGitHttpServer,
  gitPortStabilityViolation,
  revokeGitTokensForWorker,
  KANBAN_INCOMING_REF_PREFIX,
  type GitHttpHandle,
} from "../services/git-http.service.js";

const PROJECT_ID = "bbbbcccc-dddd-eeee-ffff-000011112222";
const WORKER_ID = "worker-restart";
const BRANCH = "feature/ak-775-restart";
const ASSIGNED_REF = `${KANBAN_INCOMING_REF_PREFIX}${BRANCH}`;

describe("persisted git token scopes (#775)", () => {
  let db: Database;
  let repoDir: string;
  /** Every handle opened by a test, closed in afterAll so a failure cannot leak a listener. */
  const opened: GitHttpHandle[] = [];

  /** One "board process": a listener over the shared database with a live assignment. */
  async function boot(): Promise<GitHttpHandle> {
    const handle = await startGitHttpServer({
      database: db,
      host: "127.0.0.1",
      // The assignment is current in both processes — the point of the test is the TOKEN
      // store surviving, not the assignment check, which already reads the DB per request.
      assignmentLookup: async () => true,
    });
    opened.push(handle);
    return handle;
  }

  const advertise = (handle: GitHttpHandle, token: string) =>
    fetch(`http://127.0.0.1:${handle.port}/git/${PROJECT_ID}/info/refs?service=git-upload-pack`, {
      headers: { authorization: `Bearer ${token}` },
    });

  beforeAll(async () => {
    db = createTestDb().db as unknown as Database;
    repoDir = mkdtempSync(join(tmpdir(), "ak-git-token-persist-"));
    await gitExecOrThrow(["init", "-b", "master", repoDir], {});
    writeFileSync(join(repoDir, "README.md"), "hello fleet\n");
    await gitExecOrThrow(["add", "."], { cwd: repoDir });
    await gitExecOrThrow(["commit", "-m", "init"], { cwd: repoDir });
    await db.insert(projects).values({
      id: PROJECT_ID,
      name: "git-token-persist-fixture",
      repoPath: repoDir,
      defaultBranch: "master",
    } as typeof projects.$inferInsert);
  });

  afterAll(async () => {
    for (const handle of opened) await handle.close().catch(() => { /* already closed */ });
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("authenticates a token issued by a PREVIOUS board process", async () => {
    const first = await boot();
    const token = first.issueToken({ workerId: WORKER_ID, projectId: PROJECT_ID, incomingRef: ASSIGNED_REF });
    expect((await advertise(first, token)).status).toBe(200);

    // The restart. Nothing survives but the database.
    await first.close();
    const second = await boot();
    expect(second.port).not.toBe(first.port);

    const res = await advertise(second, token);
    expect(res.status).toBe(200);
  });

  it("does NOT authenticate a revoked token after a restart", async () => {
    const first = await boot();
    const token = first.issueToken({ workerId: "worker-doomed", projectId: PROJECT_ID, incomingRef: ASSIGNED_REF });
    expect(await first.revokeWorkerTokens("worker-doomed")).toBe(1);
    await first.close();

    const second = await boot();
    expect((await advertise(second, token)).status).toBe(401);
  });

  it("revokes the persisted rows even when no listener is running in this process", async () => {
    // The hole the early `if (!activeServer) return 0` left once scopes were persisted: the
    // transport starts lazily on the first git-transport dispatch, so a revoke right after a
    // board restart cleared nothing and the next dispatch resolved the surviving row.
    const first = await boot();
    const token = first.issueToken({ workerId: "worker-lazy", projectId: PROJECT_ID, incomingRef: ASSIGNED_REF });
    // Force the row to land before we go behind the handle's back.
    expect((await advertise(first, token)).status).toBe(200);
    await first.close();

    expect(await revokeGitTokensForWorker("worker-lazy", db)).toBe(1);

    const second = await boot();
    expect((await advertise(second, token)).status).toBe(401);
  });

  it("keeps only the DIGEST — the clear token is nowhere in the table", async () => {
    const handle = await boot();
    const token = handle.issueToken({ workerId: "worker-digest", projectId: PROJECT_ID, incomingRef: ASSIGNED_REF });
    expect((await advertise(handle, token)).status).toBe(200);

    const rows = await db.select().from(workerGitTokens);
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain(token);
    const mine = rows.find((r) => r.workerId === "worker-digest");
    expect(mine).toBeTruthy();
    expect(mine!.tokenHash).toHaveLength(64);
    expect(mine!.projectId).toBe(PROJECT_ID);
    expect(mine!.incomingRef).toBe(ASSIGNED_REF);
    expect(mine!.expiresAtMs).toBeGreaterThan(mine!.issuedAtMs);
  });

  it("refuses a persisted token past its TTL ceiling, in a new process too", async () => {
    const first = await boot();
    const stale = first.issueToken({ workerId: "worker-stale", projectId: PROJECT_ID, ttlMs: -1 });
    await first.close();

    const second = await boot();
    expect((await advertise(second, stale)).status).toBe(401);
  });
});

describe("pinned git port when a fleet listener exists (#776)", () => {
  const saved = { fleet: process.env.KANBAN_FLEET_PORT, git: process.env.KANBAN_GIT_HTTP_PORT };

  beforeEach(() => {
    delete process.env.KANBAN_FLEET_PORT;
    delete process.env.KANBAN_GIT_HTTP_PORT;
  });

  afterAll(() => {
    if (saved.fleet === undefined) delete process.env.KANBAN_FLEET_PORT;
    else process.env.KANBAN_FLEET_PORT = saved.fleet;
    if (saved.git === undefined) delete process.env.KANBAN_GIT_HTTP_PORT;
    else process.env.KANBAN_GIT_HTTP_PORT = saved.git;
  });

  it("allows an OS-assigned git port when no fleet listener is configured", () => {
    expect(gitPortStabilityViolation({})).toBeNull();
    expect(gitPortStabilityViolation({ KANBAN_FLEET_PORT: "" })).toBeNull();
    // An invalid fleet port disables the listener, so there is no promise to keep.
    expect(gitPortStabilityViolation({ KANBAN_FLEET_PORT: "not-a-port" })).toBeNull();
  });

  it("allows an OS-assigned git port only while the git port IS pinned", () => {
    expect(gitPortStabilityViolation({ KANBAN_FLEET_PORT: "3003", KANBAN_GIT_HTTP_PORT: "3002" })).toBeNull();
  });

  it("refuses an ephemeral git port once a fleet listener is configured", () => {
    const violation = gitPortStabilityViolation({ KANBAN_FLEET_PORT: "3003" });
    expect(violation).toContain("KANBAN_GIT_HTTP_PORT");
    expect(violation).toContain("KANBAN_FLEET_PORT=3003");
    // A typo'd git port falls back to OS-assigned, which is not a pinned port either.
    expect(gitPortStabilityViolation({ KANBAN_FLEET_PORT: "3003", KANBAN_GIT_HTTP_PORT: "nope" }))
      .toContain("KANBAN_GIT_HTTP_PORT");
  });

  it("refuses to START the transport on an ephemeral port with a fleet listener configured", async () => {
    process.env.KANBAN_FLEET_PORT = "3003";
    const db = createTestDb().db as unknown as Database;
    await expect(startGitHttpServer({ database: db, host: "127.0.0.1" })).rejects.toThrow(
      /refusing to start the git transport on an OS-assigned port/,
    );
  });

  it("still starts when the caller passes an explicit port (the test/embedding seam)", async () => {
    process.env.KANBAN_FLEET_PORT = "3003";
    const db = createTestDb().db as unknown as Database;
    const handle = await startGitHttpServer({ database: db, host: "127.0.0.1", port: 0 });
    try {
      expect(handle.port).toBeGreaterThan(0);
    } finally {
      await handle.close();
    }
  });
});

// Integration test for the worker-fleet git smart-HTTP service (#188): real
// git client against the real listener — clone, push to the incoming
// namespace, refusal of refs/heads pushes, token auth.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GIT_HEAVY_TEST_TIMEOUT_MS } from "./helpers/timeouts.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { gitExec, gitExecOrThrow } from "@agentic-kanban/shared/lib/git-exec";
import { projects } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import type { Database } from "../db/index.js";
import {
  startGitHttpServer,
  parsePktLineLength,
  type GitHttpHandle,
  KANBAN_INCOMING_REF_PREFIX,
} from "../services/git-http.service.js";

const GIT_ID = "aaaabbbb-cccc-dddd-eeee-ffff00001111";
const OTHER_PROJECT_ID = "aaaabbbb-cccc-dddd-eeee-ffff00002222";
const WORKER_ID = "worker-1";
const ASSIGNED_REF = `${KANBAN_INCOMING_REF_PREFIX}feature/ak-42-test`;

describe("git-http service (worker fleet phase 2)", () => {
  let db: Database;
  let handle: GitHttpHandle;
  let repoDir: string;
  let workDir: string;
  /** The assignment token: one worker, one project, one incoming ref (#246/#247). */
  let token: string;

  const authedUrl = () => `http://x-token:${token}@127.0.0.1:${handle.port}/git/${GIT_ID}`;

  beforeAll(async () => {
    db = createTestDb().db as unknown as Database;
    repoDir = mkdtempSync(join(tmpdir(), "git-http-origin-"));
    workDir = mkdtempSync(join(tmpdir(), "git-http-work-"));

    await gitExecOrThrow(["init", "-b", "master", repoDir], {});
    await gitExecOrThrow(["config", "user.email", "test@test"], { cwd: repoDir });
    await gitExecOrThrow(["config", "user.name", "Test"], { cwd: repoDir });
    writeFileSync(join(repoDir, "README.md"), "hello fleet\n");
    await gitExecOrThrow(["add", "."], { cwd: repoDir });
    await gitExecOrThrow(["commit", "-m", "init"], { cwd: repoDir });

    await db.insert(projects).values({
      id: GIT_ID,
      name: "git-http-fixture",
      repoPath: repoDir,
      defaultBranch: "master",
    } as typeof projects.$inferInsert);

    handle = await startGitHttpServer({ database: db, host: "127.0.0.1" });
    token = handle.issueToken({ workerId: WORKER_ID, projectId: GIT_ID, incomingRef: ASSIGNED_REF });
  });

  afterAll(async () => {
    await handle.close();
    for (const dir of [repoDir, workDir]) rmSync(dir, { recursive: true, force: true });
  });

  it("rejects unauthenticated info/refs", async () => {
    const res = await fetch(`http://127.0.0.1:${handle.port}/git/${GIT_ID}/info/refs?service=git-upload-pack`);
    expect(res.status).toBe(401);
  });

  it("clones over authed smart HTTP", async () => {
    const cloneDir = join(workDir, "clone");
    const result = await gitExec(["clone", authedUrl(), cloneDir], { timeout: GIT_HEAVY_TEST_TIMEOUT_MS });
    expect(result.code).toBe(0);
    const head = await gitExecOrThrow(["log", "-1", "--format=%s"], { cwd: cloneDir });
    expect(head.trim()).toBe("init");
  });

  it("accepts a push to the kanban incoming namespace and refuses refs/heads", async () => {
    const cloneDir = join(workDir, "clone");
    writeFileSync(join(cloneDir, "feature.txt"), "worker work\n");
    await gitExecOrThrow(["config", "user.email", "w@w"], { cwd: cloneDir });
    await gitExecOrThrow(["config", "user.name", "Worker"], { cwd: cloneDir });
    await gitExecOrThrow(["checkout", "-b", "feature/ak-42-test"], { cwd: cloneDir });
    await gitExecOrThrow(["add", "."], { cwd: cloneDir });
    await gitExecOrThrow(["commit", "-m", "worker commit"], { cwd: cloneDir });

    const push = await gitExec(
      ["push", "origin", `HEAD:${KANBAN_INCOMING_REF_PREFIX}feature/ak-42-test`],
      { cwd: cloneDir, timeout: GIT_HEAVY_TEST_TIMEOUT_MS },
    );
    expect(push.code).toBe(0);
    const sha = await gitExecOrThrow(["rev-parse", `${KANBAN_INCOMING_REF_PREFIX}feature/ak-42-test`], { cwd: repoDir });
    const localSha = await gitExecOrThrow(["rev-parse", "HEAD"], { cwd: cloneDir });
    expect(sha.trim()).toBe(localSha.trim());

    const badPush = await gitExec(
      ["push", "origin", "HEAD:refs/heads/feature/ak-42-test"],
      { cwd: cloneDir, timeout: GIT_HEAVY_TEST_TIMEOUT_MS },
    );
    expect(badPush.code).not.toBe(0);
    const probe = await gitExec(["rev-parse", "refs/heads/feature/ak-42-test"], { cwd: repoDir });
    expect(probe.code).not.toBe(0);
    // Two real pushes over HTTP plus a refusal round-trip: on a loaded machine
    // this genuinely exceeds the 60s config default (see helpers/timeouts.ts).
  }, GIT_HEAVY_TEST_TIMEOUT_MS * 2);

  it("refuses a push to an incoming ref the token was not issued for (#246)", async () => {
    const cloneDir = join(workDir, "clone");
    const badPush = await gitExec(
      ["push", "origin", `HEAD:${KANBAN_INCOMING_REF_PREFIX}master`],
      { cwd: cloneDir, timeout: GIT_HEAVY_TEST_TIMEOUT_MS },
    );
    expect(badPush.code).not.toBe(0);
    const probe = await gitExec(["rev-parse", `${KANBAN_INCOMING_REF_PREFIX}master`], { cwd: repoDir });
    expect(probe.code).not.toBe(0);
  }, GIT_HEAVY_TEST_TIMEOUT_MS * 2);

  // Scope is checked BEFORE the repo lookup, so this needs no second fixture repo:
  // the point is that a token for project A never speaks for project B.
  it("refuses a token scoped to another project (#247)", async () => {
    const res = await fetch(
      `http://127.0.0.1:${handle.port}/git/${OTHER_PROJECT_ID}/info/refs?service=git-upload-pack`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(res.status).toBe(403);
  });

  it("404s for an unknown project the token IS scoped to", async () => {
    const unknownId = randomUUID();
    const scoped = handle.issueToken({ workerId: WORKER_ID, projectId: unknownId });
    const res = await fetch(
      `http://127.0.0.1:${handle.port}/git/${unknownId}/info/refs?service=git-upload-pack`,
      { headers: { authorization: `Bearer ${scoped}` } },
    );
    expect(res.status).toBe(404);
  });

  it("stops honoring a revoked worker's tokens (#247)", async () => {
    const doomed = handle.issueToken({ workerId: "worker-doomed", projectId: GIT_ID });
    const before = await fetch(
      `http://127.0.0.1:${handle.port}/git/${GIT_ID}/info/refs?service=git-upload-pack`,
      { headers: { authorization: `Bearer ${doomed}` } },
    );
    expect(before.status).toBe(200);

    expect(handle.revokeWorkerTokens("worker-doomed")).toBe(1);

    const after = await fetch(
      `http://127.0.0.1:${handle.port}/git/${GIT_ID}/info/refs?service=git-upload-pack`,
      { headers: { authorization: `Bearer ${doomed}` } },
    );
    expect(after.status).toBe(401);
    // Another worker's token is untouched.
    const other = await fetch(
      `http://127.0.0.1:${handle.port}/git/${GIT_ID}/info/refs?service=git-upload-pack`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(other.status).toBe(200);
  });

  it("expires tokens (#247)", async () => {
    const shortLived = handle.issueToken({ workerId: WORKER_ID, projectId: GIT_ID, ttlMs: -1 });
    const res = await fetch(
      `http://127.0.0.1:${handle.port}/git/${GIT_ID}/info/refs?service=git-upload-pack`,
      { headers: { authorization: `Bearer ${shortLived}` } },
    );
    expect(res.status).toBe(401);
  });

  it("rejects non-canonical pkt-line lengths in the receive guard", () => {
    expect(parsePktLineLength("0000")).toBe(0);
    expect(parsePktLineLength("00a4")).toBe(164);
    // "+000"/" 000"/"-000" all parse as 0 via parseInt — a forged flush-pkt.
    expect(parsePktLineLength("+000")).toBeNull();
    expect(parsePktLineLength(" 000")).toBeNull();
    expect(parsePktLineLength("-000")).toBeNull();
    expect(parsePktLineLength("00A4")).toBeNull();
    expect(parsePktLineLength("0abz")).toBeNull();
    // 1..3 are shorter than the header itself and would desync the offset.
    for (const len of ["0001", "0002", "0003"]) expect(parsePktLineLength(len)).toBeNull();
  });
});

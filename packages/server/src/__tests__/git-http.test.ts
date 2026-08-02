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
import { startGitHttpServer, type GitHttpHandle, KANBAN_INCOMING_REF_PREFIX } from "../services/git-http.service.js";

const GIT_ID = "aaaabbbb-cccc-dddd-eeee-ffff00001111";

describe("git-http service (worker fleet phase 2)", () => {
  let db: Database;
  let handle: GitHttpHandle;
  let repoDir: string;
  let workDir: string;

  const authedUrl = () => `http://x-token:${handle.token}@127.0.0.1:${handle.port}/git/${GIT_ID}`;

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
      { cwd: cloneDir, timeout: 30000 },
    );
    expect(push.code).toBe(0);
    const sha = await gitExecOrThrow(["rev-parse", `${KANBAN_INCOMING_REF_PREFIX}feature/ak-42-test`], { cwd: repoDir });
    const localSha = await gitExecOrThrow(["rev-parse", "HEAD"], { cwd: cloneDir });
    expect(sha.trim()).toBe(localSha.trim());

    const badPush = await gitExec(
      ["push", "origin", "HEAD:refs/heads/feature/ak-42-test"],
      { cwd: cloneDir, timeout: 30000 },
    );
    expect(badPush.code).not.toBe(0);
    const probe = await gitExec(["rev-parse", "refs/heads/feature/ak-42-test"], { cwd: repoDir });
    expect(probe.code).not.toBe(0);
  });

  it("404s for an unknown project", async () => {
    const res = await fetch(
      `http://127.0.0.1:${handle.port}/git/${randomUUID()}/info/refs?service=git-upload-pack`,
      { headers: { authorization: `Bearer ${handle.token}` } },
    );
    expect(res.status).toBe(404);
  });
});

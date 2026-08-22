// #753 — the fleet's git credential and the startup sweep were both unbounded in TIME.
//
// #247 scoped an assignment token to one worker, one project and one incoming ref, and
// #246 made the sweep land a ref only against a persisted dispatch. Both were complete in
// SPACE and neither was complete in time:
//
//   * nothing revoked a token when its session ENDED — its only bounds were a 24h TTL and
//     `revokeWorker` — so a token holder could clone the project and force-push a
//     descendant of master to the branch's incoming ref hours after review and merge;
//   * "the DB holds a matching dispatch" was read as "any session ever stamped with a
//     workerId for this branch": no status, no recency, no worker identity, so a branch
//     that had EVER been dispatched stayed landable forever — including after its `ak-<N>`
//     name had been recycled onto a different issue.
//
// These tests pin the two bounds that close it (a live-dispatch check on every git request,
// and a newest-and-current predicate for automatic landing), and the resource limits and
// header rule that make up the rest of the ticket.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { gitExecOrThrow } from "@agentic-kanban/shared/lib/git-exec";
import { issues, projectStatuses, projects, sessions, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import type { Database } from "../db/index.js";
import {
  findCurrentWorkerAssignment,
  isWorkerAssignmentCurrent,
  listLandableWorkerBranches,
  listWorkerAssignedBranches,
  WORKER_RESULT_LANDABLE_AFTER_END_MS,
} from "../repositories/worker.repository.js";
import {
  ASSIGNMENT_SETTLE_MS,
  authorizeAssignment,
  branchFromIncomingRef,
  createAssignmentLookup,
  startGitHttpServer,
  type GitHttpHandle,
} from "../services/git-http.service.js";
import {
  createBodyLimit,
  createReceiveGuard,
  KANBAN_INCOMING_REF_PREFIX,
  MAX_COMMAND_LINES,
  MAX_COMMAND_SECTION_BYTES,
  resolveMaxRpcBodyBytes,
  DEFAULT_MAX_RPC_BODY_BYTES,
} from "../lib/git-receive-guard.js";
import { extractBearer } from "../lib/bearer-token.js";

const PROJECT_ID = "9d000000-1111-2222-3333-444455556666";
const STATUS_ID = "9d001111-1111-2222-3333-444455556666";
const WORKER = "worker-alpha";
const OTHER_WORKER = "worker-beta";

/** ISO for `ms` milliseconds ago — never a hardcoded ISO string that ages out. */
function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

describe("a git token is bound to a LIVE dispatch, not to its own TTL (#753)", () => {
  let db: Database;
  let repoDir: string;

  async function seedDispatch(opts: {
    branch: string;
    issueNumber: number;
    workerId?: string;
    status: string;
    startedAt?: string;
    endedAt?: string | null;
  }): Promise<void> {
    const issueId = randomUUID();
    const workspaceId = randomUUID();
    const now = new Date().toISOString();
    await db.insert(issues).values({
      id: issueId, issueNumber: opts.issueNumber, title: `dispatch for ${opts.branch}`,
      statusId: STATUS_ID, projectId: PROJECT_ID, createdAt: now, updatedAt: now,
    } as typeof issues.$inferInsert);
    await db.insert(workspaces).values({
      id: workspaceId, issueId, branch: opts.branch, baseBranch: "master", status: "active",
      createdAt: now, updatedAt: now,
    } as typeof workspaces.$inferInsert);
    await db.insert(sessions).values({
      id: randomUUID(), workspaceId, status: opts.status,
      startedAt: opts.startedAt ?? now,
      endedAt: opts.endedAt ?? null,
      workerId: opts.workerId ?? WORKER,
    } as typeof sessions.$inferInsert);
  }

  beforeEach(async () => {
    db = createTestDb().db as unknown as Database;
    // A real repo, so a request that gets PAST the assignment gate produces a real ref
    // advertisement — otherwise "allowed" and "refused" are only distinguishable by a
    // status code the transport never reached.
    repoDir = mkdtempSync(join(tmpdir(), "token-bound-origin-"));
    await gitExecOrThrow(["init", "-b", "master", repoDir], {});
    writeFileSync(join(repoDir, "README.md"), "bound repo\n");
    await gitExecOrThrow(["add", "."], { cwd: repoDir });
    await gitExecOrThrow(["commit", "-m", "init"], { cwd: repoDir });
    await db.insert(projects).values({
      id: PROJECT_ID, name: "token-bound-fixture", repoPath: repoDir, defaultBranch: "master",
    } as typeof projects.$inferInsert);
    await db.insert(projectStatuses).values({
      id: STATUS_ID, projectId: PROJECT_ID, name: "In Progress", sortOrder: 0,
    } as typeof projectStatuses.$inferInsert);
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  describe("isWorkerAssignmentCurrent", () => {
    it("is true while the session runs and for the result-push window after it ends", () => {
      expect(isWorkerAssignmentCurrent({ status: "running", endedAt: null })).toBe(true);
      expect(isWorkerAssignmentCurrent({ status: "stopped", endedAt: ago(60_000) })).toBe(true);
    });

    it("is false once the window has passed — this is the bound that did not exist", () => {
      expect(
        isWorkerAssignmentCurrent({ status: "stopped", endedAt: ago(WORKER_RESULT_LANDABLE_AFTER_END_MS + 60_000) }),
      ).toBe(false);
    });

    it("is false for a terminal session with no endedAt, and for an unparseable one", () => {
      // The safe direction: an operator can still land such a ref deliberately, and a
      // credential that cannot prove it is current does not get to act.
      expect(isWorkerAssignmentCurrent({ status: "stopped", endedAt: null })).toBe(false);
      expect(isWorkerAssignmentCurrent({ status: "completed", endedAt: "not a date" })).toBe(false);
    });
  });

  describe("what the sweep may land, versus what an operator may", () => {
    it("lands a running dispatch and one that just ended", async () => {
      await seedDispatch({ branch: "feature/ak-1-live", issueNumber: 1, status: "running" });
      await seedDispatch({ branch: "feature/ak-2-just-done", issueNumber: 2, status: "stopped", endedAt: ago(30_000) });
      const landable = await listLandableWorkerBranches(PROJECT_ID, db);
      expect([...landable].sort()).toEqual(["feature/ak-1-live", "feature/ak-2-just-done"]);
    });

    it("refuses a branch whose dispatch ended long ago — the merged-then-re-pushed attack", async () => {
      await seedDispatch({
        branch: "feature/ak-3-merged", issueNumber: 3, status: "completed",
        startedAt: ago(6 * 60 * 60 * 1000),
        endedAt: ago(5 * 60 * 60 * 1000),
      });
      expect([...(await listLandableWorkerBranches(PROJECT_ID, db))]).toEqual([]);
      // ...while the OPERATOR path keeps the looser "was ever dispatched" gate on purpose:
      // a human choosing one ref is a different act from a startup pass landing what it finds.
      expect([...(await listWorkerAssignedBranches(PROJECT_ID, db))]).toEqual(["feature/ak-3-merged"]);
    });

    it("judges a RECYCLED branch name by its newest dispatch, not by any dispatch", async () => {
      const branch = "feature/ak-9-recycled";
      // The old, long-finished session that used to vouch for this name forever...
      await seedDispatch({
        branch, issueNumber: 9, status: "completed",
        startedAt: ago(48 * 60 * 60 * 1000), endedAt: ago(47 * 60 * 60 * 1000),
      });
      expect([...(await listLandableWorkerBranches(PROJECT_ID, db))]).toEqual([]);
      // ...and a genuine new dispatch on the same name must not be vetoed by its predecessor.
      await seedDispatch({ branch, issueNumber: 10, status: "running", startedAt: new Date().toISOString() });
      expect([...(await listLandableWorkerBranches(PROJECT_ID, db))]).toEqual([branch]);
    });

    it("never lands a branch that was never dispatched to a worker at all", async () => {
      expect([...(await listLandableWorkerBranches(PROJECT_ID, db))]).toEqual([]);
    });
  });

  describe("findCurrentWorkerAssignment is per WORKER, not per branch", () => {
    it("does not let one worker's live dispatch vouch for another worker's token", async () => {
      const branch = "feature/ak-4-shared-name";
      await seedDispatch({ branch, issueNumber: 4, status: "running", workerId: WORKER });
      expect(await findCurrentWorkerAssignment({ projectId: PROJECT_ID, workerId: WORKER, branch }, db)).not.toBeNull();
      expect(
        await findCurrentWorkerAssignment({ projectId: PROJECT_ID, workerId: OTHER_WORKER, branch }, db),
      ).toBeNull();
    });

    it("accepts a relaunch: an older ended row beside a running one still resolves", async () => {
      const branch = "feature/ak-5-relaunched";
      await seedDispatch({
        branch, issueNumber: 5, status: "stopped",
        startedAt: ago(3 * 60 * 60 * 1000), endedAt: ago(2 * 60 * 60 * 1000),
      });
      await seedDispatch({ branch, issueNumber: 6, status: "running" });
      expect(await findCurrentWorkerAssignment({ projectId: PROJECT_ID, workerId: WORKER, branch }, db)).not.toBeNull();
    });
  });

  describe("authorizeAssignment", () => {
    const scope = (issuedAgoMs: number) => ({
      workerId: WORKER,
      projectId: PROJECT_ID,
      incomingRef: `${KANBAN_INCOMING_REF_PREFIX}feature/ak-7-x`,
      issuedAtMs: Date.now() - issuedAgoMs,
    });
    const allow = async () => true;
    const deny = async () => false;

    it("allows a current dispatch however old the token is", async () => {
      const outcome = await authorizeAssignment(scope(23 * 60 * 60 * 1000), allow);
      expect(outcome).toEqual({ ok: true, reason: "assignment-current" });
    });

    it("allows a fresh token whose dispatch row has not been stamped yet", async () => {
      // `updateSessionWorkerId` is fire-and-forget AFTER the assign frame goes out, so a
      // fast clone legitimately beats the write. Failing closed here breaks every launch.
      const outcome = await authorizeAssignment(scope(1_000), deny);
      expect(outcome).toEqual({ ok: true, reason: "settling" });
    });

    it("refuses once the settle window has passed and no dispatch is current", async () => {
      const outcome = await authorizeAssignment(scope(ASSIGNMENT_SETTLE_MS + 1_000), deny);
      expect(outcome.ok).toBe(false);
      expect(outcome.ok === false && outcome.reason).toMatch(/no current dispatch/);
    });

    it("fails CLOSED when the lookup throws", async () => {
      const outcome = await authorizeAssignment(scope(1_000), async () => {
        throw new Error("db is gone");
      });
      expect(outcome.ok).toBe(false);
      expect(outcome.ok === false && outcome.reason).toMatch(/lookup failed/);
    });

    it("gives a ref-less (push-incapable) token nothing but the settle window", async () => {
      const refless = { workerId: WORKER, projectId: PROJECT_ID, issuedAtMs: Date.now() - ASSIGNMENT_SETTLE_MS - 1 };
      expect((await authorizeAssignment(refless, allow)).ok).toBe(false);
    });

    it("reads the branch back out of the incoming ref, and refuses anything else", () => {
      expect(branchFromIncomingRef(`${KANBAN_INCOMING_REF_PREFIX}feature/ak-8-y`)).toBe("feature/ak-8-y");
      expect(branchFromIncomingRef("refs/heads/master")).toBeNull();
      expect(branchFromIncomingRef(KANBAN_INCOMING_REF_PREFIX)).toBeNull();
      expect(branchFromIncomingRef(undefined)).toBeNull();
    });
  });

  describe("the live listener honours it, and drops the token on the way out", () => {
    let handle: GitHttpHandle;

    it("403s a token whose session is over, and the SAME token then 401s", async () => {
      // The lookup is the real DB-backed one, over a database with no dispatch at all.
      handle = await startGitHttpServer({
        database: db,
        host: "127.0.0.1",
        assignmentLookup: createAssignmentLookup(db),
      });
      try {
        const token = handle.issueToken({
          workerId: WORKER,
          projectId: PROJECT_ID,
          incomingRef: `${KANBAN_INCOMING_REF_PREFIX}feature/ak-11-gone`,
          // Minted outside the settle window: this is the "hours after the merge" case.
          now: Date.now() - ASSIGNMENT_SETTLE_MS - 60_000,
        });
        const url = `http://127.0.0.1:${handle.port}/git/${PROJECT_ID}/info/refs?service=git-upload-pack`;
        const auth = { authorization: `Basic ${Buffer.from(`x-token:${token}`).toString("base64")}` };
        expect((await fetch(url, { headers: auth })).status).toBe(403);
        // Refusing is not enough: the token is REVOKED, so the holder cannot keep probing
        // until a new session happens to make it valid again.
        expect((await fetch(url, { headers: auth })).status).toBe(401);
      } finally {
        await handle.close();
      }
    });

    it("serves a token whose session is running", async () => {
      const branch = "feature/ak-12-live";
      await seedDispatch({ branch, issueNumber: 12, status: "running" });
      handle = await startGitHttpServer({
        database: db,
        host: "127.0.0.1",
        assignmentLookup: createAssignmentLookup(db),
      });
      try {
        const token = handle.issueToken({
          workerId: WORKER,
          projectId: PROJECT_ID,
          incomingRef: `${KANBAN_INCOMING_REF_PREFIX}${branch}`,
          now: Date.now() - ASSIGNMENT_SETTLE_MS - 60_000,
        });
        const res = await fetch(
          `http://127.0.0.1:${handle.port}/git/${PROJECT_ID}/info/refs?service=git-upload-pack`,
          { headers: { authorization: `Basic ${Buffer.from(`x-token:${token}`).toString("base64")}` } },
        );
        expect(res.status).toBe(200);
        expect(await res.text()).toContain("refs/heads/master");
      } finally {
        await handle.close();
      }
    });
  });
});

describe("receive-pack is bounded, not merely guarded (#753)", () => {
  /** Feed a stream through a transform and resolve with the error it dies of, if any. */
  async function pump(transform: import("node:stream").Transform, chunks: Buffer[]): Promise<Error | null> {
    return new Promise((resolve) => {
      transform.on("error", (err: Error) => resolve(err));
      transform.on("data", () => { /* drain */ });
      transform.on("end", () => resolve(null));
      Readable.from(chunks).pipe(transform);
    });
  }

  function pkt(payload: string): Buffer {
    return Buffer.from((payload.length + 4).toString(16).padStart(4, "0") + payload, "utf8");
  }

  const allowed = `${KANBAN_INCOMING_REF_PREFIX}feature/ak-42-test`;
  const sha = "a".repeat(40);

  it("destroys a command section that never flushes, instead of buffering it forever", async () => {
    // The OOM primitive: bytes that never parse as a complete pkt-line. A single
    // 4-byte header claiming 65516 bytes, repeated, grows the buffer without bound.
    const chunk = Buffer.concat([Buffer.from("ffec", "utf8"), Buffer.alloc(8 * 1024, 0x41)]);
    const chunks = Array.from({ length: 16 }, () => chunk);
    const err = await pump(createReceiveGuard(allowed, () => {}), chunks);
    expect(err?.message).toMatch(new RegExp(`${MAX_COMMAND_SECTION_BYTES} bytes`));
  });

  it("caps the number of command lines in one push", async () => {
    const line = pkt(`${sha} ${sha} ${allowed}`);
    const err = await pump(createReceiveGuard(allowed, () => {}), [
      Buffer.concat(Array.from({ length: MAX_COMMAND_LINES + 2 }, () => line)),
    ]);
    expect(err?.message).toMatch(new RegExp(`${MAX_COMMAND_LINES} command lines`));
  });

  it("refuses an EMPTY refname, which used to skip the scope check entirely", async () => {
    // `refname && (...)`: a command line whose third field is missing fell through the
    // guard and reached git with no ref check at all.
    let violation: string | null = null;
    const err = await pump(
      createReceiveGuard(allowed, (v) => { violation = v.kind === "refname" ? v.refname : v.detail; }),
      [pkt(`${sha} ${sha}`)],
    );
    expect(err?.message).toMatch(/refused/);
    expect(violation).toBe("");
  });

  it("still passes a legitimate single-ref push through to the flush packet", async () => {
    const err = await pump(createReceiveGuard(allowed, () => {}), [
      pkt(`${sha} ${sha} ${allowed} report-status`),
      Buffer.from("0000", "utf8"),
      Buffer.from("PACK-ish payload"),
    ]);
    expect(err).toBeNull();
  });

  it("caps the body at a real number, counted after decompression", async () => {
    const err = await pump(createBodyLimit(1024, () => {}), [Buffer.alloc(2048)]);
    expect(err?.message).toMatch(/exceeded 1024 bytes/);
    expect(await pump(createBodyLimit(4096, () => {}), [Buffer.alloc(1024)])).toBeNull();
  });

  it("takes the cap from the environment, and ignores nonsense rather than removing it", () => {
    expect(resolveMaxRpcBodyBytes({})).toBe(DEFAULT_MAX_RPC_BODY_BYTES);
    expect(resolveMaxRpcBodyBytes({ KANBAN_GIT_MAX_BODY_BYTES: "4096" })).toBe(4096);
    expect(resolveMaxRpcBodyBytes({ KANBAN_GIT_MAX_BODY_BYTES: "0" })).toBe(DEFAULT_MAX_RPC_BODY_BYTES);
    expect(resolveMaxRpcBodyBytes({ KANBAN_GIT_MAX_BODY_BYTES: "lots" })).toBe(DEFAULT_MAX_RPC_BODY_BYTES);
  });
});

describe("a Basic credential lives in the password slot only (#753)", () => {
  const basic = (raw: string) => `Basic ${Buffer.from(raw).toString("base64")}`;

  it("takes the token from the password slot, the way git sends it", () => {
    expect(extractBearer(basic("x-token:secret"), { allowBasic: true })).toBe("secret");
  });

  it("no longer accepts it in the USERNAME slot", () => {
    // A username is the half that gets echoed into `git remote -v`, proxy logs and error
    // messages; the password half is what tooling knows to redact. A 401 is recoverable.
    expect(extractBearer(basic("secret"), { allowBasic: true })).toBeNull();
    expect(extractBearer(basic("secret:"), { allowBasic: true })).toBeNull();
  });
});

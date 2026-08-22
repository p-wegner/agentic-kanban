// @covers fleet.remote-turn.checkout-sync [fleet, error, api]
/**
 * #783 / #784 — the CONTRACT of a board-initiated repo operation on a live remote session,
 * with a fake worker so every refusal path is reachable without a second machine.
 *
 * What these pin, and why each one is a bug that actually shipped:
 *  - a follow-up turn against a remote session SYNCS the worker's checkout first, and is
 *    REFUSED when that could not be done. Before #783 nothing pushed the board's side of the
 *    branch to the worker at all, so the second turn silently rebuilt on the tree the session
 *    cloned — a remote workspace was one-shot in practice.
 *  - a `diverged` / `dirty-held` worker checkout is a 409 and nothing is reset or forced.
 *  - `unknown` liveness HOLDS (422). It is absence of information, not "the checkout is fine".
 *  - a mid-session diff reports HOW OLD its content is, and an `unknown` liveness is never
 *    presented as "no new work" (#784 item 4).
 *
 * The end-to-end half — a real worker daemon, a real git transport, a board commit between
 * two turns — is `remote-mid-session-repo-ops.test.ts`. This file is the refusal matrix.
 */

import { Hono } from "hono";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { issues, projectStatuses, projects, sessions, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { createWorkspaceActionsRoute } from "../routes/workspace-actions.js";
import { domainErrorHandler } from "../middleware/error-handler.js";
import {
  gateRemoteTurn,
  landRemoteMidSessionWork,
  type ProbeLiveness,
  type RemoteRepoOpPort,
} from "../services/worker-remote-sync.service.js";

const WORKER_ID = "worker-1";

type OpOutcome = Awaited<ReturnType<RemoteRepoOpPort["requestRepoOp"]>>;

/** A worker that answers exactly what the test says, and records what it was asked. */
function fakeOps(opts: {
  repo?: { repoPath: string; branch: string } | null;
  tracked?: boolean;
  answer?: OpOutcome;
}): RemoteRepoOpPort & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    remoteSessionInfo: () =>
      opts.tracked === false
        ? undefined
        : { workerId: WORKER_ID, ...(opts.repo === null ? {} : { repo: opts.repo ?? { repoPath: "/repo", branch: "feature/x" } }) },
    requestRepoOp: async (_sessionId, op) => {
      asked.push(op);
      return opts.answer ?? { ok: true, status: "updated", sha: "a".repeat(40) };
    },
  };
}

const alive: ProbeLiveness = async () => ({ liveness: "alive", reason: `worker ${WORKER_ID} is connected` });
const unknown: ProbeLiveness = async () => ({
  liveness: "unknown",
  reason: `worker ${WORKER_ID} is not connected (silent for 12s, within the 30m abandon bound)`,
});

const remoteSession = { id: "sess-1", workerId: WORKER_ID, startedAt: new Date().toISOString() };

describe("gateRemoteTurn — a remote follow-up turn syncs first, or is refused (#783)", () => {
  it("syncs the worker checkout and lets the turn through", async () => {
    const ops = fakeOps({ answer: { ok: true, status: "updated", sha: "b".repeat(40) } });

    const gate = await gateRemoteTurn({ session: remoteSession, ops, probeLiveness: alive });

    expect(gate.ok).toBe(true);
    expect(gate.ok && gate.status).toBe("synced");
    // The sync is what the turn waits on — not a push, and not nothing.
    expect(ops.asked).toEqual(["sync"]);
  });

  it("a HOST session is not touched at all", async () => {
    const ops = fakeOps({});
    const gate = await gateRemoteTurn({
      session: { id: "sess-host", workerId: null },
      ops,
      probeLiveness: alive,
    });
    expect(gate.ok && gate.status).toBe("not-remote");
    expect(ops.asked).toEqual([]);
  });

  it("a filesystem-SHARING worker needs no sync — it already works in the board's worktree", async () => {
    const ops = fakeOps({ repo: null });
    const gate = await gateRemoteTurn({ session: remoteSession, ops, probeLiveness: alive });
    expect(gate.ok && gate.status).toBe("not-remote");
    expect(ops.asked).toEqual([]);
  });

  it("REFUSES with a conflict when the worker checkout has DIVERGED — and asks for no reset", async () => {
    const ops = fakeOps({
      answer: { ok: false, status: "diverged", error: "the worker checkout (aaaaaaa1) is not an ancestor" },
    });

    const gate = await gateRemoteTurn({ session: remoteSession, ops, probeLiveness: alive });

    expect(gate.ok).toBe(false);
    expect(!gate.ok && gate.kind).toBe("conflict");
    expect(!gate.ok && gate.reason).toContain("not an ancestor");
    // Exactly one request, and it was the (fast-forward-only) sync. Nothing escalated.
    expect(ops.asked).toEqual(["sync"]);
  });

  it("REFUSES with a conflict when a fast-forward would overwrite the agent's uncommitted work", async () => {
    const ops = fakeOps({ answer: { ok: false, status: "dirty-held", error: "local changes would be overwritten" } });
    const gate = await gateRemoteTurn({ session: remoteSession, ops, probeLiveness: alive });
    expect(!gate.ok && gate.kind).toBe("conflict");
  });

  it("HOLDS on `unknown` liveness instead of assuming the checkout is fine (#783 item 3)", async () => {
    const ops = fakeOps({});

    const gate = await gateRemoteTurn({ session: remoteSession, ops, probeLiveness: unknown });

    expect(gate.ok).toBe(false);
    expect(!gate.ok && gate.kind).toBe("unprocessable");
    expect(!gate.ok && gate.status).toBe("unknown");
    // The decisive part: the sync was never even attempted, so nothing was written into a
    // checkout the board cannot see.
    expect(ops.asked).toEqual([]);
  });

  it("refuses when the worker never answers (timeout) rather than delivering the turn", async () => {
    const ops = fakeOps({ answer: { ok: false, status: "timeout", error: "did not answer within 60s" } });
    const gate = await gateRemoteTurn({ session: remoteSession, ops, probeLiveness: alive });
    expect(!gate.ok && gate.kind).toBe("unprocessable");
    expect(!gate.ok && gate.reason).toContain("did not answer");
  });

  it("refuses a session this process no longer tracks, and says to relaunch", async () => {
    const ops = fakeOps({ tracked: false });
    const gate = await gateRemoteTurn({ session: remoteSession, ops, probeLiveness: alive });
    expect(!gate.ok && gate.kind).toBe("unprocessable");
    expect(!gate.ok && gate.reason).toMatch(/relaunch/);
  });
});

describe("landRemoteMidSessionWork — a diff of a RUNNING remote session (#784)", () => {
  it("says nothing for a host session (the response shape stays unchanged)", async () => {
    const landing = await landRemoteMidSessionWork({
      session: { id: "s", workerId: null },
      ops: fakeOps({}),
      probeLiveness: alive,
    });
    expect(landing).toBeNull();
  });

  it("`unknown` liveness is reported as possibly-behind, NOT as 'no new work' (#784 item 4)", async () => {
    const ops = fakeOps({});

    const landing = await landRemoteMidSessionWork({ session: remoteSession, ops, probeLiveness: unknown });

    expect(landing).not.toBeNull();
    expect(landing!.landed).toBe(false);
    expect(landing!.liveness).toBe("unknown");
    expect(landing!.reason).toMatch(/may be missing work/);
    // No push was requested from a worker the board cannot see.
    expect(ops.asked).toEqual([]);
  });

  it("reports the push failure rather than presenting the old tree as current", async () => {
    const ops = fakeOps({ answer: { ok: false, status: "error", error: "connection reset" } });

    const landing = await landRemoteMidSessionWork({ session: remoteSession, ops, probeLiveness: alive });

    expect(landing!.landed).toBe(false);
    expect(landing!.reason).toContain("only what had already landed");
    expect(ops.asked).toEqual(["push"]);
  });
});

/** A project + issue + workspace whose session runs on `workerId` (or on the host). */
async function seedWorkspace(
  db: ReturnType<typeof createTestDb>["db"],
  workerId: string | null,
): Promise<{ workspaceId: string }> {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const statusId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();
  await db.insert(projects).values({
    id: projectId, name: "Fleet", repoPath: "/repo", repoName: "repo",
    defaultBranch: "master", createdAt: now, updatedAt: now,
  });
  await db.insert(projectStatuses).values([
    { id: statusId, projectId, name: "In Progress", sortOrder: 1, isDefault: false, createdAt: now },
  ]);
  await db.insert(issues).values({
    id: issueId, issueNumber: 783, title: "remote turn", priority: "high",
    sortOrder: 0, statusId, projectId, createdAt: now, updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch: "feature/ak-783-remote", workingDir: "/repo",
    baseBranch: "master", isDirect: false, status: "active", provider: "claude",
    createdAt: now, updatedAt: now,
  });
  await db.insert(sessions).values({
    id: randomUUID(), workspaceId, executor: "claude-code", status: "running",
    startedAt: now, triggerType: "chat", workerId,
  });
  return { workspaceId };
}

describe("POST /api/workspaces/:id/turn — the HTTP refusal (#783 item 2)", () => {
  let db: ReturnType<typeof createTestDb>["db"];
  beforeEach(() => { ({ db } = createTestDb()); });

  function mount(ops: RemoteRepoOpPort, probeLiveness: ProbeLiveness, sendTurn = vi.fn(() => ({ ok: true }))) {
    const sessionManager = {
      startSession: vi.fn(async () => "session-x"),
      stopSession: vi.fn(async () => true),
      sendTurn,
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      wsRoute: vi.fn(() => () => {}),
    };
    const app = new Hono();
    app.onError(domainErrorHandler);
    app.route(
      "/api/workspaces",
      createWorkspaceActionsRoute(() => sessionManager as never, db as never, {
        boardEvents: { broadcast: vi.fn(), broadcastActivity: vi.fn() } as never,
        remoteFleet: { ops, probeLiveness },
      }),
    );
    return { app, sendTurn };
  }

  function postTurn(app: Hono, workspaceId: string) {
    return app.request(`/api/workspaces/${workspaceId}/turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "keep going" }),
    });
  }

  it("delivers the turn once the worker checkout is synced", async () => {
    const { workspaceId } = await seedWorkspace(db, WORKER_ID);
    const ops = fakeOps({ answer: { ok: true, status: "updated", sha: "c".repeat(40) } });
    const { app, sendTurn } = mount(ops, alive);

    const res = await postTurn(app, workspaceId);

    expect(res.status).toBe(200);
    expect(sendTurn).toHaveBeenCalledTimes(1);
    expect(ops.asked).toEqual(["sync"]);
  });

  it("409 on a diverged worker checkout, and the turn NEVER reaches the agent", async () => {
    const { workspaceId } = await seedWorkspace(db, WORKER_ID);
    const ops = fakeOps({ answer: { ok: false, status: "diverged", error: "not an ancestor of the board's branch" } });
    const { app, sendTurn } = mount(ops, alive);

    const res = await postTurn(app, workspaceId);

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("diverged");
    expect(body.error).toContain("not an ancestor");
    // The whole point: a stale-checkout turn is not delivered.
    expect(sendTurn).not.toHaveBeenCalled();
  });

  it("422 when the sync could not complete at all (worker unreachable / liveness unknown)", async () => {
    const { workspaceId } = await seedWorkspace(db, WORKER_ID);
    const ops = fakeOps({});
    const { app, sendTurn } = mount(ops, unknown);

    const res = await postTurn(app, workspaceId);

    expect(res.status).toBe(422);
    expect(sendTurn).not.toHaveBeenCalled();
  });

  it("a HOST session is unaffected — no sync, straight through", async () => {
    const { workspaceId } = await seedWorkspace(db, null);
    const ops = fakeOps({});
    const { app, sendTurn } = mount(ops, alive);

    const res = await postTurn(app, workspaceId);

    expect(res.status).toBe(200);
    expect(sendTurn).toHaveBeenCalledTimes(1);
    expect(ops.asked).toEqual([]);
  });
});

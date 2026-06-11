/**
 * Tests for the GET /api/projects/:id/board conditional-GET fast path:
 *
 * A request whose If-None-Match matches the memoized ETag of the last served
 * response is answered 304 WITHOUT recomputing the board, as long as the
 * workspace-summary cache generation is unchanged and the memo is <60s old.
 * Every board-affecting mutation flows through boardEvents.broadcast(), which
 * bumps the generation — so the only drift the fast path can hide is
 * time-derived day-granularity fields (columnAgeDays/staleDays).
 *
 * 1. Fast-path 304 does not invoke the board builder (getBoard not called).
 * 2. A generation bump after a mutation broadcast forces a full compute.
 * 3. A different includeArchived query shape does not share the memo.
 * 4. A memo older than 60s recomputes.
 * 5. The ETag served on the full path is unchanged from the original
 *    algorithm (sha1 body hash, first 16 hex chars, quoted).
 * 6. Without boardEvents wired, the fast path is disabled (conservative).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { randomUUID, createHash } from "node:crypto";
import * as schema from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { createBoardEvents } from "../services/board-events.js";

const state = vi.hoisted(() => ({ getBoardCalls: 0 }));

vi.mock("../services/project.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/project.service.js")>();
  return {
    ...actual,
    createProjectService: (deps: Parameters<typeof actual.createProjectService>[0]) => {
      const svc = actual.createProjectService(deps);
      return {
        ...svc,
        getBoard: async (...args: Parameters<typeof svc.getBoard>) => {
          state.getBoardCalls += 1;
          return svc.getBoard(...args);
        },
      };
    },
  };
});

import { createProjectsRoute } from "../routes/projects.js";

type Db = ReturnType<typeof createTestDb>["db"];

let db: Db;
let projectId: string;

beforeEach(async () => {
  state.getBoardCalls = 0;

  db = createTestDb().db;
  const now = new Date().toISOString();
  projectId = randomUUID();

  await db.insert(schema.projects).values({
    id: projectId,
    name: "ETag Fast Path Test",
    repoPath: "/tmp/etag-fast-path-test",
    repoName: "etag-fast-path-test",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });

  const statusId = randomUUID();
  await db.insert(schema.projectStatuses).values({
    id: statusId,
    projectId,
    name: "Backlog",
    sortOrder: 0,
    isDefault: true,
    createdAt: now,
  });

  await db.insert(schema.issues).values({
    id: randomUUID(),
    issueNumber: 1,
    title: "Some issue",
    statusId,
    projectId,
    skipAutoReview: true,
    createdAt: now,
    updatedAt: now,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

function createApp(withBoardEvents = true) {
  const boardEvents = withBoardEvents ? createBoardEvents() : undefined;
  const app = new Hono();
  app.route("/api/projects", createProjectsRoute(db, boardEvents ? { boardEvents } : undefined));
  return { app, boardEvents };
}

async function getBoard(app: Hono, opts?: { etag?: string; includeArchived?: boolean }) {
  const qs = opts?.includeArchived ? "?includeArchived=true" : "";
  const res = await app.request(`/api/projects/${projectId}/board${qs}`, {
    headers: opts?.etag ? { "If-None-Match": opts.etag } : undefined,
  });
  return { status: res.status, etag: res.headers.get("ETag"), body: await res.text() };
}

describe("board conditional-GET fast path", () => {
  it("serves 304 from the memo without recomputing the board", async () => {
    const { app } = createApp();

    const first = await getBoard(app);
    expect(first.status).toBe(200);
    expect(first.etag).toBeTruthy();
    expect(state.getBoardCalls).toBe(1);

    const second = await getBoard(app, { etag: first.etag! });
    expect(second.status).toBe(304);
    expect(second.etag).toBe(first.etag);
    expect(second.body).toBe("");
    // The fast path must not have invoked the board builder again.
    expect(state.getBoardCalls).toBe(1);
  });

  it("a generation bump after a mutation broadcast forces a full compute", async () => {
    const { app, boardEvents } = createApp();

    const first = await getBoard(app);
    expect(first.status).toBe(200);
    await getBoard(app, { etag: first.etag! }); // fast-path 304
    expect(state.getBoardCalls).toBe(1);

    // A mutation arrives: broadcast bumps the cache generation via the
    // invalidation listener, so the memo no longer qualifies.
    boardEvents!.broadcast(projectId, "issue_updated");

    const third = await getBoard(app, { etag: first.etag! });
    // Data is unchanged, so the recomputed body hashes to the same ETag and the
    // existing body-hash comparison still yields a 304 — but via the FULL path.
    expect(third.status).toBe(304);
    expect(state.getBoardCalls).toBe(2);

    // The full compute refreshed the memo with the new generation, so the next
    // conditional GET takes the fast path again.
    const fourth = await getBoard(app, { etag: first.etag! });
    expect(fourth.status).toBe(304);
    expect(state.getBoardCalls).toBe(2);
  });

  it("a different includeArchived query shape does not share the memo", async () => {
    const { app } = createApp();

    const first = await getBoard(app);
    expect(first.status).toBe(200);
    expect(state.getBoardCalls).toBe(1);

    // Same project, different query shape: must NOT be served from the default
    // shape's memo — a full compute runs for the archived shape.
    await getBoard(app, { etag: first.etag!, includeArchived: true });
    expect(state.getBoardCalls).toBe(2);

    // The archived shape now has its own memo entry.
    const archived = await getBoard(app, { includeArchived: true });
    const archivedAgain = await getBoard(app, { etag: archived.etag!, includeArchived: true });
    expect(archivedAgain.status).toBe(304);
    const callsAfterArchivedMemoSet = state.getBoardCalls;

    // ...and the default shape's memo still works independently.
    const defaultAgain = await getBoard(app, { etag: first.etag! });
    expect(defaultAgain.status).toBe(304);
    expect(state.getBoardCalls).toBe(callsAfterArchivedMemoSet);
  });

  it("a memo older than 60s recomputes instead of fast-pathing", async () => {
    const { app } = createApp();
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] });

    const first = await getBoard(app);
    expect(first.status).toBe(200);
    expect(state.getBoardCalls).toBe(1);

    vi.setSystemTime(Date.now() + 61_000);

    const second = await getBoard(app, { etag: first.etag! });
    // Day-granularity fields have not crossed a boundary, so the body still
    // hashes to the same ETag — but the request paid the full compute path.
    expect(second.status).toBe(304);
    expect(state.getBoardCalls).toBe(2);
  });

  it("serves the ETag computed with the original body-hash algorithm on the full path", async () => {
    const { app } = createApp();

    const first = await getBoard(app);
    expect(first.status).toBe(200);
    const expectedEtag = `"${createHash("sha1").update(first.body).digest("hex").slice(0, 16)}"`;
    expect(first.etag).toBe(expectedEtag);
  });

  it("disables the fast path when boardEvents is not wired", async () => {
    const { app } = createApp(false);

    const first = await getBoard(app);
    expect(first.status).toBe(200);
    expect(state.getBoardCalls).toBe(1);

    // Without boardEvents, mutations would never bump the generation, so the
    // fast path must stay off: the conditional GET still recomputes fully
    // (and may 304 via the existing body-hash comparison).
    const second = await getBoard(app, { etag: first.etag! });
    expect(second.status).toBe(304);
    expect(state.getBoardCalls).toBe(2);
  });
});

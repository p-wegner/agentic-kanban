import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  preferences,
  projects as projectsTable,
  projectStatuses,
  issues,
  workspaces,
  sessions,
} from "@agentic-kanban/shared/schema";
import { buildProjectStatusRows, statusIdsByName } from "@agentic-kanban/shared/lib/project-statuses";
import type { WSContext } from "hono/ws";
import { Hono } from "hono";
import { createTestDb } from "./helpers/test-db.js";
import { createWorkersRoute } from "../routes/workers.js";
import type { Database } from "../db/index.js";
import {
  getWorkerFleet,
  workerDispatchPrefKey,
  workerStrictPrefKey,
  workerLabelsPrefKey,
  SHARES_FILESYSTEM_LABEL,
  type WorkerFleet,
} from "../services/worker-fleet.service.js";
import { allowedProfilesPrefKey } from "@agentic-kanban/shared/lib/profile-allowlist";
// The board refuses a worker that reports no protocol version, so every fixture
// registration must speak the current one.
import { WORKER_PROTOCOL_VERSION, type BoardToWorkerMessage } from "@agentic-kanban/shared/lib/worker-protocol";
import {
  explainPlacement,
  explainIssuePlacement,
  listSessionPlacements,
} from "../services/placement-explain.service.js";
import {
  HEALTH_PROBE_TIMEOUT_MS,
  UNRESPONSIVE_AFTER_TIMEOUTS,
  HEALTH_PROBE_SESSION_PREFIX,
} from "../services/worker-health-probe.service.js";

const PROJECT_ID = "bbbb1111-2222-3333-4444-555566667777";

function fakeWs(): WSContext {
  return { send: () => {}, close: () => {} } as unknown as WSContext;
}

/**
 * #755 — "why was #N not dispatched" must name the CHECK that decided, not just the
 * outcome. Every case below asserts `decidedBy`, and every case asserts
 * `agreesWithResolver`: the explanation is worthless if it disagrees with the
 * resolver it claims to describe.
 */
describe("placement explanation (#755)", () => {
  let db: Database;
  let fleet: WorkerFleet;

  beforeEach(() => {
    db = createTestDb().db as unknown as Database;
    fleet = getWorkerFleet(db);
  });

  const pref = (key: string, value: string) => db.insert(preferences).values({ key, value });

  async function seedProject(repoPath: string | null = "C:/some/repo") {
    await db.insert(projectsTable).values({
      id: PROJECT_ID,
      name: "explain-fixture",
      repoPath: repoPath ?? "",
      defaultBranch: "master",
    } as typeof projectsTable.$inferInsert);
  }

  async function connectWorker(overrides?: { labels?: string[]; providers?: string[]; maxConcurrency?: number }) {
    const { pairingToken } = fleet.registry.mintPairingToken();
    const result = await fleet.registry.registerWorker({
      pairingToken,
      name: "w1",
      protocolVersion: WORKER_PROTOCOL_VERSION,
      ...overrides,
    });
    if (!result.ok) throw new Error(result.error);
    fleet.connections.handleOpen(result.workerId, fakeWs());
    return result.workerId;
  }

  // NOT a default parameter: `explain(undefined)` must mean "no branch", and a
  // default would silently substitute one.
  const explain = (branch: string | null = "feature/1-x") =>
    explainPlacement({ database: db, projectId: PROJECT_ID, providerName: "claude", branch: branch ?? undefined });

  it("names the opt-in check when the project never asked for remote dispatch", async () => {
    const e = await explain();
    expect(e.decidedBy).toBe("dispatch_opt_in");
    expect(e.predicted).toEqual({ kind: "host" });
    expect(e.agreesWithResolver).toBe(true);
    // The quietest failure of the five gets the most explicit detail.
    expect(e.chain[0]!.detail).toContain("unset");
    expect(e.chain[0]!.prefKeys).toContain(workerDispatchPrefKey(PROJECT_ID));
    // Later checks are reported as unevaluated, not as passing.
    expect(e.chain.slice(1).every((c) => c.outcome === "not-reached")).toBe(true);
  });

  it("names the profile allowlist, before any worker is even considered (#651)", async () => {
    await pref(workerDispatchPrefKey(PROJECT_ID), "true");
    await pref(allowedProfilesPrefKey(PROJECT_ID), JSON.stringify([{ provider: "claude", name: "anth" }]));
    await connectWorker({ providers: ["claude"], labels: [SHARES_FILESYSTEM_LABEL] });
    const e = await explain();
    expect(e.decidedBy).toBe("profile_allowlist");
    expect(e.agreesWithResolver).toBe(true);
    // An eligible worker EXISTS; the allowlist still decides. That ordering is the
    // whole point of #651 and is what an operator gets wrong when guessing.
    expect(e.fleet.eligible).toBe(1);
    expect(e.chain.find((c) => c.id === "eligible_worker")!.outcome).toBe("not-reached");
  });

  it("names an UNRESPONSIVE worker as the reason, not 'offline' (#901)", async () => {
    // The failure that neither eligibility check could see: heartbeat fresh, socket up,
    // daemon wedged. The worker below is eligible on every other condition — that is the
    // point, because before this the board would have dispatched to it.
    vi.useFakeTimers();
    try {
      await pref(workerDispatchPrefKey(PROJECT_ID), "true");
      const workerId = await connectWorker({ providers: ["claude"], labels: [SHARES_FILESYSTEM_LABEL] });
      expect((await explain()).fleet.eligible).toBe(1);

      // Attest first: a worker that has never answered is exempt forever (#887), so
      // without this the rest of the test would prove nothing. The answer is fed through
      // the REAL `handleMessage`, so the wire parse and the listener fan-out are exercised
      // rather than stubbed.
      const sends: BoardToWorkerMessage[] = [];
      const send = vi.spyOn(fleet.connections, "send").mockImplementation((_id, message) => {
        sends.push(message);
        return true;
      });
      fleet.health.probeWorker(workerId);
      const asked = sends.at(-1) as Extract<BoardToWorkerMessage, { type: "probe_session" }>;
      expect(asked.sessionId.startsWith(HEALTH_PROBE_SESSION_PREFIX)).toBe(true);
      fleet.connections.handleMessage(
        workerId,
        JSON.stringify({
          type: "session_probe_result",
          sessionId: asked.sessionId,
          probe: { requestId: asked.requestId, state: "unknown" },
        }),
      );
      expect(fleet.health.stateFor(workerId)?.attested).toBe(true);

      for (let i = 0; i < UNRESPONSIVE_AFTER_TIMEOUTS; i++) {
        fleet.health.probeWorker(workerId);
        vi.advanceTimersByTime(HEALTH_PROBE_TIMEOUT_MS + 1);
        // Keep the heartbeat fresh across the advance. This is not test convenience — it IS
        // the case the ticket exists for: a daemon whose timer and socket layers still run
        // while it can no longer process a message. If the heartbeat stopped too, the board
        // would already mark it offline and there would be nothing to fix.
        await fleet.registry.touchHeartbeat(workerId);
      }

      const e = await explain();
      expect(e.decidedBy).toBe("eligible_worker");
      // The explanation and the resolver must agree — an explanation that disagrees with
      // the thing it describes is worse than none.
      expect(e.agreesWithResolver).toBe(true);
      expect(e.fleet.eligible).toBe(0);
      const reason = e.fleet.workers[0]!.ineligibleReason!;
      expect(reason).toMatch(/connected and heartbeating/);
      expect(reason).not.toMatch(/offline/);
      send.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("names which condition each worker fails, instead of one flat 'no eligible worker'", async () => {
    await pref(workerDispatchPrefKey(PROJECT_ID), "true");
    await pref(workerLabelsPrefKey(PROJECT_ID), "docker");
    await connectWorker({ providers: ["claude"], labels: ["windows"] });
    const e = await explain();
    expect(e.decidedBy).toBe("eligible_worker");
    expect(e.agreesWithResolver).toBe(true);
    const check = e.chain.find((c) => c.id === "eligible_worker")!;
    expect(check.detail).toContain("missing required label(s) [docker]");
    expect(e.fleet.workers[0]!.ineligibleReason).toContain("docker");
  });

  it("distinguishes a registered-but-disconnected worker from an offline one", async () => {
    await pref(workerDispatchPrefKey(PROJECT_ID), "true");
    const { pairingToken } = fleet.registry.mintPairingToken();
    const reg = await fleet.registry.registerWorker({
      pairingToken,
      name: "never-connected",
      protocolVersion: WORKER_PROTOCOL_VERSION,
    });
    if (!reg.ok) throw new Error(reg.error);
    const e = await explain();
    expect(e.decidedBy).toBe("eligible_worker");
    expect(e.fleet.workers[0]!.ineligibleReason).toContain("no WebSocket");
    expect(e.fleet.connected).toBe(0);
  });

  it("names the branch check for a direct workspace, and skips it for a shares-filesystem worker", async () => {
    await pref(workerDispatchPrefKey(PROJECT_ID), "true");
    await seedProject();
    await connectWorker({ providers: ["claude"] });
    const noBranch = await explain(null);
    expect(noBranch.decidedBy).toBe("branch_for_transport");
    expect(noBranch.agreesWithResolver).toBe(true);

    // Same situation, but the worker needs no git transport at all.
    db = createTestDb().db as unknown as Database;
    fleet = getWorkerFleet(db);
    await pref(workerDispatchPrefKey(PROJECT_ID), "true");
    await connectWorker({ providers: ["claude"], labels: [SHARES_FILESYSTEM_LABEL] });
    const shared = await explainPlacement({
      database: db,
      projectId: PROJECT_ID,
      providerName: "claude",
      branch: undefined,
    });
    expect(shared.decidedBy).toBeNull();
    expect(shared.predicted.kind).toBe("remote");
    expect(shared.chain.find((c) => c.id === "branch_for_transport")!.outcome).toBe("skipped");
    expect(shared.agreesWithResolver).toBe(true);
  });

  it("reports a strict project's refusal as a refusal, not a host fallback", async () => {
    await pref(workerDispatchPrefKey(PROJECT_ID), "true");
    await pref(workerStrictPrefKey(PROJECT_ID), "true");
    const e = await explain();
    expect(e.strict).toBe(true);
    expect(e.decidedBy).toBe("eligible_worker");
    expect(e.predicted.kind).toBe("refused");
    expect(e.actual.kind).toBe("refused");
    expect(e.agreesWithResolver).toBe(true);
  });

  it("reaches remote and holds no capacity slot for having asked", async () => {
    await pref(workerDispatchPrefKey(PROJECT_ID), "true");
    await seedProject();
    // shares-filesystem: the fixture repoPath does not exist on disk, and the #748
    // repo-shape check fails closed on a repo it cannot read. A worker that needs no
    // transport skips that check, which keeps this test about the reservation.
    const workerId = await connectWorker({
      providers: ["claude"],
      maxConcurrency: 1,
      labels: [SHARES_FILESYSTEM_LABEL],
    });
    const first = await explain();
    expect(first.decidedBy).toBeNull();
    expect(first.predicted).toEqual({ kind: "remote", workerId });
    expect(first.agreesWithResolver).toBe(true);
    // #751 made a remote placement reserve a slot. Explaining twice must not consume
    // the only slot on a maxConcurrency:1 worker — an observability call that changes
    // the answer is not an observation.
    const second = await explain();
    expect(second.predicted).toEqual({ kind: "remote", workerId });
    expect(second.fleet.freeSlots).toBe(1);
  });
});

describe("per-session placement (#755)", () => {
  let db: Database;
  let statusId: string;

  beforeEach(async () => {
    db = createTestDb().db as unknown as Database;
    await db.insert(projectsTable).values({
      id: PROJECT_ID,
      name: "explain-fixture",
      repoPath: "C:/some/repo",
      defaultBranch: "master",
    } as typeof projectsTable.$inferInsert);
    const rows = buildProjectStatusRows(PROJECT_ID, new Date().toISOString());
    for (const row of rows) await db.insert(projectStatuses).values(row);
    statusId = statusIdsByName(rows)["In Progress"]!;
  });

  async function seedIssueWithSessions(workerId: string | null) {
    await db.insert(issues).values({
      id: "issue-1",
      projectId: PROJECT_ID,
      statusId,
      title: "a ticket",
      issueNumber: 7,
    } as typeof issues.$inferInsert);
    await db.insert(workspaces).values({
      id: "ws-1",
      issueId: "issue-1",
      branch: "feature/7-a-ticket",
    } as typeof workspaces.$inferInsert);
    await db.insert(sessions).values({
      id: "sess-1",
      workspaceId: "ws-1",
      status: "completed",
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      workerId,
    } as typeof sessions.$inferInsert);
  }

  it("reports which machine a session actually ran on", async () => {
    await seedIssueWithSessions(null);
    const host = await listSessionPlacements({ database: db, issueId: "issue-1" });
    expect(host).toHaveLength(1);
    expect(host[0]!.placement).toBe("host");
    expect(host[0]!.issueNumber).toBe(7);
  });

  it("keeps a remote session attributable after its worker is revoked", async () => {
    await seedIssueWithSessions("worker-gone");
    const rows = await listSessionPlacements({ database: db, issueId: "issue-1" });
    expect(rows[0]!.placement).toBe("remote");
    expect(rows[0]!.workerId).toBe("worker-gone");
    // No row in `workers` — the session still says it ran remotely, and the caller
    // can tell "revoked worker" from "ran on the host". Collapsing both to null is
    // exactly the ambiguity that made #699 unreconstructable.
    expect(rows[0]!.workerName).toBeNull();
  });

  it("answers 'why was #N not dispatched' for a real issue, with its session history", async () => {
    await seedIssueWithSessions("worker-gone");
    const report = await explainIssuePlacement({ database: db, projectId: PROJECT_ID, issueNumber: 7 });
    expect("error" in report).toBe(false);
    if ("error" in report) return;
    expect(report.issue.issueNumber).toBe(7);
    expect(report.explanation.decidedBy).toBe("dispatch_opt_in");
    expect(report.explanation.branchSource).toBe("workspace");
    expect(report.explanation.branch).toBe("feature/7-a-ticket");
    expect(report.sessions).toHaveLength(1);
  });

  it("says when an unknown issue was asked about instead of explaining a fiction", async () => {
    const report = await explainIssuePlacement({ database: db, projectId: PROJECT_ID, issueNumber: 999 });
    expect("error" in report).toBe(true);
  });
});

describe("placement observability over HTTP (#755)", () => {
  it("answers 'why was #N not dispatched' and lists per-session placement", async () => {
    const db = createTestDb().db as unknown as Database;
    await db.insert(projectsTable).values({
      id: PROJECT_ID,
      name: "explain-fixture",
      repoPath: "C:/some/repo",
      defaultBranch: "master",
    } as typeof projectsTable.$inferInsert);
    const rows = buildProjectStatusRows(PROJECT_ID, new Date().toISOString());
    for (const row of rows) await db.insert(projectStatuses).values(row);
    await db.insert(issues).values({
      id: "issue-http",
      projectId: PROJECT_ID,
      statusId: statusIdsByName(rows)["In Progress"]!,
      title: "http ticket",
      issueNumber: 11,
    } as typeof issues.$inferInsert);

    const app = new Hono();
    app.route("/api/workers", createWorkersRoute(db));

    const res = await app.request(`/api/workers/explain?issue=11&projectId=${PROJECT_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      issue: { issueNumber: number };
      explanation: { decidedBy: string; summary: string; agreesWithResolver: boolean; chain: unknown[] };
    };
    expect(body.issue.issueNumber).toBe(11);
    expect(body.explanation.decidedBy).toBe("dispatch_opt_in");
    expect(body.explanation.agreesWithResolver).toBe(true);
    // Every check is reported, including the ones that were never reached — an
    // operator must be able to see WHERE the chain stopped, not just why.
    expect(body.explanation.chain).toHaveLength(6);

    const missing = await app.request(`/api/workers/explain?issue=999&projectId=${PROJECT_ID}`);
    expect(missing.status).toBe(404);
    const bad = await app.request(`/api/workers/explain?issue=abc&projectId=${PROJECT_ID}`);
    expect(bad.status).toBe(422);

    const placements = await app.request(`/api/workers/placements?projectId=${PROJECT_ID}`);
    expect(placements.status).toBe(200);
    expect((await placements.json()) as { placements: unknown[] }).toEqual({ placements: [] });
  });
});

// #754 item 6 — the fleet wire protocol had no version at all.
//
// `hello` and `register` carried nothing, and an unknown message type was dropped as
// "malformed", so a board and a worker built from different commits failed as a SILENCE:
// the worker connected, was ignored, reconnected, and no log on either side named the
// cause. With the dev-tarball distribution model (scripts/pack-worker.mjs, hand-copied to
// each machine) skew is the normal case, not an edge one.
//
// The policy these tests pin, which is the part worth arguing about:
//
//   A worker that reports NO version is ACCEPTED, not refused. A pre-handshake build
//   speaks exactly protocol 1, because protocol 1 IS the wire format as it stood when the
//   handshake was added — refusing it would refuse a machine that works perfectly, on a
//   fleet where the worker is on someone else's computer and upgrades are not
//   synchronised with the board's. The check earns its keep at the FIRST real bump: raise
//   MIN_SUPPORTED to 2 and every version-less worker is refused then, with a message that
//   names the fix.
//
// A refusal is 409 (not 401) and the daemon treats 409 as terminal: "we cannot agree" is
// the truth for a version mismatch, and a 401 would invite the retry loop that item 3 of
// this same ticket exists to remove.

import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import {
  checkProtocolCompatibility,
  MIN_SUPPORTED_WORKER_PROTOCOL_VERSION,
  PRE_HANDSHAKE_ASSUMED_PROTOCOL_VERSION,
  WORKER_PROTOCOL_VERSION,
  parseWorkerCapabilities,
  parseWorkerToBoardMessage,
} from "@agentic-kanban/shared/lib/worker-protocol";
import { createTestDb } from "./helpers/test-db.js";
import type { Database } from "../db/index.js";
import {
  createWorkerRegistry,
  PROTOCOL_MISMATCH_PREFIX,
  WORKER_HEARTBEAT_STALE_MS,
} from "../services/worker-registry.service.js";
import { createWorkersRoute } from "../routes/workers.js";

describe("checkProtocolCompatibility — the window, stated in tests (#754)", () => {
  it("accepts the version this build speaks", () => {
    expect(checkProtocolCompatibility(WORKER_PROTOCOL_VERSION)).toEqual({
      ok: true,
      version: WORKER_PROTOCOL_VERSION,
    });
  });

  it("ACCEPTS a worker that reports nothing, assuming the pre-handshake protocol", () => {
    // The deliberate compatibility window. Not generosity: a pre-handshake build speaks
    // exactly this protocol, so refusing it would refuse a working machine.
    expect(checkProtocolCompatibility(undefined)).toEqual({
      ok: true,
      version: PRE_HANDSHAKE_ASSUMED_PROTOCOL_VERSION,
    });
    // Malformed is treated the same way — a garbage field is not evidence of a new protocol.
    expect(checkProtocolCompatibility(Number.NaN).ok).toBe(true);
    expect(checkProtocolCompatibility(1.5).ok).toBe(true);
  });

  it("refuses a version older than the board supports, and says to upgrade the WORKER", () => {
    const outcome = checkProtocolCompatibility(1, { min: 2, current: 2 });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toMatch(/UPGRADE THE WORKER/);
    expect(outcome.ok === false && outcome.reason).toMatch(/pack-worker\.mjs/);
    expect(outcome.ok === false && outcome.reason).toMatch(/worker pair/);
  });

  it("closes the window at the first real bump — a version-less worker is refused THEN", () => {
    // This is the whole payoff of the handshake, so it is pinned now rather than trusted
    // to be remembered when MIN_SUPPORTED is finally raised.
    const outcome = checkProtocolCompatibility(undefined, { min: 2, current: 2 });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toMatch(/predates the handshake/);
    expect(outcome.ok === false && outcome.reason).toMatch(/UPGRADE THE WORKER/);
  });

  it("refuses a version NEWER than the board, and says to upgrade the BOARD", () => {
    const outcome = checkProtocolCompatibility(WORKER_PROTOCOL_VERSION + 1);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toMatch(/UPGRADE THE BOARD/);
  });

  it("keeps min <= current, so the window is never empty by construction", () => {
    expect(MIN_SUPPORTED_WORKER_PROTOCOL_VERSION).toBeLessThanOrEqual(WORKER_PROTOCOL_VERSION);
  });
});

describe("hello carries the version and the capabilities (#754)", () => {
  it("parses them when present", () => {
    const parsed = parseWorkerToBoardMessage(JSON.stringify({
      type: "hello",
      workerId: "w1",
      runningSessionIds: ["s1"],
      protocolVersion: 1,
      workerVersion: "0.4.2",
      capabilities: { labels: ["docker"], providers: ["claude"], maxConcurrency: 2 },
    }));
    expect(parsed).toEqual({
      type: "hello",
      workerId: "w1",
      runningSessionIds: ["s1"],
      protocolVersion: 1,
      workerVersion: "0.4.2",
      capabilities: { labels: ["docker"], providers: ["claude"], maxConcurrency: 2 },
    });
  });

  it("still PARSES a pre-handshake hello, so the board can answer it in words", () => {
    // Dropping it as malformed is the exact failure mode being removed: the board must be
    // able to refuse a peer, and it cannot refuse a message it threw away.
    const parsed = parseWorkerToBoardMessage(JSON.stringify({
      type: "hello", workerId: "w1", runningSessionIds: [],
    }));
    expect(parsed).toEqual({ type: "hello", workerId: "w1", runningSessionIds: [] });
  });

  it("drops ill-typed capability fields rather than trusting them", () => {
    expect(parseWorkerCapabilities({ labels: "docker" })).toBeUndefined();
    expect(parseWorkerCapabilities({ maxConcurrency: 0 })).toBeUndefined();
    expect(parseWorkerCapabilities({ maxConcurrency: -3 })).toBeUndefined();
    expect(parseWorkerCapabilities({ labels: ["a", 2, "b"] })).toEqual({ labels: ["a", "b"] });
    expect(parseWorkerCapabilities("nope")).toBeUndefined();
  });
});

describe("the board's side of the handshake (#754)", () => {
  let db: Database;
  let app: Hono;

  const register = (body: Record<string, unknown>) =>
    app.request("/api/workers/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  beforeEach(() => {
    db = createTestDb().db as unknown as Database;
    app = new Hono();
    app.route("/api/workers", createWorkersRoute(db, createWorkerRegistry(db)));
  });

  async function pairingToken(): Promise<string> {
    const res = await app.request("/api/workers/pairing-token", { method: "POST" });
    return ((await res.json()) as { pairingToken: string }).pairingToken;
  }

  it("registers a worker that declares nothing — the compatibility window, end to end", async () => {
    const res = await register({ pairingToken: await pairingToken(), name: "legacy-box" });
    expect(res.status).toBe(201);
  });

  it("registers a worker that declares the current protocol, and reports its build", async () => {
    const res = await register({
      pairingToken: await pairingToken(),
      name: "current-box",
      protocolVersion: WORKER_PROTOCOL_VERSION,
      workerVersion: "9.9.9",
    });
    expect(res.status).toBe(201);
    const listed = await (await app.request("/api/workers")).json() as {
      workers: Array<{ name: string; protocolVersion?: number; workerVersion?: string }>;
    };
    // "Which build is that machine running" was unanswerable from the board, and it is the
    // first question any skew bug raises.
    expect(listed.workers[0]).toMatchObject({
      name: "current-box",
      protocolVersion: WORKER_PROTOCOL_VERSION,
      workerVersion: "9.9.9",
    });
  });

  it("refuses a too-new worker with 409 and an actionable message", async () => {
    const res = await register({
      pairingToken: await pairingToken(),
      name: "from-the-future",
      protocolVersion: WORKER_PROTOCOL_VERSION + 5,
    });
    // 409, not 401: "we cannot agree" rather than "your credentials are wrong". The daemon
    // treats 409 as terminal, which is what stops the forever-retry.
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string; boardProtocolVersion: number };
    expect(body.error.startsWith(PROTOCOL_MISMATCH_PREFIX)).toBe(true);
    expect(body.error).toMatch(/UPGRADE THE BOARD/);
    expect(body.boardProtocolVersion).toBe(WORKER_PROTOCOL_VERSION);
  });

  it("keeps 401 for a bad pairing token, because auth is checked before negotiation", async () => {
    // Version negotiation must not answer an UNAUTHENTICATED caller: this endpoint is the
    // one HTTP surface the board exposes off-loopback, so it must not fingerprint itself.
    const res = await register({ pairingToken: "not-a-token", name: "x", protocolVersion: 999 });
    expect(res.status).toBe(401);
  });

  it("takes a worker that heartbeats an incompatible version OFFLINE at once", async () => {
    const res = await register({
      pairingToken: await pairingToken(),
      name: "upgraded-past-us",
      protocolVersion: WORKER_PROTOCOL_VERSION,
    });
    const { workerId, workerToken } = await res.json() as { workerId: string; workerToken: string };

    const beat = await app.request(`/api/workers/${workerId}/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", authorization: `Bearer ${workerToken}` },
      body: JSON.stringify({ protocolVersion: WORKER_PROTOCOL_VERSION + 1 }),
    });
    expect(beat.status).toBe(409);

    // Offline NOW, not in 90 s when the heartbeat happens to go stale — that is how the
    // refusal reaches the scheduler without any dispatch path having to know about
    // versions, since eligibleWorkers already skips anything not effectively online.
    const listed = await (await app.request("/api/workers")).json() as {
      workers: Array<{ effectiveStatus: string; status: string }>;
    };
    expect(listed.workers[0]!.status).toBe("offline");
    expect(listed.workers[0]!.effectiveStatus).toBe("offline");
    expect(WORKER_HEARTBEAT_STALE_MS).toBeGreaterThan(0); // the window it no longer waits for
  });

  it("a heartbeat re-declares capabilities, so a machine that gained docker says so", async () => {
    const res = await register({
      pairingToken: await pairingToken(),
      name: "grew-docker",
      labels: ["linux"],
      maxConcurrency: 1,
      protocolVersion: WORKER_PROTOCOL_VERSION,
    });
    const { workerId, workerToken } = await res.json() as { workerId: string; workerToken: string };

    const beat = await app.request(`/api/workers/${workerId}/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", authorization: `Bearer ${workerToken}` },
      body: JSON.stringify({
        protocolVersion: WORKER_PROTOCOL_VERSION,
        capabilities: { labels: ["linux", "docker"], providers: ["claude"], maxConcurrency: 4 },
      }),
    });
    expect(beat.status).toBe(200);

    // The regression: capabilities travelled only at first registration, and the daemon
    // skips registration once paired — so re-running `start --labels docker
    // --max-concurrency 4` changed nothing on the board while the local runner enforced
    // the NEW ceiling. Board and worker disagreed about the same machine.
    const listed = await (await app.request("/api/workers")).json() as {
      workers: Array<{ labels: string | null; providers: string | null; maxConcurrency: number }>;
    };
    expect(JSON.parse(listed.workers[0]!.labels!)).toEqual(["linux", "docker"]);
    expect(JSON.parse(listed.workers[0]!.providers!)).toEqual(["claude"]);
    expect(listed.workers[0]!.maxConcurrency).toBe(4);
  });

  it("says nothing about a capability the worker did not declare", async () => {
    // A worker that passes no --labels is saying nothing about labels, not "I have none";
    // wiping them on every beat would silently un-label a machine mid-fleet.
    const res = await register({
      pairingToken: await pairingToken(),
      name: "quiet",
      labels: ["gpu"],
      protocolVersion: WORKER_PROTOCOL_VERSION,
    });
    const { workerId, workerToken } = await res.json() as { workerId: string; workerToken: string };
    await app.request(`/api/workers/${workerId}/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", authorization: `Bearer ${workerToken}` },
      body: JSON.stringify({ protocolVersion: WORKER_PROTOCOL_VERSION, capabilities: { maxConcurrency: 2 } }),
    });
    const listed = await (await app.request("/api/workers")).json() as {
      workers: Array<{ labels: string | null; maxConcurrency: number }>;
    };
    expect(JSON.parse(listed.workers[0]!.labels!)).toEqual(["gpu"]);
    expect(listed.workers[0]!.maxConcurrency).toBe(2);
  });
});

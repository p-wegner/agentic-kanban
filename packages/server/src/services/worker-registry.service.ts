// Worker registry — board-side control plane for the worker fleet (epic #1,
// phase 1a #3).
//
// Trust model (mirrors the MCP HTTP bridge, http-transport.ts): the /api/workers
// surface is designed to be reachable OFF loopback, so worker-called endpoints
// authenticate with bearer tokens from day one. Two token kinds:
//  - PAIRING token: minted by the board owner (loopback UI/CLI), short-lived,
//    single-use, held in memory only — presented once at registration.
//  - WORKER token: issued at registration, returned to the worker exactly once,
//    stored here only as a sha-256 hash, verified with a constant-time compare.
// Board credentials never flow to workers; workers use their machine-local
// agent logins (enforced for launch specs by lib/remote-spec-env.ts, #244).
//
// Revocation is not just a row delete: `revokeWorker` also fires the registered
// revoke listeners, which close the worker's live WebSocket and invalidate its
// scoped git tokens (#247) — otherwise a revoked machine keeps streaming into
// in-flight sessions and keeps cloning/pushing until the board restarts.

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { db as realDb } from "../db/index.js";
import type { Database } from "../db/index.js";
import * as workerRepo from "../repositories/worker.repository.js";
import type { WorkerRow } from "../repositories/worker.repository.js";

export const PAIRING_TOKEN_TTL_MS = 10 * 60 * 1000;
/** A worker whose last heartbeat is older than this reads as offline. */
export const WORKER_HEARTBEAT_STALE_MS = 90 * 1000;

export const WORKER_STATUSES = ["online", "draining", "offline"] as const;
export type WorkerStatus = (typeof WORKER_STATUSES)[number];

export interface RegisterWorkerInput {
  pairingToken: string;
  name: string;
  os?: string;
  arch?: string;
  labels?: string[];
  providers?: string[];
  maxConcurrency?: number;
  /** Test seam for time-dependent behavior (pairing expiry). */
  now?: string;
}

/**
 * A worker as exposed to callers. `tokenHash` is deliberately OMITTED — it is a
 * credential digest, and shipping it to the UI/CLI would hand every board client
 * material to brute-force a worker token offline. It stays inside this service.
 */
export interface WorkerView extends Omit<WorkerRow, "tokenHash"> {
  /** Stored status downgraded to "offline" when the heartbeat is stale/absent. */
  effectiveStatus: WorkerStatus;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Constant-time compare that does not leak length via an early return. */
function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

function effectiveStatus(row: WorkerRow, nowMs: number): WorkerStatus {
  const stored = (WORKER_STATUSES as readonly string[]).includes(row.status)
    ? (row.status as WorkerStatus)
    : "offline";
  if (stored === "offline") return "offline";
  if (!row.lastHeartbeatAt) return "offline";
  const age = nowMs - new Date(row.lastHeartbeatAt).getTime();
  if (!Number.isFinite(age) || age > WORKER_HEARTBEAT_STALE_MS) return "offline";
  return stored;
}

export function createWorkerRegistry(database: Database = realDb) {
  /** Pending pairing tokens: sha256(token) -> expiry epoch ms. In-memory by design. */
  const pendingPairings = new Map<string, number>();

  function mintPairingToken(now?: string): { pairingToken: string; expiresAt: string } {
    const nowMs = now ? new Date(now).getTime() : Date.now();
    const token = randomBytes(32).toString("hex");
    const expiresAtMs = nowMs + PAIRING_TOKEN_TTL_MS;
    pendingPairings.set(sha256Hex(token), expiresAtMs);
    return { pairingToken: token, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  /** Verify AND consume a pairing token (single-use). */
  function consumePairingToken(token: string, nowMs: number): boolean {
    const hash = sha256Hex(token);
    const expiresAtMs = pendingPairings.get(hash);
    if (expiresAtMs === undefined) return false;
    pendingPairings.delete(hash);
    return nowMs <= expiresAtMs;
  }

  async function registerWorker(input: RegisterWorkerInput): Promise<
    | { ok: true; workerId: string; workerToken: string }
    | { ok: false; error: string }
  > {
    const now = input.now ?? new Date().toISOString();
    const nowMs = new Date(now).getTime();
    if (!input.name?.trim()) return { ok: false, error: "name is required" };
    if (!input.pairingToken || !consumePairingToken(input.pairingToken, nowMs)) {
      return { ok: false, error: "invalid or expired pairing token" };
    }
    const workerId = randomUUID();
    const workerToken = randomBytes(32).toString("hex");
    await workerRepo.insertWorker({
      id: workerId,
      name: input.name.trim(),
      os: input.os ?? null,
      arch: input.arch ?? null,
      labels: input.labels ? JSON.stringify(input.labels) : null,
      providers: input.providers ? JSON.stringify(input.providers) : null,
      maxConcurrency: input.maxConcurrency && input.maxConcurrency > 0 ? input.maxConcurrency : 1,
      status: "online",
      tokenHash: sha256Hex(workerToken),
      lastHeartbeatAt: now,
      createdAt: now,
      updatedAt: now,
    }, database);
    console.log(`[worker-registry] registered worker: id=${workerId} name=${input.name.trim()}`);
    return { ok: true, workerId, workerToken };
  }

  /** Bearer-token check for worker-called endpoints. A revoked worker fails closed. */
  async function authenticateWorker(workerId: string, token: string): Promise<boolean> {
    if (!workerId || !token) return false;
    const row = await workerRepo.getWorkerById(workerId, database);
    if (!row) return false;
    return tokensMatch(sha256Hex(token), row.tokenHash);
  }

  async function heartbeat(
    workerId: string,
    token: string,
    opts?: { status?: WorkerStatus; now?: string },
  ): Promise<{ ok: boolean; error?: string }> {
    if (!(await authenticateWorker(workerId, token))) {
      return { ok: false, error: "unauthorized" };
    }
    if (opts?.status && !WORKER_STATUSES.includes(opts.status)) {
      return { ok: false, error: `invalid status: ${opts.status}` };
    }
    const now = opts?.now ?? new Date().toISOString();
    await workerRepo.updateWorkerHeartbeat(workerId, now, opts?.status, database);
    return { ok: true };
  }

  async function listWorkersView(now?: string): Promise<WorkerView[]> {
    const nowMs = now ? new Date(now).getTime() : Date.now();
    const rows = await workerRepo.listWorkers(database);
    return rows.map((row) => {
      const { tokenHash: _tokenHash, ...safe } = row;
      return { ...safe, effectiveStatus: effectiveStatus(row, nowMs) };
    });
  }

  /**
   * Internal heartbeat refresh for callers that have ALREADY authenticated the
   * worker (e.g. traffic on its upgraded WebSocket). Never exposed to routes.
   */
  async function touchHeartbeat(workerId: string, now?: string): Promise<void> {
    await workerRepo.updateWorkerHeartbeat(workerId, now ?? new Date().toISOString(), undefined, database);
  }

  /**
   * Side effects that must accompany a revocation but live outside this service:
   * closing the worker's already-upgraded WebSocket and invalidating its scoped
   * git tokens. Registered by the fleet facade AFTER the connection manager
   * exists (it is built FROM this registry, so it cannot be a constructor dep).
   */
  const revokeListeners = new Set<(workerId: string) => void | Promise<void>>();

  function onRevoke(listener: (workerId: string) => void | Promise<void>): () => void {
    revokeListeners.add(listener);
    return () => revokeListeners.delete(listener);
  }

  async function revokeWorker(workerId: string): Promise<boolean> {
    const row = await workerRepo.getWorkerById(workerId, database);
    if (!row) return false;
    await workerRepo.deleteWorker(workerId, database);
    // Deleting the row only stops NEW authentications. A revoked worker also
    // holds a live socket and (for git transport) working git tokens — both must
    // die now, or "revoked" is a claim the code does not honour (#247).
    await Promise.allSettled([...revokeListeners].map(async (listener) => listener(workerId)));
    console.log(`[worker-registry] revoked worker: id=${workerId} name=${row.name}`);
    return true;
  }

  return {
    mintPairingToken, registerWorker, authenticateWorker, heartbeat, touchHeartbeat,
    listWorkersView, revokeWorker, onRevoke,
  };
}

export type WorkerRegistry = ReturnType<typeof createWorkerRegistry>;

/**
 * Per-database registry instances, so the REST route and the WS route share
 * ONE pairing-token pool for a given board process while tests with their own
 * DBs stay isolated.
 */
const registryByDb = new WeakMap<object, WorkerRegistry>();

export function getWorkerRegistry(database: Database = realDb): WorkerRegistry {
  let registry = registryByDb.get(database as object);
  if (!registry) {
    registry = createWorkerRegistry(database);
    registryByDb.set(database as object, registry);
  }
  return registry;
}

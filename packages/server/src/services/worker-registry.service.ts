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

import { randomUUID, timingSafeEqual } from "node:crypto";
import { createExpiringDigestStore, mintToken, sha256Hex } from "../lib/bearer-token.js";
import { db as realDb } from "../db/index.js";
import type { Database } from "../db/index.js";
import * as workerRepo from "../repositories/worker.repository.js";
import type { WorkerRow } from "../repositories/worker.repository.js";
import {
  checkProtocolCompatibility,
  WORKER_PROTOCOL_VERSION,
  type WorkerCapabilities,
} from "@agentic-kanban/shared/lib/worker-protocol";

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
  /** #754: the wire protocol this worker speaks. Absent = a pre-handshake build. */
  protocolVersion?: number;
  /** #754: the worker package build, for the panel and `worker list`. */
  workerVersion?: string;
  /** Test seam for time-dependent behavior (pairing expiry). */
  now?: string;
}

/**
 * Prefix on every refusal caused by a protocol mismatch (#754). Routes map it to 409 and
 * the daemon treats a 409 as FATAL rather than as one more thing to retry at 30s forever
 * — the whole point being that a version mismatch is not a transient condition.
 */
export const PROTOCOL_MISMATCH_PREFIX = "incompatible worker protocol:";

/**
 * A worker as exposed to callers. `tokenHash` is deliberately OMITTED — it is a
 * credential digest, and shipping it to the UI/CLI would hand every board client
 * material to brute-force a worker token offline. It stays inside this service.
 */
export interface WorkerView extends Omit<WorkerRow, "tokenHash"> {
  /** Stored status downgraded to "offline" when the heartbeat is stale/absent. */
  effectiveStatus: WorkerStatus;
  /**
   * The protocol and build this worker last reported (#754).
   *
   * Deliberately IN MEMORY rather than a `workers` column: it is a property of the
   * running peer, not of the pairing, and a board restart re-learns it from the next
   * heartbeat (<= 30 s) instead of showing a number that may already be a build old. The
   * ticket asks for a column too; that needs a migration and is not done here.
   */
  protocolVersion?: number;
  workerVersion?: string;
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
  /**
    * Pending pairing tokens, keyed by digest. In-memory by design. #556: this was a bare
    * `Map<hash, expiresAtMs>` that only ever deleted the entry it consumed, so an unclaimed
    * pairing token stayed in memory until the process exited; the shared store prunes on
    * every issue.
    */
  const pendingPairings = createExpiringDigestStore<true>({ ttlMs: PAIRING_TOKEN_TTL_MS });

  /** What each worker last told us about itself (#754). See WorkerView for why not a column. */
  const reportedVersions = new Map<string, { protocolVersion?: number; workerVersion?: string }>();

  function mintPairingToken(now?: string): { pairingToken: string; expiresAt: string } {
    const nowMs = now ? new Date(now).getTime() : Date.now();
    const token = pendingPairings.issue(true, { nowMs });
    return { pairingToken: token, expiresAt: new Date(nowMs + PAIRING_TOKEN_TTL_MS).toISOString() };
  }

  /** Verify AND consume a pairing token (single-use). */
  function consumePairingToken(token: string, nowMs: number): boolean {
    return pendingPairings.consume(token, nowMs) !== null;
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
    // AFTER the pairing token, deliberately (#754). This endpoint is the one HTTP surface
    // the board exposes off-loopback, and version negotiation is a capability answer: an
    // unauthenticated caller must not be able to fingerprint the board's protocol range.
    // It does cost a refused worker its single-use token — acceptable, because the refusal
    // says in words that re-pairing is part of the fix.
    const compatible = checkProtocolCompatibility(input.protocolVersion);
    if (!compatible.ok) {
      console.warn(`[worker-registry] refused registration of '${input.name.trim()}': ${compatible.reason}`);
      return { ok: false, error: `${PROTOCOL_MISMATCH_PREFIX} ${compatible.reason}` };
    }
    const workerId = randomUUID();
    const workerToken = mintToken();
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
    reportedVersions.set(workerId, {
      protocolVersion: input.protocolVersion,
      workerVersion: input.workerVersion,
    });
    console.log(
      `[worker-registry] registered worker: id=${workerId} name=${input.name.trim()} ` +
        `protocol=${input.protocolVersion ?? "?"} build=${input.workerVersion ?? "?"}`,
    );
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
    opts?: {
      status?: WorkerStatus;
      now?: string;
      /** #754: re-declared every beat, so the board tracks the machine as it is now. */
      capabilities?: WorkerCapabilities;
      protocolVersion?: number;
      workerVersion?: string;
    },
  ): Promise<{ ok: boolean; error?: string }> {
    if (!(await authenticateWorker(workerId, token))) {
      return { ok: false, error: "unauthorized" };
    }
    if (opts?.status && !WORKER_STATUSES.includes(opts.status)) {
      return { ok: false, error: `invalid status: ${opts.status}` };
    }
    const now = opts?.now ?? new Date().toISOString();
    // #754: a worker that UPGRADED into incompatibility (or downgraded) must stop being a
    // placement candidate now, not in 90 s when its heartbeat happens to go stale. Marking
    // it offline is how the refusal reaches the scheduler: `eligibleWorkers` already skips
    // anything not effectively online, so no dispatch path needs to know about versions.
    if (opts && "protocolVersion" in opts) {
      const compatible = checkProtocolCompatibility(opts.protocolVersion);
      if (!compatible.ok) {
        reportedVersions.set(workerId, {
          protocolVersion: opts.protocolVersion,
          workerVersion: opts.workerVersion,
        });
        await workerRepo.updateWorkerStatus(workerId, "offline", now, database);
        console.warn(`[worker-registry] worker ${workerId} taken offline: ${compatible.reason}`);
        return { ok: false, error: `${PROTOCOL_MISMATCH_PREFIX} ${compatible.reason}` };
      }
      reportedVersions.set(workerId, {
        protocolVersion: opts.protocolVersion,
        workerVersion: opts.workerVersion,
      });
    }
    await workerRepo.updateWorkerHeartbeat(workerId, now, opts?.status, database);
    if (opts?.capabilities) {
      await workerRepo.updateWorkerCapabilities(workerId, opts.capabilities, now, database);
    }
    return { ok: true };
  }

  async function listWorkersView(now?: string): Promise<WorkerView[]> {
    const nowMs = now ? new Date(now).getTime() : Date.now();
    const rows = await workerRepo.listWorkers(database);
    return rows.map((row) => {
      const { tokenHash: _tokenHash, ...safe } = row;
      const reported = reportedVersions.get(row.id);
      return {
        ...safe,
        effectiveStatus: effectiveStatus(row, nowMs),
        ...(reported?.protocolVersion !== undefined ? { protocolVersion: reported.protocolVersion } : {}),
        ...(reported?.workerVersion !== undefined ? { workerVersion: reported.workerVersion } : {}),
      };
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
    reportedVersions.delete(workerId);
    // Deleting the row only stops NEW authentications. A revoked worker also
    // holds a live socket and (for git transport) working git tokens — both must
    // die now, or "revoked" is a claim the code does not honour (#247).
    await Promise.allSettled([...revokeListeners].map(async (listener) => listener(workerId)));
    console.log(`[worker-registry] revoked worker: id=${workerId} name=${row.name}`);
    return true;
  }

  /** What the board itself speaks — surfaced so a route can report both sides (#754). */
  function boardProtocolVersion(): number {
    return WORKER_PROTOCOL_VERSION;
  }

  return {
    mintPairingToken, registerWorker, authenticateWorker, heartbeat, touchHeartbeat,
    listWorkersView, revokeWorker, onRevoke, boardProtocolVersion,
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

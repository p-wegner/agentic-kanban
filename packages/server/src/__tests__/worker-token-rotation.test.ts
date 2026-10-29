import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb } from "./helpers/test-db.js";
import {
  createWorkerRegistry,
  WORKER_TOKEN_TTL_MS,
  WORKER_TOKEN_ROTATE_GRACE_MS,
  type WorkerRegistry,
} from "../services/worker-registry.service.js";
import type { Database } from "../db/index.js";
import { tokenNeedsRotation } from "../worker/worker-token-rotation.js";
import { parseBoardToWorkerMessage, parseWorkerToBoardMessage } from "@agentic-kanban/shared/lib/worker-protocol";

describe("worker token expiry + rotation (#1766)", () => {
  let registry: WorkerRegistry;
  beforeEach(() => {
    registry = createWorkerRegistry(createTestDb().db as unknown as Database);
  });

  async function pair() {
    const { pairingToken } = registry.mintPairingToken();
    const r = await registry.registerWorker({ pairingToken, name: "w" });
    if (!r.ok) throw new Error(r.error);
    return r;
  }

  it("issues a ~30d expiry and rejects the token afterwards", async () => {
    const r = await pair();
    expect(Date.parse(r.tokenExpiresAt) - Date.now()).toBeGreaterThan(WORKER_TOKEN_TTL_MS - 60_000);
    expect(await registry.authenticateWorker(r.workerId, r.workerToken)).toBe(true);
    expect(await registry.authenticateWorker(r.workerId, r.workerToken, Date.parse(r.tokenExpiresAt) + 1)).toBe(false);
    const [view] = await registry.listWorkersView();
    expect(view.tokenExpiresAt).toBe(r.tokenExpiresAt);
    expect(JSON.stringify(view)).not.toContain("prevTokenHash");
  });

  it("rotation returns a new token and keeps the old one for the grace window only", async () => {
    const r = await pair();
    const rot = await registry.rotateWorkerToken(r.workerId);
    expect(rot).not.toBeNull();
    expect(rot!.workerToken).not.toBe(r.workerToken);
    expect(await registry.authenticateWorker(r.workerId, rot!.workerToken)).toBe(true);
    expect(await registry.authenticateWorker(r.workerId, r.workerToken)).toBe(true);
    expect(await registry.authenticateWorker(r.workerId, r.workerToken, Date.now() + WORKER_TOKEN_ROTATE_GRACE_MS + 1000)).toBe(false);
  });

  it("an unknown worker cannot rotate", async () => {
    expect(await registry.rotateWorkerToken("nope")).toBeNull();
  });

  it("worker side rotates when expiry is unknown or near", () => {
    expect(tokenNeedsRotation({})).toBe(true);
    expect(tokenNeedsRotation({ tokenExpiresAt: new Date(Date.now() + 29 * 86400_000).toISOString() })).toBe(false);
    expect(tokenNeedsRotation({ tokenExpiresAt: new Date(Date.now() + 5 * 86400_000).toISOString() })).toBe(true);
  });

  it("parses both rotation frames", () => {
    expect(parseWorkerToBoardMessage(JSON.stringify({ type: "token_rotate_request", requestId: "a" }))).toEqual({ type: "token_rotate_request", requestId: "a" });
    expect(parseBoardToWorkerMessage(JSON.stringify({ type: "token_rotate", requestId: "a", workerToken: "t", tokenExpiresAt: "x" }))).toEqual({ type: "token_rotate", requestId: "a", workerToken: "t", tokenExpiresAt: "x" });
  });
});

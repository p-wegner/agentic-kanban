// #880 — the read-only update-check for a standing worker runner.
//
// What these tests pin, from the ticket:
//  * REPORT, NEVER APPLY — the rendered report states in words that nothing was
//    downloaded, installed, or restarted, and the module has no code path that could;
//  * the remediation steps are the SHARED WORKER_UPDATE_REMEDIATION constant — the same
//    text the 409 protocol-refusal message uses — never a second copy that can drift;
//  * the board's build is served authenticated (per-worker bearer token) on the
//    worker-facing surface, because an unauthenticated caller must not be able to
//    fingerprint the board's build (#754's own rule, extended to #880's endpoint);
//  * "behind" is not an error: the command's failure mode is a check that could not run,
//    never a worker that merely needs updating.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WORKER_PROTOCOL_VERSION,
  WORKER_UPDATE_REMEDIATION,
} from "@agentic-kanban/shared/lib/worker-protocol";
import { createTestDb } from "./helpers/test-db.js";
import type { Database } from "../db/index.js";
import { createWorkerRegistry } from "../services/worker-registry.service.js";
import { createFleetWorkersRoute } from "../routes/workers.js";
import { resolveOwnPackageVersion } from "../lib/worker-build.js";
import {
  renderUpdateCheckReport,
  runWorkerUpdateCheck,
  type UpdateCheckReport,
} from "../cli/commands/worker-update-check.js";

describe("GET /api/workers/:id/update-check — the board's side (#880)", () => {
  let db: Database;
  let app: Hono;
  let registry: ReturnType<typeof createWorkerRegistry>;

  beforeEach(() => {
    db = createTestDb().db as unknown as Database;
    registry = createWorkerRegistry(db);
    app = new Hono();
    // The WORKER-FACING subset on purpose: this endpoint must be reachable from the fleet
    // port, where a remote worker actually lives — the board API is loopback-only.
    app.route("/api/workers", createFleetWorkersRoute(db, registry));
  });

  async function pairWorker(): Promise<{ workerId: string; workerToken: string }> {
    // The fleet surface has no pairing-token mint (owner-only), so mint on the SAME
    // registry instance the route was built from — pairing pools are per instance.
    const { pairingToken } = registry.mintPairingToken();
    const res = await app.request("/api/workers/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairingToken, name: "box", protocolVersion: WORKER_PROTOCOL_VERSION }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as { workerId: string; workerToken: string };
  }

  it("answers the board's protocol AND build to an authenticated worker", async () => {
    const { workerId, workerToken } = await pairWorker();
    const res = await app.request(`/api/workers/${workerId}/update-check`, {
      headers: { authorization: `Bearer ${workerToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { boardProtocolVersion: number; boardWorkerVersion: string | null };
    expect(body.boardProtocolVersion).toBe(WORKER_PROTOCOL_VERSION);
    expect(body.boardWorkerVersion).toBe(resolveOwnPackageVersion());
  });

  it("refuses an unauthenticated caller with 401 — the build must not be fingerprintable", async () => {
    const { workerId } = await pairWorker();
    const bare = await app.request(`/api/workers/${workerId}/update-check`);
    expect(bare.status).toBe(401);
    const wrong = await app.request(`/api/workers/${workerId}/update-check`, {
      headers: { authorization: "Bearer not-the-token" },
    });
    expect(wrong.status).toBe(401);
    expect(JSON.stringify(await wrong.json())).not.toContain("boardWorkerVersion");
  });
});

describe("runWorkerUpdateCheck — the worker's side (#880)", () => {
  let dir: string;
  let stateFile: string;
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ak-update-check-"));
    stateFile = join(dir, "worker-state.json");
    writeFileSync(
      stateFile,
      JSON.stringify({
        boards: { "http://board:3003": { workerId: "w1", workerToken: "t1", name: "box" } },
      }),
    );
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
  });

  function stubBoard(status: number, body: unknown): void {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })) as typeof fetch;
  }

  it("reports BEHIND with the shared remediation steps — the same text as the 409 refusal", async () => {
    stubBoard(200, { boardProtocolVersion: WORKER_PROTOCOL_VERSION, boardWorkerVersion: "9.9.9" });
    const report = await runWorkerUpdateCheck({
      boardUrl: "http://board:3003",
      stateFile,
      workerVersion: "0.0.1",
    });
    expect(report.ok).toBe(true);
    expect(report.freshness).toBe("behind-board");
    // The constant itself, not a paraphrase: two copies is how remediation text drifts.
    expect(report.remediation).toBe(WORKER_UPDATE_REMEDIATION);
    const text = renderUpdateCheckReport(report);
    expect(text).toContain("pack-worker.mjs");
    expect(text).toContain("behind board");
  });

  it("reports AHEAD as normal, with NO remediation — never a bare 'outdated'", async () => {
    stubBoard(200, { boardProtocolVersion: WORKER_PROTOCOL_VERSION, boardWorkerVersion: "0.0.1" });
    const report = await runWorkerUpdateCheck({
      boardUrl: "http://board:3003",
      stateFile,
      workerVersion: "9.9.9",
    });
    expect(report.ok).toBe(true);
    expect(report.freshness).toBe("ahead-of-board");
    expect(report.remediation).toBeNull();
    const text = renderUpdateCheckReport(report);
    expect(text).toContain("ahead of board");
    expect(text).not.toMatch(/outdated/i);
  });

  it("stays a REPORT: every rendering says nothing was downloaded, installed, or restarted", async () => {
    stubBoard(200, { boardProtocolVersion: WORKER_PROTOCOL_VERSION, boardWorkerVersion: "9.9.9" });
    const behind = await runWorkerUpdateCheck({ boardUrl: "http://board:3003", stateFile, workerVersion: "0.0.1" });
    const unpaired = await runWorkerUpdateCheck({ boardUrl: "http://other:3003", stateFile });
    for (const report of [behind, unpaired]) {
      expect(renderUpdateCheckReport(report)).toContain("nothing was downloaded, installed, or restarted");
    }
  });

  it("fails the CHECK (not the worker) when no pairing exists, and says how to pair", async () => {
    const report = await runWorkerUpdateCheck({ boardUrl: "http://unpaired:3003", stateFile });
    expect(report.ok).toBe(false);
    expect(report.freshness).toBe("unknown");
    expect(report.error).toContain("worker pair");
  });

  it("names an old board (404) instead of inventing a build diff", async () => {
    stubBoard(404, { error: "not found" });
    const report = await runWorkerUpdateCheck({ boardUrl: "http://board:3003", stateFile, workerVersion: "1.0.0" });
    expect(report.ok).toBe(false);
    expect(report.error).toContain("predates this command");
    expect(report.boardWorkerVersion).toBeNull();
  });

  it("keeps an absent own version as '?', never fabricating one", () => {
    const report: UpdateCheckReport = {
      boardUrl: "http://board:3003",
      workerVersion: null,
      boardWorkerVersion: "0.1.9",
      workerProtocolVersion: WORKER_PROTOCOL_VERSION,
      boardProtocolVersion: WORKER_PROTOCOL_VERSION,
      freshness: "unknown",
      error: null,
      remediation: null,
      ok: true,
    };
    const text = renderUpdateCheckReport(report);
    expect(text).toContain("this install's build: ?");
    expect(text).toContain("unknown");
  });
});

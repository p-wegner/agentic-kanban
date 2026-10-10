// #1358 — a fresh machine downloads the worker build with its PAIRING token.
// /build and /build/tarball accept an unexpired pairing token without consuming it; every
// other worker endpoint still refuses it. `worker pair` prints the bootstrap commands.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WORKER_PROTOCOL_VERSION } from "@agentic-kanban/shared/lib/worker-protocol";
import { createTestDb } from "./helpers/test-db.js";
import type { Database } from "../db/index.js";
import { createWorkerRegistry } from "../services/worker-registry.service.js";
import { createFleetWorkersRoute } from "../routes/workers.js";
import type { WorkerBuildService } from "../services/worker-build.service.js";
import { renderBootstrapSteps, renderWorkerSetupGuide } from "../cli/commands/worker-setup-guide.js";

describe("pairing token on the build routes (#1358)", () => {
  let db: Database;
  let dir: string;
  let registry: ReturnType<typeof createWorkerRegistry>;
  let app: Hono;
  const tarBytes = Buffer.from("tarball bytes");

  beforeEach(() => {
    db = createTestDb().db as unknown as Database;
    dir = mkdtempSync(join(tmpdir(), "ak-pairing-build-"));
    const tarballPath = join(dir, "w.tgz");
    writeFileSync(tarballPath, tarBytes);
    const service: WorkerBuildService = {
      currentBuildId: async () => "ab".repeat(20),
      getBuild: async () => ({
        state: "ready",
        tarballPath,
        manifest: {
          version: "0.0.1", buildId: "ab".repeat(20), size: tarBytes.length,
          sha256: createHash("sha256").update(tarBytes).digest("hex"),
          boardWorkerVersion: "0.0.1", protocolVersion: WORKER_PROTOCOL_VERSION,
        },
      }),
      prewarm: async () => {},
    };
    registry = createWorkerRegistry(db);
    app = new Hono();
    app.route("/api/workers", createFleetWorkersRoute(db, registry, service));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("allows /build and /build/tarball with an unexpired pairing token, without consuming it", async () => {
    const { pairingToken } = registry.mintPairingToken();
    for (const path of ["/api/workers/build", "/api/workers/build/tarball"]) {
      expect((await app.request(path, { headers: { authorization: `Bearer ${pairingToken}` } })).status).toBe(200);
      expect((await app.request(path, { headers: { "x-pairing-token": pairingToken } })).status).toBe(200);
      expect((await app.request(`${path}?token=${pairingToken}`)).status).toBe(200);
    }
    // Still unconsumed: it can register afterwards.
    const reg = await app.request("/api/workers/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairingToken, name: "fresh", protocolVersion: WORKER_PROTOCOL_VERSION }),
    });
    expect(reg.status).toBe(201);
  });

  it("refuses an expired or unknown pairing token", async () => {
    const past = new Date(Date.now() - 24 * 3600_000).toISOString();
    const { pairingToken } = registry.mintPairingToken(past);
    expect((await app.request("/api/workers/build", { headers: { authorization: `Bearer ${pairingToken}` } })).status).toBe(401);
    expect((await app.request("/api/workers/build", { headers: { authorization: "Bearer nope" } })).status).toBe(401);
  });

  it("still refuses a pairing token on every other worker endpoint", async () => {
    const { pairingToken } = registry.mintPairingToken();
    const headers = { authorization: `Bearer ${pairingToken}`, "Content-Type": "application/json" };
    const probes: Array<[string, string]> = [
      ["GET", "/api/workers/some-id/update-check"],
      ["POST", "/api/workers/some-id/heartbeat"],
    ];
    for (const [method, path] of probes) {
      const res = await app.request(path, { method, headers, body: method === "POST" ? "{}" : undefined });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });
});

describe("worker pair bootstrap output + setup guide (#1358)", () => {
  it("prints download, sha256 verify, install and start with the token and board", () => {
    const out = renderBootstrapSteps("http://100.1.2.3:3002/", "TOK123");
    expect(out).toContain("http://100.1.2.3:3002/api/workers/build/tarball");
    expect(out).toContain("sha256");
    expect(out).toContain("npm i -g");
    expect(out).toContain("start --board http://100.1.2.3:3002 --token TOK123");
  });

  it("ships a setup guide with the sections doctor remedies cite", () => {
    const guide = renderWorkerSetupGuide();
    for (const n of [1, 6, 7, 8]) expect(guide).toContain(`\n${n}. `);
  });
});

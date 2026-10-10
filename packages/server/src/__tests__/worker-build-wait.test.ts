// #1366 - `?wait=<s>` on the build routes, the pairing build-mismatch warning, and the printed steps.
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
import type { WorkerBuildLookup, WorkerBuildService } from "../services/worker-build.service.js";
import { renderBootstrapSteps } from "../cli/commands/worker-setup-guide.js";
import { checkBoardBuild, compareWithBoardBuild, renderBuildMismatch } from "../cli/commands/worker-board-build.js";

describe("build routes ?wait (#1366)", () => {
  let db: Database;
  let dir: string;
  let token: string;
  let app: Hono;
  let lookups: WorkerBuildLookup[];
  let calls: number;
  const bytes = Buffer.from("tarball bytes");

  beforeEach(() => {
    db = createTestDb().db as unknown as Database;
    dir = mkdtempSync(join(tmpdir(), "ak-build-wait-"));
    const tarballPath = join(dir, "w.tgz");
    writeFileSync(tarballPath, bytes);
    const ready: WorkerBuildLookup = {
      state: "ready",
      tarballPath,
      manifest: {
        version: "0.0.1", buildId: "ab".repeat(20), size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        boardWorkerVersion: "0.0.1", protocolVersion: WORKER_PROTOCOL_VERSION,
      },
    };
    lookups = [ready];
    calls = 0;
    const service: WorkerBuildService = {
      currentBuildId: async () => "ab".repeat(20),
      // Plays `lookups` in order, then repeats the last one.
      getBuild: async () => lookups[Math.min(calls++, lookups.length - 1)]!,
      prewarm: async () => {},
    };
    const registry = createWorkerRegistry(db);
    token = registry.mintPairingToken().pairingToken;
    app = new Hono();
    app.route("/api/workers", createFleetWorkersRoute(db, registry, service));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const get = (path: string) => app.request(path, { headers: { authorization: `Bearer ${token}` } });
  const building: WorkerBuildLookup = { state: "building" };

  it("ready: answers immediately with the manifest / tarball", async () => {
    expect((await get("/api/workers/build?wait=5")).status).toBe(200);
    expect((await get("/api/workers/build/tarball?wait=5")).status).toBe(200);
    expect(calls).toBe(2);
  });

  it("still building: waits, then answers 200 once ready", async () => {
    lookups = [building, building, lookups[0]!];
    const res = await get("/api/workers/build?wait=5");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { buildId: string }).buildId).toBe("ab".repeat(20));
    expect(calls).toBe(3);
  });

  it("tarball: waits through a build too", async () => {
    lookups = [building, lookups[0]!];
    const res = await get("/api/workers/build/tarball?wait=5");
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true);
  });

  it("timeout: a >= 400 status on both routes (curl -f fails)", async () => {
    lookups = [building];
    for (const path of ["/api/workers/build?wait=0.3", "/api/workers/build/tarball?wait=0.3"]) {
      const res = await get(path);
      expect(res.status, path).toBeGreaterThanOrEqual(400);
    }
  });

  it("without the flag the plain 202 / 409 answers are unchanged (daemon updater, #1352)", async () => {
    lookups = [building];
    expect((await get("/api/workers/build")).status).toBe(202);
    expect((await get("/api/workers/build/tarball")).status).toBe(409);
  });
});

describe("pairing build-mismatch warning (#1366)", () => {
  const fetchBuild = (buildId: string, status = 200): typeof fetch =>
    (async () => new Response(JSON.stringify({ buildId }), { status })) as unknown as typeof fetch;

  it("flags a worker on a different build than the board", async () => {
    const cmp = await compareWithBoardBuild({
      boardUrl: "http://b:1", token: "t", ownVersion: "0.1.9-dev.b3076a5b2", fetchImpl: fetchBuild("4d0ce27b6" + "0".repeat(31)),
    });
    expect(cmp).toMatchObject({ state: "differs", own: "b3076a5b2" });
    if (cmp.state !== "differs") throw new Error("unreachable");
    const line = renderBuildMismatch(cmp.own, cmp.board);
    expect(line).toContain("this worker runs b3076a5b2, the board serves 4d0ce27b6");
    expect(line).toContain("update-check --apply");
  });

  it("is quiet when the builds match (short sha vs full sha)", async () => {
    const cmp = await compareWithBoardBuild({
      boardUrl: "http://b:1", token: "t", ownVersion: "0.1.9-dev.4d0ce27b6", fetchImpl: fetchBuild("4d0ce27b6" + "0".repeat(31)),
    });
    expect(cmp.state).toBe("same");
  });

  it("is unknown (not a warning) when the board cannot answer", async () => {
    const cmp = await compareWithBoardBuild({
      boardUrl: "http://b:1", token: "t", ownVersion: "0.1.9-dev.4d0ce27b6", fetchImpl: fetchBuild("x", 504),
    });
    expect(cmp.state).toBe("unknown");
  });

  it("doctor's board-build check WARNs on a mismatch instead of passing", async () => {
    const check = await checkBoardBuild({
      boardUrl: "http://b:1", token: "t", ownVersion: "0.1.9-dev.b3076a5b2", fetchImpl: fetchBuild("4d0ce27b6" + "0".repeat(31)),
    });
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("the board serves 4d0ce27b6");
    expect(check.detail).toContain("update-check --apply");
  });
});

describe("bootstrap step text (#1366)", () => {
  it("passes the wait flag on both fetches and says what a timeout does", () => {
    const out = renderBootstrapSteps("http://100.1.2.3:3002", "TOK");
    expect(out).toContain("/api/workers/build?wait=120");
    expect(out).toContain("/api/workers/build/tarball?wait=120");
    expect(out).toContain("504");
    expect(out).not.toContain("answers 202");
  });
});

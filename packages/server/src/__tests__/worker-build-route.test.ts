// #1338 — the board serves its worker build, and asks workers to update, on the fleet surface.
//
// Pinned here: both build routes need a valid WORKER bearer token (no token / a wrong token =
// 401, and the body names nothing about the build); a ready build is served with a manifest
// whose sha256/size describe the bytes actually streamed; a build still being packed answers
// 202 rather than an error; the heartbeat advertises the board's build id and carries a
// board-side `worker update` as `updateNow` until the worker is on it.
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
import { createFleetWorkersRoute, createWorkersRoute } from "../routes/workers.js";
import { createWorkerBuildService, type WorkerBuildLookup, type WorkerBuildService } from "../services/worker-build.service.js";
import type { WorkerBuildManifest } from "../lib/worker-update.js";

const BUILD_ID = "ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12";

describe("worker build routes + update request (#1338)", () => {
  let db: Database;
  let dir: string;
  let registry: ReturnType<typeof createWorkerRegistry>;
  let app: Hono;
  let lookup: WorkerBuildLookup;
  const tarBytes = Buffer.from("not really a tarball, but bytes are bytes");

  const service: WorkerBuildService = {
    currentBuildId: async () => BUILD_ID,
    getBuild: async () => lookup,
    prewarm: async () => {},
  };

  beforeEach(() => {
    db = createTestDb().db as unknown as Database;
    dir = mkdtempSync(join(tmpdir(), "ak-worker-build-route-"));
    const tarballPath = join(dir, "worker.tgz");
    writeFileSync(tarballPath, tarBytes);
    const manifest: WorkerBuildManifest = {
      version: "0.1.9-dev.ab12cd3",
      buildId: BUILD_ID,
      sha256: createHash("sha256").update(tarBytes).digest("hex"),
      size: tarBytes.length,
      boardWorkerVersion: "0.1.9",
      protocolVersion: WORKER_PROTOCOL_VERSION,
    };
    lookup = { state: "ready", manifest, tarballPath };
    registry = createWorkerRegistry(db);
    app = new Hono();
    app.route("/api/workers", createWorkersRoute(db, registry, undefined, service));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function pair(): Promise<{ workerId: string; workerToken: string }> {
    const { pairingToken } = registry.mintPairingToken();
    const res = await app.request("/api/workers/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairingToken, name: "box", protocolVersion: WORKER_PROTOCOL_VERSION }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as { workerId: string; workerToken: string };
  }

  it("refuses the manifest and the tarball without a valid worker token (401)", async () => {
    await pair();
    for (const path of ["/api/workers/build", "/api/workers/build/tarball"]) {
      const bare = await app.request(path);
      expect(bare.status).toBe(401);
      const wrong = await app.request(path, { headers: { authorization: "Bearer nope" } });
      expect(wrong.status).toBe(401);
      expect(JSON.stringify(await wrong.json())).not.toContain(BUILD_ID);
    }
  });

  it("also refuses them on the fleet listener's worker-facing router", async () => {
    const fleet = new Hono();
    fleet.route("/api/workers", createFleetWorkersRoute(db, registry, service));
    expect((await fleet.request("/api/workers/build")).status).toBe(401);
    expect((await fleet.request("/api/workers/build/tarball")).status).toBe(401);
  });

  it("serves a manifest and a tarball whose bytes match it", async () => {
    const { workerToken } = await pair();
    const headers = { authorization: `Bearer ${workerToken}` };
    const manifestRes = await app.request("/api/workers/build", { headers });
    expect(manifestRes.status).toBe(200);
    const manifest = (await manifestRes.json()) as WorkerBuildManifest;
    expect(manifest.buildId).toBe(BUILD_ID);

    const tarRes = await app.request("/api/workers/build/tarball", { headers });
    expect(tarRes.status).toBe(200);
    const bytes = Buffer.from(await tarRes.arrayBuffer());
    expect(bytes.length).toBe(manifest.size);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(manifest.sha256);
  });

  it("answers 202 while the board is still packing, and 503 with the reason when it cannot", async () => {
    const { workerToken } = await pair();
    const headers = { authorization: `Bearer ${workerToken}` };
    lookup = { state: "building" };
    expect((await app.request("/api/workers/build", { headers })).status).toBe(202);
    lookup = { state: "unavailable", reason: "no source checkout" };
    const res = await app.request("/api/workers/build", { headers });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toContain("no source checkout");
  });

  it("advertises the board's build id on the heartbeat and carries `worker update` as updateNow", async () => {
    const { workerId, workerToken } = await pair();
    const beat = async (body: Record<string, unknown> = {}) => {
      const res = await app.request(`/api/workers/${workerId}/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", authorization: `Bearer ${workerToken}` },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(200);
      return (await res.json()) as { boardBuildId: string | null; updateNow: boolean };
    };

    expect(await beat()).toMatchObject({ boardBuildId: BUILD_ID, updateNow: false });

    const ask = await app.request(`/api/workers/${workerId}/update`, { method: "POST" });
    expect(ask.status).toBe(200);
    expect((await beat({ update: { state: "current" } })).updateNow).toBe(true);
    // Delivered once the worker reports it is on it — and the state is visible to the list.
    expect((await beat({ update: { state: "updating", reason: "draining", targetBuild: "ab12cd3" } })).updateNow).toBe(false);
    const view = (await registry.listWorkersView()).find((w) => w.id === workerId);
    expect(view?.update).toEqual({ state: "updating", reason: "draining", targetBuild: "ab12cd3" });

    await beat({ update: { state: "failed", reason: "checksum mismatch", targetBuild: "ab12cd3" } });
    const failed = (await registry.listWorkersView()).find((w) => w.id === workerId);
    expect(failed?.update?.state).toBe("failed");
  });

  it("404s an update request for a worker that does not exist", async () => {
    const res = await app.request("/api/workers/nope/update", { method: "POST" });
    expect(res.status).toBe(404);
  });
});

describe("createWorkerBuildService — built once per commit (#1338)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ak-worker-build-svc-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("packs once for a commit, serves the cache after, and repacks for a new commit", async () => {
    let commit = BUILD_ID;
    let packs = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const svc = createWorkerBuildService({
      repoRoot: null,
      cacheDir: dir,
      resolveBuildId: async () => commit,
      pack: async (outDir) => {
        packs += 1;
        await gate;
        const tarball = join(outDir, `agentic-kanban-${packs}.tgz`);
        writeFileSync(tarball, `build ${commit}`);
        return { tarball, version: `0.1.9-dev.${commit.slice(0, 7)}` };
      },
    });

    expect((await svc.getBuild()).state).toBe("building");
    expect((await svc.getBuild()).state).toBe("building"); // shares the one in-flight build
    expect(packs).toBe(1);
    release();
    await vi_waitFor(async () => (await svc.getBuild()).state === "ready");
    const ready = await svc.getBuild();
    expect(ready.state === "ready" && ready.manifest.buildId).toBe(BUILD_ID);
    expect(packs).toBe(1);

    commit = "ff".repeat(20);
    expect((await svc.getBuild()).state).toBe("building");
    expect(packs).toBe(2);
  });

  it("is unavailable, with a reason, on a board that has no source tree", async () => {
    const svc = createWorkerBuildService({ repoRoot: null, cacheDir: dir });
    const lookup = await svc.getBuild();
    expect(lookup.state).toBe("unavailable");
  });
});

async function vi_waitFor(check: () => Promise<boolean>, attempts = 50): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("condition not met in time");
}

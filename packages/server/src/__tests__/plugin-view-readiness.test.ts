import { describe, expect, it, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as schema from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createPluginService, stopAllPluginViewsAsync } from "../services/plugin.service.js";
import type { Database } from "../db/index.js";

/**
 * #252 — `startView` must not report a URL the child is not listening on yet.
 *
 * The client sets the returned URL as the iframe `src` immediately, so returning right after
 * `spawnShellCommand` rendered ERR_CONNECTION_REFUSED (with no retry) for every view that takes
 * more than ~100ms to bind. The wait is bounded: a server that never binds reports
 * `ready: false` and stays supervised so the panel can show a spinner and poll.
 */

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function manifest(): Record<string, unknown> {
  return {
    id: "ready-view-plugin",
    name: "Ready View Plugin",
    views: [
      {
        id: "panel",
        label: "Panel",
        kind: "iframe",
        serve: { command: "node serve.mjs", cwd: "plugin", portEnv: "PORT" },
      },
    ],
  };
}

function makePluginDir(serveSource: string): string {
  const dir = makeTempDir("view-ready-plugin-");
  writeFileSync(join(dir, "kanban-plugin.json"), JSON.stringify(manifest(), null, 2));
  writeFileSync(join(dir, "serve.mjs"), serveSource);
  return dir;
}

async function insertProject(db: TestDb): Promise<string> {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId,
    name: "Ready View Project",
    repoPath: makeTempDir("view-ready-repo-"),
    repoName: "ready-view-project",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });
  return projectId;
}

describe("startView — readiness (#252)", () => {
  // ASYNC + awaited (#352): the sync `stopAllPluginViews()` fire-and-forgets the Windows tree
  // kill, so this hook used to `rmSync` the temp dir while the real `node serve.mjs` grandchild
  // was still alive holding it as `cwd` — EBUSY, swallowed as "best effort", and 330 stale dirs
  // plus 22 live orphans accumulated. Wait for the kills, THEN remove.
  afterEach(async () => {
    await stopAllPluginViewsAsync();
    delete process.env.PLUGIN_VIEW_READY_TIMEOUT_MS;
    for (const dir of tempDirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows file locks — best-effort cleanup */
      }
    }
  });

  it("waits for a slow-binding server, so the returned URL answers immediately", async () => {
    const { db } = createTestDb();
    const service = createPluginService({ database: db as unknown as Database });
    // Binds only after 900ms — the shape that showed a connection-refused iframe.
    const plugin = await service.installPlugin({
      source: makePluginDir(
        "import http from 'node:http';\n"
          + "await new Promise((r) => setTimeout(r, 900));\n"
          + "http.createServer((req, res) => res.end('ok')).listen(process.env.PORT, '127.0.0.1');\n",
      ),
    });
    const projectId = await insertProject(db);

    const started = await service.startView({ pluginRowId: plugin.id, viewId: "panel", projectId });
    expect(started.ready).toBe(true);
    // No polling, no grace period: what the caller would frame is already serving.
    const res = await fetch(started.url, { signal: AbortSignal.timeout(2000) });
    expect(res.status).toBeLessThan(500);

    await service.stopView({ pluginRowId: plugin.id, viewId: "panel", projectId });
  });

  it("gives up after the bounded timeout, reporting not-ready while keeping the child supervised", async () => {
    process.env.PLUGIN_VIEW_READY_TIMEOUT_MS = "600";
    const { db } = createTestDb();
    const service = createPluginService({ database: db as unknown as Database });
    // Alive but never listens — a misconfigured or very slow server.
    const plugin = await service.installPlugin({
      source: makePluginDir("await new Promise((r) => setTimeout(r, 30_000));\n"),
    });
    const projectId = await insertProject(db);

    const started = await service.startView({ pluginRowId: plugin.id, viewId: "panel", projectId });
    expect(started.ready).toBe(false);
    expect(started.port).toBeGreaterThan(0);

    // Still tracked, so it can be polled and — critically — stopped.
    const status = await service.getViewStatus({ pluginRowId: plugin.id, viewId: "panel", projectId });
    expect(status).toMatchObject({ running: true, healthy: false });
    expect(await service.stopView({ pluginRowId: plugin.id, viewId: "panel", projectId })).toEqual({ stopped: true });
  });
});

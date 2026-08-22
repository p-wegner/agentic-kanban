import { describe, expect, it, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as schema from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createPluginService, stopAllPluginViewsAsync } from "../services/plugin.service.js";
import type { Database } from "../db/index.js";

/**
 * #251 (server half) — two concurrent `startView` calls must spawn ONE child server.
 *
 * The old check-then-set had four awaits between the `viewChildren.get` and the `set`, so both
 * callers spawned a server and the loser was orphaned for the life of the process: nothing
 * removed it (`entry?.child === child`), `stopView` could not see it, and `stopAllPluginViews()`
 * could not kill it on shutdown — the leak measured in #228.
 */

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const MANIFEST = {
  id: "race-view-plugin",
  name: "Race View Plugin",
  views: [
    {
      id: "panel",
      label: "Panel",
      kind: "iframe",
      serve: { command: "node serve.mjs", cwd: "plugin", portEnv: "PORT", env: { SPAWN_LOG: "{{pluginPath}}/spawns.txt" } },
    },
  ],
};

function makePluginDir(): string {
  const dir = makeTempDir("view-race-plugin-");
  writeFileSync(join(dir, "kanban-plugin.json"), JSON.stringify(MANIFEST, null, 2));
  // Records every spawn, so a second (orphaned) server is visible even though nothing tracks it.
  writeFileSync(
    join(dir, "serve.mjs"),
    "import http from 'node:http'; import { appendFileSync } from 'node:fs';\n"
      + "appendFileSync(process.env.SPAWN_LOG, `${process.pid}\\n`);\n"
      + "http.createServer((req, res) => res.end('ok')).listen(process.env.PORT, '127.0.0.1');\n",
  );
  return dir;
}

async function insertProject(db: TestDb, repoPath: string): Promise<string> {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId,
    name: "View Race Project",
    repoPath,
    repoName: "view-race-project",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });
  return projectId;
}

describe("startView — concurrent starts (#251)", () => {
  // ASYNC + awaited (#352): the sync `stopAllPluginViews()` fire-and-forgets the Windows tree
  // kill, so this hook used to `rmSync` the temp dir while the real `node serve.mjs` grandchild
  // was still alive holding it as `cwd` — EBUSY, swallowed as "best effort", and 330 stale dirs
  // plus 22 live orphans accumulated. Wait for the kills, THEN remove.
  afterEach(async () => {
    await stopAllPluginViewsAsync();
    for (const dir of tempDirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows file locks — best-effort cleanup */
      }
    }
  });

  it("spawns exactly one child server and returns the same port to both callers", async () => {
    const { db } = createTestDb();
    const service = createPluginService({ database: db as unknown as Database });
    const pluginDir = makePluginDir();
    const plugin = await service.installPlugin({ source: pluginDir });
    const projectId = await insertProject(db, makeTempDir("view-race-repo-"));

    const [first, second] = await Promise.all([
      service.startView({ pluginRowId: plugin.id, viewId: "panel", projectId }),
      service.startView({ pluginRowId: plugin.id, viewId: "panel", projectId }),
    ]);
    expect(second.port).toBe(first.port);
    expect(second.pid).toBe(first.pid);

    // Give any (buggy) second child time to record itself before counting.
    const log = join(pluginDir, "spawns.txt");
    const deadline = Date.now() + 3000;
    while (!existsSync(log) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 500));
    const spawns = readFileSync(log, "utf8").trim().split(/\r?\n/).filter(Boolean);
    expect(spawns).toHaveLength(1);

    // The one child is the tracked one, so stopping the view really stops the server.
    expect(await service.stopView({ pluginRowId: plugin.id, viewId: "panel", projectId })).toEqual({ stopped: true });
  });
});

import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitExecSync } from "@agentic-kanban/shared/lib/git-exec";
import { createTestDb } from "./helpers/test-db.js";
import { createPluginService, PluginError } from "../services/plugin.service.js";
import type { Database } from "../db/index.js";

/**
 * Install-path hardening from the plugin review:
 * - a Windows-authored manifest with a UTF-8 BOM must install (JSON.parse rejects the BOM, and
 *   the failure blamed the plugin's JSON);
 * - two plugins whose git repos share a BASENAME must not share a clone directory — the clone is
 *   skipped when the directory exists, so the second install silently registered the first
 *   checkout under its own sourceUrl.
 */

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** A real (local) git repo serving as a plugin remote, so `git clone <path>` works offline. */
function makePluginRemote(slug: string, name: string): string {
  const dir = makeTempDir(`plugin-remote-${slug}-`);
  const repo = join(dir, "tools"); // deliberately the SAME basename for both remotes
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "kanban-plugin.json"), JSON.stringify({ id: slug, name }, null, 2));
  gitExecSync(["init"], { cwd: repo });
  gitExecSync(["add", "."], { cwd: repo });
  gitExecSync(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"], { cwd: repo });
  return repo;
}

describe("installPlugin hardening", () => {
  let pluginsHome: string;

  beforeEach(() => {
    pluginsHome = makeTempDir("ak-plugins-home-");
    process.env.AGENTIC_KANBAN_PLUGINS_DIR = pluginsHome;
  });

  afterEach(() => {
    delete process.env.AGENTIC_KANBAN_PLUGINS_DIR;
    for (const dir of tempDirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows file locks — best-effort cleanup */
      }
    }
  });

  it("installs a manifest written with a UTF-8 BOM", async () => {
    const { db } = createTestDb();
    const service = createPluginService({ database: db as unknown as Database });
    const dir = makeTempDir("ak-plugin-bom-");
    // What PowerShell's `Set-Content -Encoding utf8` produces.
    writeFileSync(join(dir, "kanban-plugin.json"), "﻿" + JSON.stringify({ id: "bom-plugin", name: "BOM Plugin" }));

    const row = await service.installPlugin({ source: dir });
    expect(row.pluginId).toBe("bom-plugin");
    // The stored manifest is the stripped text, so every later re-parse is clean too.
    expect(row.manifestJson.charCodeAt(0)).not.toBe(0xfeff);
    expect((await service.listPlugins())[0].manifestError).toBeNull();
  });

  it("keeps two same-basename remotes in separate clone directories", async () => {
    const { db } = createTestDb();
    const service = createPluginService({ database: db as unknown as Database });
    const remoteA = makePluginRemote("tools-a", "Tools A");
    const remoteB = makePluginRemote("tools-b", "Tools B");

    // `file:///…` so both are treated as git URLs (the collision only exists on that path).
    const urlOf = (p: string) => `file:///${p.replace(/\\/g, "/")}`;
    const rowA = await service.installPlugin({ source: urlOf(remoteA) });
    const rowB = await service.installPlugin({ source: urlOf(remoteB) });

    expect(rowA.localPath).not.toBe(rowB.localPath);
    // Each checkout really is its own plugin, not the first one wearing the second's sourceUrl.
    expect(rowA.pluginId).toBe("tools-a");
    expect(rowB.pluginId).toBe("tools-b");
    expect(existsSync(join(rowB.localPath, "kanban-plugin.json"))).toBe(true);

    // Re-installing A is idempotent: same directory, no second clone.
    const again = await service.installPlugin({ source: urlOf(remoteA) });
    expect(again.localPath).toBe(rowA.localPath);
  });

  it("refuses an existing clone directory holding a different remote", async () => {
    const { db } = createTestDb();
    const service = createPluginService({ database: db as unknown as Database });
    const remote = makePluginRemote("tools-a", "Tools A");
    const foreign = makePluginRemote("tools-x", "Tools X");
    const url = `file:///${remote.replace(/\\/g, "/")}`;

    // Occupy the exact directory this URL hashes to with a checkout of something else.
    const row = await service.installPlugin({ source: url });
    const occupied = row.localPath;
    rmSync(occupied, { recursive: true, force: true });
    gitExecSync(["clone", `file:///${foreign.replace(/\\/g, "/")}`, occupied], {});

    await expect(service.installPlugin({ source: url })).rejects.toThrow(PluginError);
  });
});

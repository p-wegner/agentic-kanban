import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import * as schema from "@agentic-kanban/shared/schema";
import { gitExecSync } from "@agentic-kanban/shared/lib/git-exec";
import { pluginEnabledPreferenceKey } from "@agentic-kanban/shared/lib/plugin-manifest";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createPluginService, marketplaceCatalogPath } from "../services/plugin.service.js";
import type { Database } from "../db/index.js";

/**
 * Marketplace merge semantics: installed rows always listed; catalog-file entries
 * appended unless they match an installed plugin by normalized git URL or slug; a
 * missing or broken catalog file degrades to installed-only, never a 500.
 */

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makePluginDir(id: string, name: string): string {
  const dir = makeTempDir("plugin-market-");
  writeFileSync(
    join(dir, "kanban-plugin.json"),
    JSON.stringify({ id, name, version: "1.2.3", description: `${name} description` }),
  );
  return dir;
}

async function insertProject(db: TestDb): Promise<string> {
  const parent = makeTempDir("plugin-market-repo-");
  const repo = join(parent, "product-repo");
  mkdirSync(repo, { recursive: true });
  gitExecSync(["init"], { cwd: repo });
  const now = new Date().toISOString();
  const projectId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId,
    name: "Marketplace Project",
    repoPath: repo,
    repoName: "marketplace-project",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });
  return projectId;
}

describe("plugin marketplace", () => {
  let db: TestDb;
  let dispose: () => void;
  let pluginsHome: string;

  beforeEach(() => {
    ({ db, dispose } = createTestDb());
    pluginsHome = makeTempDir("plugin-market-home-");
    process.env.AGENTIC_KANBAN_PLUGINS_DIR = pluginsHome;
  });

  afterEach(() => {
    delete process.env.AGENTIC_KANBAN_PLUGINS_DIR;
    dispose();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function service() {
    return createPluginService({ database: db as unknown as Database });
  }

  it("lists installed plugins with manifest metadata when no catalog file exists", async () => {
    const svc = service();
    await svc.installPlugin({ source: makePluginDir("alpha", "Alpha") });
    const { entries, catalogPath } = await svc.listMarketplace();
    expect(catalogPath).toBe(marketplaceCatalogPath());
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      slug: "alpha",
      name: "Alpha",
      description: "Alpha description",
      version: "1.2.3",
      installed: true,
      origin: "installed",
      enabled: false,
    });
    expect(entries[0].localPath).toBeTruthy();
    expect(entries[0].installedId).toBeTruthy();
  });

  it("appends catalog entries and dedupes against installed plugins by slug and git URL", async () => {
    const svc = service();
    const row = await svc.installPlugin({ source: makePluginDir("alpha", "Alpha") });
    // Give the installed row a git origin so URL-dedup has something to match.
    await db
      .update(schema.plugins)
      .set({ sourceUrl: "https://example.com/org/alpha.git" })
      .where(eq(schema.plugins.id, row.id));
    writeFileSync(
      marketplaceCatalogPath(),
      JSON.stringify([
        // Same plugin, URL differing only in .git suffix + trailing slash + case → absorbed.
        { name: "Alpha (catalog)", gitUrl: "https://Example.com/org/Alpha/" },
        // Same slug, different URL → absorbed.
        { slug: "alpha", name: "Alpha again", gitUrl: "https://mirror.example.com/alpha.git" },
        // Genuinely new → listed as installable.
        { name: "Beta", slug: "beta", description: "Beta desc", gitUrl: "https://example.com/org/beta.git" },
        // Missing gitUrl → ignored.
        { name: "No URL" },
      ]),
    );
    const { entries } = await svc.listMarketplace();
    expect(entries).toHaveLength(2);
    expect(entries[0].slug).toBe("alpha");
    expect(entries[1]).toMatchObject({
      slug: "beta",
      name: "Beta",
      description: "Beta desc",
      gitUrl: "https://example.com/org/beta.git",
      installed: false,
      origin: "catalog",
      enabled: false,
    });
  });

  it("tolerates a UTF-8 BOM in the catalog file (PowerShell Set-Content writes one)", async () => {
    const svc = service();
    writeFileSync(
      marketplaceCatalogPath(),
      "﻿" + JSON.stringify([{ name: "Bom", slug: "bom", gitUrl: "https://example.com/bom.git" }]),
    );
    const { entries } = await svc.listMarketplace();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ slug: "bom", installed: false, origin: "catalog" });
  });

  it("update on a local-directory plugin re-reads the manifest without pulling", async () => {
    const svc = service();
    const dir = makePluginDir("alpha", "Alpha");
    const row = await svc.installPlugin({ source: dir });
    expect(row.version).toBe("1.2.3");
    writeFileSync(
      join(dir, "kanban-plugin.json"),
      JSON.stringify({ id: "alpha", name: "Alpha Renamed", version: "2.0.0" }),
    );
    const result = await svc.updatePlugin(row.id);
    expect(result).toMatchObject({
      pulled: false,
      headChanged: false,
      previousVersion: "1.2.3",
      version: "2.0.0",
      viewsStopped: 0,
    });
    expect(result.row.name).toBe("Alpha Renamed");
  });

  it("update on a git-sourced plugin pulls fast-forward and reports whether HEAD moved", async () => {
    const svc = service();
    // A local "origin" repo the clone can pull from; sourceUrl only marks the row as
    // board-managed — the pull itself uses the clone's own origin remote.
    const originParent = makeTempDir("plugin-market-origin-");
    const origin = join(originParent, "origin");
    mkdirSync(origin, { recursive: true });
    gitExecSync(["init"], { cwd: origin });
    writeFileSync(join(origin, "kanban-plugin.json"), JSON.stringify({ id: "gitplug", name: "Git Plug", version: "1.0.0" }));
    gitExecSync(["add", "."], { cwd: origin });
    gitExecSync(["commit", "-m", "v1"], { cwd: origin });

    const cloneParent = makeTempDir("plugin-market-clone-");
    const clone = join(cloneParent, "gitplug");
    gitExecSync(["clone", origin, clone], {});
    const row = await svc.installPlugin({ source: clone });
    await db.update(schema.plugins).set({ sourceUrl: "https://example.com/gitplug.git" }).where(eq(schema.plugins.id, row.id));

    // No upstream change yet → pulled but HEAD unmoved.
    const same = await svc.updatePlugin(row.id);
    expect(same).toMatchObject({ pulled: true, headChanged: false, version: "1.0.0" });

    // Upstream bumps the manifest → pull fast-forwards and the row picks it up.
    writeFileSync(join(origin, "kanban-plugin.json"), JSON.stringify({ id: "gitplug", name: "Git Plug", version: "1.1.0" }));
    gitExecSync(["add", "."], { cwd: origin });
    gitExecSync(["commit", "-m", "v1.1"], { cwd: origin });
    const moved = await svc.updatePlugin(row.id);
    expect(moved).toMatchObject({ pulled: true, headChanged: true, previousVersion: "1.0.0", version: "1.1.0" });
  });

  it("update refuses a manifest whose id changed upstream", async () => {
    const svc = service();
    const dir = makePluginDir("alpha", "Alpha");
    const row = await svc.installPlugin({ source: dir });
    writeFileSync(join(dir, "kanban-plugin.json"), JSON.stringify({ id: "renamed", name: "Alpha", version: "3.0.0" }));
    await expect(svc.updatePlugin(row.id)).rejects.toThrow(/Manifest id changed/);
  });

  it("reports the enabled flag for the requested project and survives a broken catalog file", async () => {
    const svc = service();
    const row = await svc.installPlugin({ source: makePluginDir("alpha", "Alpha") });
    const projectId = await insertProject(db);
    const now = new Date().toISOString();
    await db.insert(schema.preferences).values({
      key: pluginEnabledPreferenceKey("alpha", projectId),
      value: "true",
      updatedAt: now,
    });
    writeFileSync(marketplaceCatalogPath(), "{ not valid json");
    const { entries } = await svc.listMarketplace(projectId);
    expect(entries).toHaveLength(1);
    expect(entries[0].installedId).toBe(row.id);
    expect(entries[0].enabled).toBe(true);
  });
});

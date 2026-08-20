import { describe, expect, it, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import * as schema from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import {
  enabledPluginSlugsByProject,
  getEnabledPluginBySlug,
  listEnabledPlugins,
  listEnabledPluginsByProjects,
} from "../services/plugin-enabled.js";
import type { Database } from "../db/index.js";

/**
 * #552 — the "enabled slugs -> installed rows -> parse manifest (skip broken) -> project the
 * owner" loop was hand-written in ten places and each copy re-decided what a broken cached
 * manifest means. These pin the decisions the one iterator now makes for all of them.
 */
describe("plugin-enabled iterator (#552)", () => {
  let db: TestDb;
  const projectA = randomUUID();
  const projectB = randomUUID();

  async function installPlugin(slug: string, manifestJson: string) {
    const id = randomUUID();
    await db.insert(schema.plugins).values({
      id,
      pluginId: slug,
      name: `Plugin ${slug}`,
      sourceUrl: `https://example.invalid/${slug}`,
      localPath: `/tmp/${slug}`,
      version: "0.1.0",
      manifestJson,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    return id;
  }

  async function enable(slug: string, projectId: string, value = "true") {
    await db.insert(schema.preferences).values({ key: `plugin_enabled_${slug}_${projectId}`, value });
  }

  function manifest(slug: string) {
    return JSON.stringify({ id: slug, name: `Plugin ${slug}`, version: "0.1.0" });
  }

  beforeEach(async () => {
    db = createTestDb().db;
    await installPlugin("alpha", manifest("alpha"));
    await installPlugin("beta", manifest("beta"));
    await installPlugin("broken", "{ this is not json");
  });

  it("returns only the plugins enabled for the project", async () => {
    await enable("alpha", projectA);
    await enable("beta", projectB);
    const forA = await listEnabledPlugins(projectA, db as unknown as Database);
    expect(forA.map((p) => p.row.pluginId)).toEqual(["alpha"]);
    expect(forA[0].owner).toMatchObject({ pluginSlug: "alpha", pluginName: "Plugin alpha" });
  });

  it("treats an absent or non-true preference as NOT enabled", async () => {
    await enable("alpha", projectA, "false");
    expect(await listEnabledPlugins(projectA, db as unknown as Database)).toEqual([]);
    expect((await enabledPluginSlugsByProject(db as unknown as Database)).size).toBe(0);
  });

  it("skips a plugin whose cached manifest is broken instead of throwing", async () => {
    await enable("alpha", projectA);
    await enable("broken", projectA);
    const forA = await listEnabledPlugins(projectA, db as unknown as Database);
    expect(forA.map((p) => p.row.pluginId)).toEqual(["alpha"]);
  });

  it("resolves many projects in one sweep, each seeing only its own plugins", async () => {
    await enable("alpha", projectA);
    await enable("beta", projectA);
    await enable("beta", projectB);
    const byProject = await listEnabledPluginsByProjects([projectA, projectB], db as unknown as Database);
    expect(byProject.get(projectA)?.map((p) => p.row.pluginId)).toEqual(["alpha", "beta"]);
    expect(byProject.get(projectB)?.map((p) => p.row.pluginId)).toEqual(["beta"]);
  });

  it("returns an empty list for a project with nothing enabled", async () => {
    const byProject = await listEnabledPluginsByProjects([projectA], db as unknown as Database);
    expect(byProject.get(projectA)).toEqual([]);
    expect(await listEnabledPlugins(projectA, db as unknown as Database)).toEqual([]);
  });

  it("getEnabledPluginBySlug is null for installed-but-disabled and for broken", async () => {
    await enable("broken", projectA);
    expect(await getEnabledPluginBySlug("alpha", projectA, db as unknown as Database)).toBeNull();
    expect(await getEnabledPluginBySlug("broken", projectA, db as unknown as Database)).toBeNull();
    await enable("alpha", projectA);
    expect((await getEnabledPluginBySlug("alpha", projectA, db as unknown as Database))?.row.pluginId).toBe("alpha");
  });
});

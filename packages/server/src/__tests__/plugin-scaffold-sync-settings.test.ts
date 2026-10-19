import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const prefs = new Map<string, string>();
vi.mock("../repositories/preferences.repository.js", () => ({
  getPreference: async (key: string) => prefs.get(key) ?? null,
}));

import { pluginSyncConfigPreferenceKey } from "@agentic-kanban/shared/lib/plugin-manifest";
import { requireScaffoldReady, syncSettingsComplete } from "../services/plugin-scaffold.js";

const plugin = {
  pluginId: "jira-sync",
  manifest: {
    scaffold: { targetPath: "docs/jira-sync/_profile.md", profileTemplate: "profile-template.md" },
    sync: { config: [{ key: "siteUrl", required: true }, { key: "projectKey", required: true }, { key: "jql" }] },
  },
} as never;

describe("scaffold gate vs. complete Sync settings (#1635)", () => {
  beforeEach(() => prefs.clear());

  it("settings with every required field answer the profile; incomplete ones do not", async () => {
    const key = pluginSyncConfigPreferenceKey("jira-sync", "p1");
    expect(await syncSettingsComplete(plugin, "p1", {} as never)).toBe(false);
    prefs.set(key, JSON.stringify({ siteUrl: "https://x.atlassian.net" }));
    expect(await syncSettingsComplete(plugin, "p1", {} as never)).toBe(false);
    prefs.set(key, JSON.stringify({ siteUrl: "https://x.atlassian.net", projectKey: "KD" }));
    expect(await syncSettingsComplete(plugin, "p1", {} as never)).toBe(true);
  });

  it("requireScaffoldReady refuses TODOs unless the settings are complete", async () => {
    const repo = mkdtempSync(join(tmpdir(), "scaf-"));
    try {
      mkdirSync(join(repo, "docs/jira-sync"), { recursive: true });
      writeFileSync(join(repo, "docs/jira-sync/_profile.md"), "## Site\n\nTODO: url\n");
      await expect(requireScaffoldReady(plugin, repo, "loops")).rejects.toThrow(/unresolved TODO/);
      await expect(requireScaffoldReady(plugin, repo, "loops", { settingsComplete: true })).resolves.toBeUndefined();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

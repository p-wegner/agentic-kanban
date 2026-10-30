import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildPluginPlaceholderVars, substitutePluginEnv } from "@agentic-kanban/shared/lib/plugin-manifest";
import { pluginProjectDataDir } from "./plugin-fs.js";

describe("pluginProjectDataDir (#1737)", () => {
  it("gives two projects on one repo path distinct jira-sync state dirs outside the repo", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../../plugins/jira-sync/kanban-plugin.json", import.meta.url), "utf8"),
    );
    const envFor = (projectId: string) =>
      substitutePluginEnv(
        manifest.sync.pull.env,
        buildPluginPlaceholderVars({
          outputRepoPath: "/shared/repo",
          leadingRepoPath: "/shared/repo",
          projectName: "p",
          pluginPath: "/plugins/jira-sync",
          projectId,
          pluginDataDir: pluginProjectDataDir("jira-sync", projectId),
        }),
      );
    const a = envFor("proj-a").JIRA_SYNC_STATE_DIR!;
    const b = envFor("proj-b").JIRA_SYNC_STATE_DIR!;
    expect(a).not.toBe(b);
    expect(a).toContain("proj-a");
    expect(a.split("\\").join("/")).not.toContain("/shared/repo");
  });
});

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as schema from "@agentic-kanban/shared/schema";
import { gitExecSync } from "@agentic-kanban/shared/lib/git-exec";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createPluginService, stopAllPluginViewsAsync } from "../services/plugin.service.js";
import { dryRunContractBreach } from "../services/plugin-sync-summary.js";
import type { Database } from "../db/index.js";

/**
 * The dry-run contract (#1634): the board sets SYNC_DRY_RUN=1 and the REAL jira-sync pull/push
 * must then perform zero mutating calls. Runs the bundled plugin's own commands through the
 * service against the plugin's offline fixtures; JIRA_SYNC_FIXTURE_LOG records every non-GET call
 * (Jira and board). A real run of the same setup is the control, so the assertion is not vacuous.
 */

const PLUGIN_DIR = resolve(import.meta.dirname, "..", "..", "plugins", "jira-sync");
const SECRETS = ["JIRA_API_TOKEN", "JIRA_EMAIL"];
const tempDirs: string[] = [];

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe("plugin sync dry-run contract (#1634)", () => {
  let db: TestDb;
  let service: ReturnType<typeof createPluginService>;
  let repo: string;
  let logPath: string;
  let pluginId: string;
  let projectId: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    db = createTestDb().db;
    service = createPluginService({ database: db as unknown as Database });
    const parent = tmp("ak-dryrun-contract-");
    repo = join(parent, "product-repo");
    mkdirSync(repo, { recursive: true });
    gitExecSync(["init"], { cwd: repo });
    logPath = join(parent, "mutations.log");
    writeFileSync(logPath, "");

    for (const k of [...SECRETS, "JIRA_SYNC_SELF_TEST", "JIRA_SYNC_FIXTURE_LOG"]) saved[k] = process.env[k];
    for (const k of SECRETS) process.env[k] = "secret";
    process.env.JIRA_SYNC_SELF_TEST = "1";
    process.env.JIRA_SYNC_FIXTURE_LOG = logPath;

    const now = new Date().toISOString();
    projectId = randomUUID();
    await db.insert(schema.projects).values({
      id: projectId, name: "Dry Run", repoPath: repo, repoName: "dry-run", defaultBranch: "main", createdAt: now, updatedAt: now,
    });
    const plugin = await service.installPlugin({ source: PLUGIN_DIR });
    pluginId = plugin.id;
    await service.setSyncConfig(pluginId, projectId, { siteUrl: "https://fixture.atlassian.net", projectKey: "ENG" });

    // An outbox with a transition, a comment and a create: every kind of Jira write push can make.
    const stateDir = join(repo, ".jira-sync");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "outbox.json"), JSON.stringify({
      entries: [
        { kind: "transition", key: "ENG-1", targetStatus: "Done", boardIssueId: "b1" },
        { kind: "comment", key: "ENG-1", comment: { body: "hello", boardCommentId: "c1" } },
        { kind: "create", boardIssueId: "b2", fields: { summary: "New one" } },
      ],
    }));
  });

  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await stopAllPluginViewsAsync();
    for (const dir of tempDirs.splice(0)) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows file locks */ }
    }
  });

  const mutations = () => readFileSync(logPath, "utf8").split("\n").filter(Boolean);

  it("control: a real push does write (the log and the fixtures see mutating calls)", async () => {
    const record = await service.triggerSync(pluginId, projectId, { direction: "push" });
    expect(record.summary?.counts?.applied).toBe(3);
    expect(mutations().some((m) => m.startsWith("jira POST"))).toBe(true);
  });

  it("dry run (push) makes zero mutating calls and persists nothing", async () => {
    const before = readFileSync(join(repo, ".jira-sync", "outbox.json"), "utf8");
    const record = await service.triggerSync(pluginId, projectId, { direction: "push", dryRun: true });
    expect(record.error).toBeUndefined();
    expect(record.ok).toBe(true);
    expect(record.dryRun).toBe(true);
    expect(mutations()).toEqual([]);
    expect(readFileSync(join(repo, ".jira-sync", "outbox.json"), "utf8")).toBe(before);
    expect(existsSync(join(repo, ".jira-sync", "writebacks.json"))).toBe(false);
  });

  it("dry run (pull) makes zero mutating calls", async () => {
    const record = await service.triggerSync(pluginId, projectId, { direction: "pull", dryRun: true });
    expect(record.error).toBeUndefined();
    expect(record.ok).toBe(true);
    expect(mutations()).toEqual([]);
    expect(existsSync(join(repo, ".jira-sync", "pull-state.json"))).toBe(false);
  });

  it("control: a real pull does write to the board fixture", async () => {
    const record = await service.triggerSync(pluginId, projectId, { direction: "pull" });
    expect(record.ok).toBe(true);
    expect(mutations().some((m) => m.startsWith("board POST"))).toBe(true);
  });

  it("flags a dry run whose output reports a created Jira key as a contract breach", () => {
    const breach = JSON.stringify({ ok: true, applied: [{ kind: "create", key: "KD-47", boardIssueId: "b2" }] });
    expect(dryRunContractBreach(breach)).toMatch(/KD-47/);
    const clean = JSON.stringify({ ok: true, applied: [{ kind: "create", boardIssueId: "b2", wouldApply: true }] });
    expect(dryRunContractBreach(clean)).toBeUndefined();
  });
});

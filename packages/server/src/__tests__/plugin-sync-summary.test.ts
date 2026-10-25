// @gate:always-run when:packages/server/plugins/jira-sync/**,packages/server/src/services/plugin-sync-summary.ts - spawns the real jira-sync plugin scripts, invisible to the import graph
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describeRunFailure, parseRunSummary } from "../services/plugin-sync-summary.js";

const PLUGIN_DIR = resolve(import.meta.dirname, "../../plugins/jira-sync");

/** Runs one real jira-sync script in offline self-test mode, like the board would. */
function runScript(script: string, extraEnv: Record<string, string> = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), "kanban-jira-sync-summary-"));
  try {
    const res = spawnSync(process.execPath, [join(PLUGIN_DIR, script), "--self-test"], {
      cwd: PLUGIN_DIR,
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, JIRA_SYNC_STATE_DIR: stateDir, ...extraEnv },
    });
    return { code: res.status, stdout: res.stdout, stderr: res.stderr };
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}

describe("jira-sync scripts -> run summary contract (#1625)", () => {
  it("normalizes real pull output into counts, issues and a Jira link", () => {
    const run = runScript("tools/sync/pull.mjs");
    expect(run.code).toBe(0);
    const summary = parseRunSummary(run.stdout, { siteUrl: "https://example.atlassian.net/" });
    expect(summary?.step).toBe("pull");
    expect(summary?.counts?.created).toBeGreaterThan(0);
    const first = summary?.issues?.[0];
    expect(first?.externalKey).toMatch(/^ENG-\d+$/);
    expect(first?.externalUrl).toBe(`https://example.atlassian.net/browse/${first?.externalKey}`);
  });

  it("normalizes real push output (an empty outbox) into zero counts", () => {
    const run = runScript("tools/sync/push.mjs");
    expect(run.code).toBe(0);
    const summary = parseRunSummary(run.stdout);
    expect(summary?.step).toBe("push");
    expect(summary?.counts).toMatchObject({ applied: 0, failed: 0 });
  });

  it("bootstrap in self-test mode exits 0 and reports a visible-issue count (no process.exit crash)", () => {
    const run = runScript("tools/bootstrap.mjs");
    expect(run.code).toBe(0);
    const out = JSON.parse(run.stdout) as { ok: boolean; issuesVisible: number };
    expect(out.ok).toBe(true);
    expect(out.issuesVisible).toBeGreaterThan(0);
  });

  it("a settings-complete env skips the unfilled scaffold profile gate", () => {
    const dir = mkdtempSync(join(tmpdir(), "kanban-jira-sync-profile-"));
    try {
      const profile = join(dir, "_profile.md");
      writeFileSync(profile, "TODO: site\nTODO: project\nTODO: jql\n");
      const blocked = runScript("tools/bootstrap.mjs", { JIRA_SYNC_PROFILE_PATH: profile });
      expect(JSON.parse(blocked.stdout)).toMatchObject({ ok: false, step: "profile" });
      const open = runScript("tools/bootstrap.mjs", {
        JIRA_SYNC_PROFILE_PATH: profile,
        SYNC_CONFIG_SITEURL: "https://example.atlassian.net",
        SYNC_CONFIG_PROJECTKEY: "ENG",
      });
      expect(JSON.parse(open.stdout)).toMatchObject({ ok: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("describeRunFailure (#1625)", () => {
  it("records the script's own step and reason, plus the stderr tail", () => {
    const stdout = JSON.stringify({ ok: false, step: "profile", reason: "3 unfilled TODO(s)" }, null, 2);
    const msg = describeRunFailure({ code: 1, timedOut: false, stdout, stderr: "line1\nboom\n" });
    expect(msg).toContain("profile: 3 unfilled TODO(s)");
    expect(msg).toContain("boom");
  });

  it("summarizes failed push entries", () => {
    const stdout = JSON.stringify({ ok: false, step: "push", total: 1, appliedCount: 0, failedCount: 1, applied: [], failed: [{ key: "ENG-1", kind: "comment", reason: "403" }] });
    expect(describeRunFailure({ code: 1, timedOut: false, stdout, stderr: "" })).toContain("ENG-1: 403");
  });

  it("falls back to the exit code when the script said nothing", () => {
    expect(describeRunFailure({ code: 7, timedOut: false, stdout: "", stderr: "" })).toBe("sync command exited with code 7");
    expect(describeRunFailure({ code: null, timedOut: true, stdout: "", stderr: "" })).toBe("sync command timed out");
  });
});

describe("dry-run summaries name planned writes, not applied ones (#1638)", () => {
  const push = (dryRun: boolean) =>
    JSON.stringify({ ok: true, step: "push", dryRun, appliedCount: 2, failedCount: 0, applied: [{ key: "KD-47", kind: "transition" }, { key: "KD-47", kind: "comment" }], failed: [] });
  it("push: dry run has planned (== real applied) and no applied", () => {
    const dry = parseRunSummary(push(true));
    const real = parseRunSummary(push(false));
    expect(dry?.counts?.applied).toBeUndefined();
    expect(dry?.counts?.planned).toBe(real?.counts?.applied);
    expect(dry?.issues?.map((i) => i.status)).toEqual(["would transition", "would comment"]);
    expect(real?.issues?.map((i) => i.status)).toEqual(["transition", "comment"]);
  });
  it("pull: dry run has wouldCreate/wouldUpdate and no created/updated/deleted", () => {
    const s = parseRunSummary(JSON.stringify({ step: "pull", dryRun: true, created: 1, updated: 2, skipped: 0, deleted: ["x"] }));
    expect(s?.counts).toMatchObject({ wouldCreate: 1, wouldUpdate: 2, wouldDelete: 1 });
    expect(s?.counts?.created).toBeUndefined();
    expect(s?.counts?.updated).toBeUndefined();
    expect(s?.counts?.deleted).toBeUndefined();
  });
});

describe("board-to-jira drift in the run summary (#1709)", () => {
  it("a skip whose details carry jiraDiffers names the fields and the next push", () => {
    const s = parseRunSummary(JSON.stringify({ step: "pull", details: [{ key: "KD-53", action: "skip", jiraDiffers: { title: "x" } }, { key: "KD-54", action: "skip" }] }));
    expect(s?.issues?.[0]?.status).toBe("skip: Jira differs on title; the next push restores the board value");
    expect(s?.issues?.[1]?.status).toBe("skip");
  });

  it("carries change text and refusal reasons into the status (#1720)", () => {
    const s = parseRunSummary(JSON.stringify({
      step: "pull",
      details: [
        { key: "KD-53", action: "update", changes: ["fields title", "assignee cleared"] },
        { key: "KD-55", action: "skip", reason: "skipped KD-55->KD-54: would create a cycle" },
      ],
      applied: [{ key: "KD-55", kind: "assignee", change: "assignee cleared" }, { key: "KD-54", kind: "link" }],
    }));
    expect(s?.issues?.[0]?.status).toBe("update: fields title; assignee cleared");
    expect(s?.issues?.[1]?.status).toBe("skip: skipped KD-55->KD-54: would create a cycle");
    expect(s?.issues?.[2]?.status).toBe("assignee: assignee cleared");
    expect(s?.issues?.[3]?.status).toBe("link");
  });
});

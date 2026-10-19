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

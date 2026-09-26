import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitExecSync } from "@agentic-kanban/shared/lib/git-exec";
import { applySkillListingOverrides, removeSkillListingOverrides } from "../services/plugin-skill-listing-settings.js";

const tempDirs: string[] = [];

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "ak-skill-listing-settings-"));
  tempDirs.push(dir);
  gitExecSync(["init"], { cwd: dir });
  return dir;
}

function settingsLocalPath(repo: string): string {
  return join(repo, ".claude", "settings.local.json");
}

describe("plugin-skill-listing-settings", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows file locks — temp cleanup is best-effort */
      }
    }
  });

  it("writes skillOverrides into a fresh settings.local.json", async () => {
    const repo = makeRepo();
    const result = await applySkillListingOverrides(repo, { "requirement-extraction": "off" });
    expect(result.applied).toBe(true);
    expect(result.warning).toBeNull();
    const written = JSON.parse(readFileSync(settingsLocalPath(repo), "utf-8"));
    expect(written.skillOverrides).toEqual({ "requirement-extraction": "off" });
  });

  it("merges into skillOverrides without touching unrelated top-level keys", async () => {
    const repo = makeRepo();
    mkdirSync(join(repo, ".claude"), { recursive: true });
    writeFileSync(
      settingsLocalPath(repo),
      JSON.stringify({ permissions: { allow: ["Bash(git:*)"] }, skillOverrides: { "other-skill": "on" } }, null, 2),
    );

    await applySkillListingOverrides(repo, { "requirement-extraction": "name-only" });

    const written = JSON.parse(readFileSync(settingsLocalPath(repo), "utf-8"));
    expect(written.permissions).toEqual({ allow: ["Bash(git:*)"] });
    expect(written.skillOverrides).toEqual({ "other-skill": "on", "requirement-extraction": "name-only" });
  });

  it("skips (and reports) a settings.local.json that is TRACKED by git", async () => {
    const repo = makeRepo();
    mkdirSync(join(repo, ".claude"), { recursive: true });
    writeFileSync(settingsLocalPath(repo), JSON.stringify({}));
    gitExecSync(["add", "-f", ".claude/settings.local.json"], { cwd: repo });
    gitExecSync(["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-m", "track it"], { cwd: repo });

    const before = readFileSync(settingsLocalPath(repo), "utf-8");
    const result = await applySkillListingOverrides(repo, { "requirement-extraction": "off" });

    expect(result.applied).toBe(false);
    expect(result.warning).toContain("tracked by git");
    expect(readFileSync(settingsLocalPath(repo), "utf-8")).toBe(before);
  });

  it("removeSkillListingOverrides removes only the named skills, leaving others intact", async () => {
    const repo = makeRepo();
    await applySkillListingOverrides(repo, { "skill-a": "off", "skill-b": "on" });

    const result = await removeSkillListingOverrides(repo, ["skill-a"]);
    expect(result.applied).toBe(true);

    const written = JSON.parse(readFileSync(settingsLocalPath(repo), "utf-8"));
    expect(written.skillOverrides).toEqual({ "skill-b": "on" });
  });

  it("removeSkillListingOverrides drops the whole skillOverrides key once empty", async () => {
    const repo = makeRepo();
    await applySkillListingOverrides(repo, { "skill-a": "off" });

    await removeSkillListingOverrides(repo, ["skill-a"]);

    const written = JSON.parse(readFileSync(settingsLocalPath(repo), "utf-8"));
    expect(written.skillOverrides).toBeUndefined();
  });

  it("is a no-op (and does not create the file) when there is nothing to remove", async () => {
    const repo = makeRepo();
    const result = await removeSkillListingOverrides(repo, ["never-existed"]);
    expect(result.applied).toBe(true);
    expect(() => readFileSync(settingsLocalPath(repo), "utf-8")).toThrow();
  });
});

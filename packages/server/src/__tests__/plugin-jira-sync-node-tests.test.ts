// @gate:always-run when:packages/server/plugins/jira-sync/** - spawns `node --test` over the plugin's node:test suites, which vitest excludes (plugins/**)
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const PLUGIN_DIR = resolve(import.meta.dirname, "../../plugins/jira-sync");
const TESTS_DIR = join(PLUGIN_DIR, "__tests__");

describe("jira-sync node:test suites run in the gate (#1736)", () => {
  it("every __tests__/*.test.mjs passes under node --test", () => {
    // Explicit file list: the bare directory form fails on Node 24.
    const files = readdirSync(TESTS_DIR).filter((f) => f.endsWith(".test.mjs")).sort().map((f) => join("__tests__", f));
    expect(files.length).toBeGreaterThan(0);
    const res = spawnSync(process.execPath, ["--test", "--test-concurrency=2", ...files], {
      cwd: PLUGIN_DIR,
      encoding: "utf8",
      windowsHide: true,
      timeout: 150_000,
    });
    const failed = (res.stdout ?? "").split("\n").filter((l) => l.startsWith("✖")).slice(0, 20).join("\n");
    expect(res.status, `node --test failed:\n${failed}\n${(res.stderr ?? "").slice(-2000)}`).toBe(0);
  }, 180_000);
});

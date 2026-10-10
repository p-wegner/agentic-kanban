// #1315 — `agentic-kanban worker …` on a worker machine must never open or create a database.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtCliPath, PKG_DIR } from "./helpers/cli-harness.js";

describe("full CLI `worker` subcommands are DB-free (#1315)", () => {
  it("creates no .agentic-kanban/kanban.db under an empty HOME", () => {
    const home = mkdtempSync(join(tmpdir(), "ak-1315-home-"));
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
      for (const key of ["DB_URL", "AGENTIC_KANBAN_DIR", "KANBAN_DB_PATH"]) delete env[key];
      const result = spawnSync(
        process.execPath,
        [builtCliPath(), "worker", "instructions", "--board", "http://127.0.0.1:9"],
        { env, cwd: tmpdir(), encoding: "utf-8", windowsHide: true },
      );
      expect(existsSync(join(home, ".agentic-kanban", "kanban.db"))).toBe(false);
      expect(`${result.stdout}${result.stderr}`).not.toContain("[db] opening");
      expect(PKG_DIR).toBeTruthy();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);
});

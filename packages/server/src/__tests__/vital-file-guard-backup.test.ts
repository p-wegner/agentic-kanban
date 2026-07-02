import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// The dev checkout's LIVE hook — also the artifact shipped into scaffolded
// projects by scripts/copy-assets.mjs (directly from .claude/hooks/).
const HOOK = join(__dirname, "../../../../.claude/hooks/vital-file-guard.js");

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Run the hook against a temp project dir with one declared vital file. */
function runGuard(opts: { projectDir: string; vitalFile: string; command: string }): RunResult {
  const result = spawnSync(process.execPath, [HOOK], {
    cwd: opts.projectDir,
    input: JSON.stringify({ tool_input: { command: opts.command }, cwd: opts.projectDir }),
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: opts.projectDir,
      VITAL_FILES: opts.vitalFile,
      ALLOW_VITAL_DESTROY: "",
    },
    windowsHide: true,
    timeout: 30_000,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("vital-file-guard — WAL-aware backup (#988)", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), "vital-guard-test-"));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it("backs up the -wal and -shm sidecars alongside the main file", async () => {
    const db = join(projectDir, "vital.db");
    await writeFile(db, "main-content");
    await writeFile(db + "-wal", "wal-content");
    await writeFile(db + "-shm", "shm-content");

    const result = runGuard({ projectDir, vitalFile: db, command: "rm vital.db" });

    // Destructive command referencing the vital file is blocked...
    expect(result.status).toBe(1);
    const decision = JSON.parse(result.stdout.trim());
    expect(decision.decision).toBe("block");

    // ...and the backup set includes all three files with the same stamp.
    const backups = await readdir(db + ".backups");
    expect(backups).toHaveLength(3);
    const main = backups.find((f) => /^vital\.db\.\d{4}-/.test(f));
    const wal = backups.find((f) => /^vital\.db-wal\.\d{4}-/.test(f));
    const shm = backups.find((f) => /^vital\.db-shm\.\d{4}-/.test(f));
    expect(main).toBeTruthy();
    expect(wal).toBeTruthy();
    expect(shm).toBeTruthy();
    // Same timestamp suffix on all three (one coherent set).
    const stamp = (f: string) => f.match(/\.(\d{4}-.*Z)$/)?.[1];
    expect(stamp(wal!)).toBe(stamp(main!));
    expect(stamp(shm!)).toBe(stamp(main!));
  });

  it("tolerates absent sidecars — backs up just the main file", async () => {
    const db = join(projectDir, "vital.db");
    await writeFile(db, "main-content");

    const result = runGuard({ projectDir, vitalFile: db, command: "rm vital.db" });

    expect(result.status).toBe(1);
    const backups = await readdir(db + ".backups");
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/^vital\.db\.\d{4}-/);
  });
});

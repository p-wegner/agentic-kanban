import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionTempDir } from "../lib/session-temp-dir.js";

describe("per-session temp dir (#1391)", () => {
  it("gives each session its own TMPDIR/TMP/TEMP and removes it on dispose", () => {
    const a = createSessionTempDir("session-a")!;
    const b = createSessionTempDir("session-b")!;
    expect(a.path).not.toBe(b.path);
    expect(a.env).toEqual({ TMPDIR: a.path, TMP: a.path, TEMP: a.path });
    expect(existsSync(a.path)).toBe(true);
    a.dispose();
    b.dispose();
    expect(existsSync(a.path)).toBe(false);
    expect(existsSync(b.path)).toBe(false);
  });

  it("two concurrent sessions writing the same msg.txt each commit their own message", () => {
    const repo = mkdtempSync(join(tmpdir(), "kanban-test-1391-"));
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true }).trim();
    const sessions = [createSessionTempDir("one")!, createSessionTempDir("two")!];
    try {
      git("init", "-q");
      git("config", "user.email", "t@example.com");
      git("config", "user.name", "t");
      git("config", "commit.gpgsign", "false");
      const msgFiles = sessions.map((s) => join(s.env.TMPDIR, "msg.txt"));
      // Both "sessions" write their message BEFORE either commits — the interleaving that failed.
      msgFiles.forEach((f, i) => writeFileSync(f, `fix(#${1386 + i}): message ${i}\n`));
      sessions.forEach((_, i) => {
        writeFileSync(join(repo, `f${i}.txt`), String(i));
        git("add", `f${i}.txt`);
        git("commit", "-q", "-F", msgFiles[i]);
        expect(git("log", "-1", "--format=%s")).toBe(`fix(#${1386 + i}): message ${i}`);
      });
      expect(readFileSync(msgFiles[0], "utf8")).toContain("#1386");
    } finally {
      sessions.forEach((s) => s.dispose());
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

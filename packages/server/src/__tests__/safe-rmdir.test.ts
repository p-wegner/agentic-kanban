// @gate:always-run when:scripts/safe-rmdir.mjs — spawns scripts/safe-rmdir.mjs, a script under `scripts/` that no import graph reaches (#1033).
/**
 * #1033 — `scripts/safe-rmdir.mjs` refuses to delete a tree that holds a reparse point
 * whose target lies OUTSIDE the tree, and deletes one that does not. Junction-following
 * purges are the failure class the ticket named (a `robocopy /MIR` or `Remove-Item -Recurse`
 * over a worktree that borrows the live checkout's `node_modules`); this is the guarded
 * replacement, so its two promises are pinned here.
 *
 * Runs on every platform: a symlink is a reparse point on Windows and a link everywhere
 * else; `symlinkSync(..., "junction")` degrades to a directory symlink off Windows.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "../../../..");
const SCRIPT = resolve(REPO_ROOT, "scripts/safe-rmdir.mjs");

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", windowsHide: true });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function fixture(): { work: string; tree: string; target: string } {
  // `ak-` is the reaper's swept namespace — a failed teardown does not leak forever.
  const work = mkdtempSync(join(tmpdir(), "ak-safe-rmdir-"));
  const tree = join(work, "tree");
  const target = join(work, "target");
  mkdirSync(join(tree, "sub"), { recursive: true });
  mkdirSync(join(target, "inner"), { recursive: true });
  writeFileSync(join(tree, "sub", "a.txt"), "a");
  writeFileSync(join(target, "inner", "keep.txt"), "keep");
  return { work, tree, target };
}

describe("safe-rmdir (#1033)", () => {
  it("refuses a tree holding a reparse point that points OUTSIDE the tree, and leaves the target intact", () => {
    const { work, tree, target } = fixture();
    try {
      symlinkSync(target, join(tree, "borrowed"), "junction");
      const r = run([tree, "--json"]);
      expect(r.status).toBe(2);
      const parsed = JSON.parse(r.stdout.trim().split(/\r?\n/).pop()!);
      expect(parsed.refused).toBe(true);
      expect(parsed.outbound).toHaveLength(1);
      expect(existsSync(join(tree, "sub", "a.txt"))).toBe(true);
      expect(existsSync(join(target, "inner", "keep.txt"))).toBe(true);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("deletes a tree with no outbound reparse points (in-tree links included)", () => {
    const { work, tree, target } = fixture();
    try {
      // An in-tree link, the shape pnpm's own virtual store uses — must not count as outbound.
      symlinkSync(join(tree, "sub"), join(tree, "alias"), "junction");
      const r = run([tree, "--json"]);
      expect(r.status).toBe(0);
      expect(existsSync(tree)).toBe(false);
      expect(existsSync(join(target, "inner", "keep.txt"))).toBe(true);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("--unlink-outbound drops the LINK only, then deletes the tree; the target survives", () => {
    const { work, tree, target } = fixture();
    try {
      symlinkSync(target, join(tree, "borrowed"), "junction");
      const r = run([tree, "--unlink-outbound", "--json"]);
      expect(r.status).toBe(0);
      expect(existsSync(tree)).toBe(false);
      expect(existsSync(join(target, "inner", "keep.txt"))).toBe(true);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("--dry-run reports without deleting", () => {
    const { work, tree } = fixture();
    try {
      const r = run([tree, "--dry-run"]);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/would delete/);
      expect(existsSync(join(tree, "sub", "a.txt"))).toBe(true);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});

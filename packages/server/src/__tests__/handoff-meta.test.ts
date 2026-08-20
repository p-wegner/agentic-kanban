import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readHandoffMeta } from "../services/handoff.service.js";

// #89: readHandoffMeta is the read-only feed source behind GET /api/workspaces/:id/handoff —
// mtime + truncated excerpt, absent-safe. Exercised against real temp worktrees.
describe("readHandoffMeta (#89)", () => {
  async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "handoff-meta-"));
    try {
      await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("reports absent when no HANDOFF.md exists", async () => {
    await withTempDir(async (dir) => {
      expect(await readHandoffMeta(dir)).toEqual({ exists: false, updatedAt: null, excerpt: null });
    });
  });

  it("reports exists + an ISO mtime + the full content when short", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "HANDOFF.md"), "# Session Handoff\n\nDid the thing.\n", "utf8");
      const meta = await readHandoffMeta(dir);
      expect(meta.exists).toBe(true);
      expect(meta.excerpt).toContain("Did the thing.");
      expect(meta.updatedAt).not.toBeNull();
      // A valid ISO timestamp round-trips through Date.
      expect(new Date(meta.updatedAt as string).toISOString()).toBe(meta.updatedAt);
    });
  });

  it("truncates the excerpt to the max and appends an ellipsis", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "HANDOFF.md"), "x".repeat(1000), "utf8");
      const meta = await readHandoffMeta(dir, 100);
      expect(meta.exists).toBe(true);
      expect(meta.excerpt).toBe("x".repeat(100) + "...");
    });
  });
});

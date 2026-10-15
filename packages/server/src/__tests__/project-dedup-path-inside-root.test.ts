// @covers project-registration.dedup.insideRootGuard [regression]
// #1508: deduplicateProjects must never merge a project whose own path is not inside the
// git root that a (possibly wrong) `rev-parse` reported for it.
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPathInside } from "../services/project-registration.js";

describe("isPathInside (#1508 dedup guard)", () => {
  it("accepts the root itself and subdirectories, rejects siblings and parents", () => {
    const base = mkdtempSync(join(tmpdir(), "ak-dedup-inside-"));
    try {
      const a = join(base, "agentic-kanban");
      const sub = join(a, "packages", "server");
      const other = join(base, "exp", "shelfwise");
      mkdirSync(sub, { recursive: true });
      mkdirSync(other, { recursive: true });
      expect(isPathInside(a, a)).toBe(true);
      expect(isPathInside(sub, a)).toBe(true);
      expect(isPathInside(other, a)).toBe(false);
      expect(isPathInside(base, a)).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

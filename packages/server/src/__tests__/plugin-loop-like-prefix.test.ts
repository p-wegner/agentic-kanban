import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pluginLoopUnitKey } from "@agentic-kanban/shared/lib/plugin-manifest";
import { createTestDb } from "./helpers/test-db.js";
import { seedProject, seedIssue } from "./helpers/workflow-test-helpers.js";
import { createPluginService } from "../services/plugin.service.js";
import { escapeLikeLiteral } from "../repositories/plugins.repository.js";
import type { Database } from "../db/index.js";

/**
 * #250 — the loop's ticket lookup matches its key prefix LITERALLY.
 *
 * A loop named `extract_v2` puts a `_` (a single-character LIKE wildcard) into
 * `plugin-loop:<slug>:extract_v2:`, so an unescaped match also picked up `extractXv2`'s tickets.
 * That is not cosmetic: `loopStatuses` feeds the monitor's `openTickets > 0` gate, so one loop's
 * open round blocked the other's advance (and its closed round released it).
 */

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const MANIFEST = {
  id: "wildcard-plugin",
  name: "Wildcard Plugin",
  skills: [{ dir: "skills/analysis" }],
  loops: [
    { name: "extract_v2", skill: "analysis", plan: { command: "exit 1", cwd: "plugin" } },
    { name: "extractXv2", skill: "analysis", plan: { command: "exit 1", cwd: "plugin" } },
  ],
};

function makePluginDir(): string {
  const dir = makeTempDir("loop-like-plugin-");
  writeFileSync(join(dir, "kanban-plugin.json"), JSON.stringify(MANIFEST, null, 2));
  const skillDir = join(dir, "skills", "analysis");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "# analysis");
  return dir;
}

describe("plugin loop ticket lookup — literal key prefix (#250)", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows file locks — best-effort cleanup */
      }
    }
  });

  it("escapes the LIKE metacharacters in a key prefix", () => {
    expect(escapeLikeLiteral("plugin-loop:p:extract_v2:")).toBe("plugin-loop:p:extract\\_v2:");
    expect(escapeLikeLiteral("a%b_c\\d")).toBe("a\\%b\\_c\\\\d");
  });

  it("a loop named extract_v2 does not count another loop's tickets", async () => {
    const { db } = createTestDb();
    const { projectId, statusId } = await seedProject(db, "Wildcard Project");
    // One OPEN ticket, belonging to `extractXv2` only.
    await seedIssue(db, projectId, statusId, 1, "sibling loop round", {
      externalKey: pluginLoopUnitKey("wildcard-plugin", "extractXv2", "unit-1"),
    });

    const service = createPluginService({ database: db as unknown as Database });
    const plugin = await service.installPlugin({ source: makePluginDir() });
    const statuses = await service.listLoops(plugin.id, projectId);

    expect(statuses.map((s) => ({ name: s.name, open: s.openTickets, closed: s.closedTickets }))).toEqual([
      { name: "extract_v2", open: 0, closed: 0 },
      { name: "extractXv2", open: 1, closed: 0 },
    ]);
  });
});

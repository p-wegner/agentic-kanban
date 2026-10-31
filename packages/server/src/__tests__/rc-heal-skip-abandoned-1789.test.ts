import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { rcHealSkipReason } from "../services/rc-heal-sweep-hook.js";
import type { Database } from "../db/index.js";

describe("rcHealSkipReason (#1789)", () => {
  it("skips a heal for a candidate rc-state marks abandoned", async () => {
    const stable = mkdtempSync(join(tmpdir(), "rc-skip-"));
    mkdirSync(join(stable, ".kanban"));
    writeFileSync(join(stable, ".kanban", "rc-state.json"), JSON.stringify({
      version: 1,
      candidates: [{ branch: "rc/20261030", sha: "abc", state: "abandoned", updatedAt: new Date().toISOString() }],
    }));
    const prev = process.env.KANBAN_STABLE_CHECKOUT;
    process.env.KANBAN_STABLE_CHECKOUT = stable;
    try {
      const reason = await rcHealSkipReason({ projectId: "p", branch: "rc/20261030", sha: "abc", repoPath: stable }, {} as Database);
      expect(reason).toContain("abandoned");
    } finally {
      if (prev === undefined) delete process.env.KANBAN_STABLE_CHECKOUT; else process.env.KANBAN_STABLE_CHECKOUT = prev;
    }
  });
});

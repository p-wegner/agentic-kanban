import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  parseSelection,
  resolveGateImpactSelection,
  resolveGateMinScore,
  resolveGateSelection,
} from "../services/test-impact-outcome.service.js";

/**
 * #956 — the selection facts the `impact` tier's pass message is built from.
 *
 * These are the numbers the tier's honesty rests on, and every one of them arrives by parsing the
 * output of a tool that lives OUTSIDE this package (the skill is materialized into worktrees and
 * versioned independently). So the parse must be pinned in both directions: it reads the fields
 * when they are there, and it degrades to a stated default — never a throw, never a plausible
 * fiction — when they are not.
 */

const payload = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    tier: "impact",
    selected: [{ test: "packages/server/src/__tests__/a.test.ts" }, { test: "packages/shared/__tests__/b.test.ts" }],
    changed: ["packages/server/src/services/a.ts"],
    belowFloor: ["x.test.ts", "y.test.ts", "z.test.ts"],
    stale: false,
    ...extra,
  });

describe("parseSelection", () => {
  it("reads the below-floor count and the staleness flag", () => {
    const parsed = parseSelection(payload());
    expect(parsed?.selected).toHaveLength(2);
    expect(parsed?.belowFloorCount).toBe(3);
    expect(parsed?.stale).toBe(false);
    expect(parsed?.tier).toBe("impact");
    expect(parsed?.changed).toEqual(["packages/server/src/services/a.ts"]);
  });

  it("reports a stale map when the tool says so", () => {
    expect(parseSelection(payload({ stale: true }))?.stale).toBe(true);
  });

  it("degrades an absent belowFloor to 0 rather than throwing", () => {
    // An older skill build. A wrong-low 0 is visible beside `selectedCount` in the message, which
    // is the failure direction to prefer over refusing to report a selection at all.
    const parsed = parseSelection(JSON.stringify({ tier: "impact", selected: [], changed: [] }));
    expect(parsed?.belowFloorCount).toBe(0);
    expect(parsed?.stale).toBe(false);
  });

  it("returns null for output that is not a selection at all", () => {
    expect(parseSelection("not json")).toBeNull();
    expect(parseSelection(JSON.stringify({ tier: "impact" }))).toBeNull();
  });
});

describe("resolveGateMinScore", () => {
  it("mirrors test-mine.mjs: default 1.0, honour a numeric override, reject anything else", () => {
    expect(resolveGateMinScore({})).toBe("1.0");
    expect(resolveGateMinScore({ KANBAN_TEST_MIN_SCORE: " 2.5 " })).toBe("2.5");
    expect(resolveGateMinScore({ KANBAN_TEST_MIN_SCORE: "high" })).toBe("1.0");
  });
});

describe("resolveGateSelection — the args it asks impact.mjs for", () => {
  /**
   * The args ARE the finding. `impact.mjs` computes `belowFloor` only when `--min-score > 0` and
   * defaults it to `0`, so an unfloored call reports "dropped 0 below the score floor" on every
   * run while the real verify run (floor 1.0) dropped a whole tail — the tier weakening the gate
   * by an amount the message pins at zero. The base must stay positional for the same class of
   * reason (#963).
   */
  const withTool = () => {
    const dir = mkdtempSync(join(tmpdir(), "ak-gate-impact-args-"));
    const tool = join(dir, ".claude/skills/test-impact/tools/impact.mjs");
    mkdirSync(dirname(tool), { recursive: true });
    writeFileSync(tool, "// stub\n");
    return dir;
  };

  it("passes the base positionally and the SAME score floor the verify run will use", async () => {
    const seen: string[][] = [];
    await resolveGateSelection({
      workingDir: withTool(),
      baseBranch: "master",
      minScore: "1.0",
      runCommand: async ({ args }) => {
        seen.push(args);
        return { exitCode: 0, stdout: JSON.stringify({ tier: "impact", selected: [], changed: [] }), stderr: "" };
      },
    });
    const args = seen[0];
    // Positional, immediately after the subcommand — never `--base`.
    expect(args[1]).toBe("select");
    expect(args[2]).toBe("master");
    expect(args).not.toContain("--base");
    expect(args[args.indexOf("--min-score") + 1]).toBe("1.0");
  });

  it("still passes a floor when the workspace has no base branch", async () => {
    const seen: string[][] = [];
    await resolveGateSelection({
      workingDir: withTool(),
      baseBranch: null,
      minScore: "1.0",
      runCommand: async ({ args }) => {
        seen.push(args);
        return { exitCode: 0, stdout: JSON.stringify({ tier: "impact", selected: [], changed: [] }), stderr: "" };
      },
    });
    expect(seen[0][2]).toBe("--json");
    expect(seen[0]).toContain("--min-score");
  });
});

describe("resolveGateImpactSelection", () => {
  it("returns undefined — not null — when the run is not impact-selected", () => {
    // The two are deliberately different: `undefined` means "there is no selection to describe",
    // `null` means "there is one and we could not read it". Only the second is worth a loud
    // UNKNOWN in the gate message.
    return expect(
      resolveGateImpactSelection({ applies: false, workingDir: "/nope", baseBranch: "master" }),
    ).resolves.toBeUndefined();
  });

  it("returns null when the tool is not present in the worktree", async () => {
    expect(
      await resolveGateImpactSelection({ applies: true, workingDir: "/definitely/not/a/worktree", baseBranch: "master" }),
    ).toBeNull();
  });

  it("returns null for a null worktree rather than rejecting into the merge path", async () => {
    expect(await resolveGateImpactSelection({ applies: true, workingDir: null })).toBeNull();
  });
});

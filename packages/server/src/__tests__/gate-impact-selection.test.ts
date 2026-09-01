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

  it("reads signalCounts.external as what the OTHER selector contributed (#967)", () => {
    // The provenance split the message prints (`impact 143 + related added 12`) is computed from
    // this one number. It is read off `signalCounts` -- which the tool computes once -- rather than
    // re-derived from `selected[].signals` here, so the two cannot disagree.
    expect(parseSelection(payload({ signalCounts: { self: 1, importer: 8, external: 12 } }))?.externalCount).toBe(12);
  });

  it("distinguishes 'the union added nothing' from 'no union ran' (#967)", () => {
    // 0 is a real result -- the impact ranking had already picked every suite `related` named,
    // which is worth saying. It must not read the same as "no second selector was consulted".
    expect(parseSelection(payload({ signalCounts: { external: 0 } }))?.externalCount).toBe(0);
    expect(parseSelection(payload({ signalCounts: { importer: 3 } }))?.externalCount).toBeUndefined();
    expect(parseSelection(payload())?.externalCount).toBeUndefined();
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

  it("passes a supplied union as --union, so the DESCRIPTION matches the run (#967)", async () => {
    // Same class of reason as the floor and the budget above: this call exists to describe the
    // selection the verify run will make. A union applied by the run but not here would report a
    // `selected` set narrower than what executes, and `signalCounts.external` absent -- a message
    // saying "impact chose these N" for a run where a second selector also chose some.
    //
    // It stays a TOOL flag rather than a merge on the result because `impact.mjs` admits externals
    // after the `--min-score` cut and BEFORE the `--budget` cut. Unioning here would append them to
    // an already-budgeted selection, so a 60s budget would describe a run that took longer.
    const seen: string[][] = [];
    await resolveGateSelection({
      workingDir: withTool(),
      baseBranch: "master",
      minScore: "1.0",
      budget: "60s",
      union: ["packages/server/src/__tests__/a.test.ts", "packages/shared/__tests__/b.test.ts", "   "],
      runCommand: async ({ args }) => {
        seen.push(args);
        return { exitCode: 0, stdout: JSON.stringify({ tier: "impact", selected: [], changed: [] }), stderr: "" };
      },
    });
    const args = seen[0];
    expect(args).toContain("--budget");
    // Blank entries are dropped -- a stray comma must not become a phantom test path.
    expect(args[args.indexOf("--union") + 1]).toBe(
      "packages/server/src/__tests__/a.test.ts,packages/shared/__tests__/b.test.ts",
    );
  });

  it("omits --union when there is none, keeping the pre-#967 argv byte-identical", async () => {
    const seen: string[][] = [];
    for (const union of [undefined, [], ["", "  "]]) {
      await resolveGateSelection({
        workingDir: withTool(),
        baseBranch: "master",
        minScore: "1.0",
        union,
        runCommand: async ({ args }) => {
          seen.push(args);
          return { exitCode: 0, stdout: JSON.stringify({ tier: "impact", selected: [], changed: [] }), stderr: "" };
        },
      });
    }
    for (const args of seen) expect(args).not.toContain("--union");
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

/**
 * #967 -- the union has THREE states, and conflating any two of them is a silent misreport:
 *   - no union            -> `externalCount` and `unionUnmeasured` both absent
 *   - union, size known   -> `externalCount` set (0 is a real answer: related added nothing new)
 *   - union, size unknown -> `unionUnmeasured`, because this describing call cannot boot vitest
 */
describe("resolveGateImpactSelection and the union it cannot measure (#967)", () => {
  const withTool = () => {
    const dir = mkdtempSync(join(tmpdir(), "ak-gate-impact-union-"));
    const tool = join(dir, ".claude/skills/test-impact/tools/impact.mjs");
    mkdirSync(dirname(tool), { recursive: true });
    writeFileSync(tool, "// stub\n");
    return dir;
  };
  const replying = (body: unknown) => async () => ({ exitCode: 0, stdout: JSON.stringify(body), stderr: "" });

  it("marks the selection unionUnmeasured when a union WILL happen but no list was supplied", async () => {
    // The board knows the runner will union -- it emitted `KANBAN_TEST_FILES` alongside the
    // selector -- but it cannot compute the contents: `vitest related`'s picks come out of vitest's
    // own per-package module graph, walked in the worktree at run time. Saying so is the point;
    // reporting the impact half as the whole selection understates what ran, which is the
    // flattering direction and therefore the one that must be labelled.
    const selection = await resolveGateImpactSelection({
      applies: true,
      workingDir: withTool(),
      baseBranch: "master",
      unioned: true,
      runCommand: replying({ tier: "impact", selected: [{ test: "a.test.ts" }], changed: ["x.ts"] }),
    });
    expect(selection?.unionUnmeasured).toBe(true);
    expect(selection?.externalCount).toBeUndefined();
  });

  it("does NOT mark it unmeasured when the union was supplied and the tool counted it", async () => {
    const selection = await resolveGateImpactSelection({
      applies: true,
      workingDir: withTool(),
      baseBranch: "master",
      unioned: true,
      union: ["packages/server/src/__tests__/u.test.ts"],
      runCommand: replying({
        tier: "impact",
        selected: [{ test: "a.test.ts" }, { test: "packages/server/src/__tests__/u.test.ts" }],
        changed: ["x.ts"],
        signalCounts: { external: 1 },
      }),
    });
    expect(selection?.unionUnmeasured).toBeUndefined();
    expect(selection?.externalCount).toBe(1);
  });

  it("leaves an ordinary impact-only run untouched -- neither field appears", async () => {
    const selection = await resolveGateImpactSelection({
      applies: true,
      workingDir: withTool(),
      baseBranch: "master",
      runCommand: replying({ tier: "impact", selected: [{ test: "a.test.ts" }], changed: ["x.ts"] }),
    });
    expect(selection?.unionUnmeasured).toBeUndefined();
    expect(selection?.externalCount).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { validateBatchDependencies, IssueError } from "../services/issue.service.js";
import { resolveContractMode, contractModeByProject } from "../startup/monitor-contract.js";

/**
 * #918 — the agentic coupling half. Two pure helpers underpin it:
 *  - `validateBatchDependencies`: the REST/butler-side mirror of the MCP batch tool's
 *    index-based edge validation. Lets a generating agent DECLARE `coupled_with` at creation.
 *  - `resolveContractMode` / `contractModeByProject`: the gated, off-by-default monitor
 *    auto-contract switch, scoped per project like the other auto-* prefs.
 */

describe("validateBatchDependencies", () => {
  it("defaults the edge type to depends_on and normalises", () => {
    const edges = validateBatchDependencies([{ issueIndex: 1, dependsOnIndex: 0 }], 2);
    expect(edges).toEqual([{ issueIndex: 1, dependsOnIndex: 0, type: "depends_on" }]);
  });

  it("accepts a coupled_with edge — symmetric, so a mutual pair is NOT a cycle", () => {
    const edges = validateBatchDependencies(
      [{ issueIndex: 0, dependsOnIndex: 1, type: "coupled_with" }],
      2,
    );
    expect(edges).toHaveLength(1);
    expect(edges[0].type).toBe("coupled_with");
  });

  it("rejects an out-of-range index with the offending edge index", () => {
    try {
      validateBatchDependencies([{ issueIndex: 1, dependsOnIndex: 5 }], 2);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(IssueError);
      expect((err as IssueError).code).toBe("BAD_REQUEST");
      expect((err as Error).message).toContain("out of range");
      expect((err as IssueError & { index?: number }).index).toBe(0);
    }
  });

  it("rejects a self-edge", () => {
    expect(() => validateBatchDependencies([{ issueIndex: 0, dependsOnIndex: 0 }], 1))
      .toThrow(/cannot depend on itself/);
  });

  it("rejects a duplicate edge", () => {
    expect(() => validateBatchDependencies([
      { issueIndex: 1, dependsOnIndex: 0 },
      { issueIndex: 1, dependsOnIndex: 0 },
    ], 2)).toThrow(/duplicate edge/);
  });

  it("rejects a directional cycle but allows the same shape as coupled_with", () => {
    // depends_on 0->1 and 1->0 is a cycle...
    expect(() => validateBatchDependencies([
      { issueIndex: 0, dependsOnIndex: 1, type: "depends_on" },
      { issueIndex: 1, dependsOnIndex: 0, type: "depends_on" },
    ], 2)).toThrow(/cycle/);
    // ...but the same pair as coupled_with (symmetric) is fine.
    expect(() => validateBatchDependencies([
      { issueIndex: 0, dependsOnIndex: 1, type: "coupled_with" },
      { issueIndex: 1, dependsOnIndex: 0, type: "coupled_with" },
    ], 2)).not.toThrow();
  });

  it("returns an empty list for no edges", () => {
    expect(validateBatchDependencies([], 3)).toEqual([]);
  });
});

describe("resolveContractMode", () => {
  it("is off for absent/empty/false/off values (default)", () => {
    for (const v of [undefined, "", "false", "off", "nonsense"]) {
      expect(resolveContractMode(v)).toBe("off");
    }
  });

  it("maps apply/suggest/true", () => {
    expect(resolveContractMode("apply")).toBe("apply");
    expect(resolveContractMode("suggest")).toBe("suggest");
    expect(resolveContractMode("true")).toBe("suggest");
    expect(resolveContractMode("APPLY")).toBe("apply");
  });
});

describe("contractModeByProject", () => {
  it("extracts only non-off per-project modes", () => {
    const prefs = new Map<string, string>([
      ["auto_contract_coupled_aaaaaaaa-1111-2222-3333-444444444444", "apply"],
      ["auto_contract_coupled_bbbbbbbb-1111-2222-3333-444444444444", "suggest"],
      ["auto_contract_coupled_cccccccc-1111-2222-3333-444444444444", "false"],
      ["some_other_pref", "apply"],
    ]);
    const modes = contractModeByProject(prefs);
    expect(modes.get("aaaaaaaa-1111-2222-3333-444444444444")).toBe("apply");
    expect(modes.get("bbbbbbbb-1111-2222-3333-444444444444")).toBe("suggest");
    expect(modes.has("cccccccc-1111-2222-3333-444444444444")).toBe(false);
    expect(modes.size).toBe(2);
  });

  it("is empty when nothing is opted in (off by default)", () => {
    expect(contractModeByProject(new Map()).size).toBe(0);
  });
});

// @covers server.routes.issue-body-schemas.enhanceIssueBody [contract]
// @covers server.routes.issue-body-schemas.analyzeDependenciesBody [contract]
// @covers server.routes.issue-body-schemas.aiEstimateBody [contract]
// @covers server.routes.issue-body-schemas.projectIdBody [contract]
// @covers server.routes.issue-body-schemas.groupScanBody [contract]
// @covers server.routes.issue-body-schemas.decomposeConfirmBody [contract]
// @covers server.routes.issue-body-schemas.contractConfirmBody [contract]
// @covers server.routes.issue-body-schemas.batchIssuesBody [contract]
// @covers server.routes.issue-body-schemas.dependenciesBatchBody [contract]
// @covers server.routes.issue-body-schemas.contractCoupledBody [contract]
// @covers server.routes.issue-body-schemas.bulkUpdateBody [contract]
//
// #688. `routes/issue-body-schemas.ts` replaced a ladder of hand-written 400-guards with zod
// schemas that deliberately COPY the old guards' messages and predicates verbatim (see the
// file's own header). Nothing pinned that the copy is faithful, so a schema could silently
// drift from the message/shape a caller has always seen. These tests assert, per validator:
// a valid body parses, the exact legacy error message survives on the first/only violation,
// and the deliberately-unimproved predicates (bare `Array.isArray`, no element-shape check,
// no `.trim()`) still accept what the old guards accepted.
import { describe, it, expect } from "vitest";
import {
  enhanceIssueBody,
  analyzeDependenciesBody,
  aiEstimateBody,
  projectIdBody,
  groupScanBody,
  decomposeConfirmBody,
  contractConfirmBody,
  batchIssuesBody,
  dependenciesBatchBody,
  contractCoupledBody,
  bulkUpdateBody,
} from "../routes/issue-body-schemas.js";

function firstMessage(result: { success: boolean; error?: { issues: Array<{ message: string }> } }): string {
  if (result.success) throw new Error("expected failure");
  return result.error!.issues[0].message;
}

describe("enhanceIssueBody", () => {
  it("accepts a title with optional description/projectId", () => {
    expect(enhanceIssueBody.safeParse({ title: "Fix bug" }).success).toBe(true);
    expect(enhanceIssueBody.safeParse({ title: "Fix bug", description: "d", projectId: "p1" }).success).toBe(true);
  });

  it("rejects a missing title with the legacy message", () => {
    expect(firstMessage(enhanceIssueBody.safeParse({}))).toBe("title is required");
  });

  it("rejects a blank/whitespace-only title", () => {
    expect(firstMessage(enhanceIssueBody.safeParse({ title: "   " }))).toBe("title is required");
  });

  it("rejects a non-string description as a type error, not silently passed through", () => {
    expect(enhanceIssueBody.safeParse({ title: "t", description: 5 }).success).toBe(false);
  });
});

describe("analyzeDependenciesBody", () => {
  it("accepts both fields present", () => {
    expect(analyzeDependenciesBody.safeParse({ issueId: "i1", projectId: "p1" }).success).toBe(true);
  });

  it("reports the SAME combined message whichever of the two fields is missing", () => {
    expect(firstMessage(analyzeDependenciesBody.safeParse({ projectId: "p1" })))
      .toBe("issueId and projectId are required");
    expect(firstMessage(analyzeDependenciesBody.safeParse({ issueId: "i1" })))
      .toBe("issueId and projectId are required");
  });
});

describe("aiEstimateBody", () => {
  it("accepts an issueId", () => {
    expect(aiEstimateBody.safeParse({ issueId: "i1" }).success).toBe(true);
  });

  it("rejects a missing issueId", () => {
    expect(firstMessage(aiEstimateBody.safeParse({}))).toBe("issueId is required");
  });
});

describe("projectIdBody", () => {
  it("accepts a projectId", () => {
    expect(projectIdBody.safeParse({ projectId: "p1" }).success).toBe(true);
  });

  it("rejects an empty string (requiredRaw has no trim, so whitespace WOULD pass)", () => {
    expect(firstMessage(projectIdBody.safeParse({ projectId: "" }))).toBe("projectId is required");
    // Deliberately preserved legacy behaviour: a bare falsy check, not a trim test.
    expect(projectIdBody.safeParse({ projectId: "   " }).success).toBe(true);
  });
});

describe("groupScanBody", () => {
  it("accepts projectId alone and with an optional apply flag", () => {
    expect(groupScanBody.safeParse({ projectId: "p1" }).success).toBe(true);
    expect(groupScanBody.safeParse({ projectId: "p1", apply: true }).success).toBe(true);
  });

  it("rejects a missing projectId and a non-boolean apply", () => {
    expect(firstMessage(groupScanBody.safeParse({}))).toBe("projectId is required");
    expect(groupScanBody.safeParse({ projectId: "p1", apply: "yes" }).success).toBe(false);
  });
});

describe("decomposeConfirmBody", () => {
  it("accepts arrays of any element shape (element type is deliberately unchecked)", () => {
    const res = decomposeConfirmBody.safeParse({
      projectId: "p1",
      children: [1, "two", { three: 3 }],
      dependencies: [],
    });
    expect(res.success).toBe(true);
  });

  it("accepts an optional driveTarget", () => {
    expect(
      decomposeConfirmBody.safeParse({ projectId: "p1", children: [], dependencies: [], driveTarget: "d1" }).success,
    ).toBe(true);
  });

  it("rejects non-array children/dependencies with the legacy messages", () => {
    expect(firstMessage(decomposeConfirmBody.safeParse({ projectId: "p1", children: "nope", dependencies: [] })))
      .toBe("children must be an array");
    expect(firstMessage(decomposeConfirmBody.safeParse({ projectId: "p1", children: [], dependencies: "nope" })))
      .toBe("dependencies must be an array");
  });
});

describe("contractConfirmBody", () => {
  it("accepts a valid confirm body", () => {
    expect(
      contractConfirmBody.safeParse({
        projectId: "p1",
        survivorId: "s1",
        memberIds: ["s1", "s2"],
        mergedTitle: "Merged",
      }).success,
    ).toBe(true);
  });

  it("rejects fewer than two memberIds with the legacy message", () => {
    expect(
      firstMessage(
        contractConfirmBody.safeParse({
          projectId: "p1",
          survivorId: "s1",
          memberIds: ["s1"],
          mergedTitle: "Merged",
        }),
      ),
    ).toBe("memberIds must be an array of at least 2 ids");
  });

  it("rejects a blank mergedTitle (uses the trimming `required`, not `requiredRaw`)", () => {
    expect(
      firstMessage(
        contractConfirmBody.safeParse({
          projectId: "p1",
          survivorId: "s1",
          memberIds: ["s1", "s2"],
          mergedTitle: "   ",
        }),
      ),
    ).toBe("mergedTitle is required");
  });
});

describe("batchIssuesBody", () => {
  it("accepts the minimal required shape and the optional fields", () => {
    expect(batchIssuesBody.safeParse({ projectId: "p1", issues: [] }).success).toBe(true);
    expect(
      batchIssuesBody.safeParse({
        projectId: "p1",
        issues: [{ title: "a" }],
        parentIssueId: "parent1",
        driveTarget: "d1",
        dependencies: [],
      }).success,
    ).toBe(true);
  });

  it("rejects a non-array issues field", () => {
    expect(firstMessage(batchIssuesBody.safeParse({ projectId: "p1", issues: "nope" })))
      .toBe("issues must be an array");
  });

  it("dependencies is optional but still array-checked when present", () => {
    expect(batchIssuesBody.safeParse({ projectId: "p1", issues: [] }).success).toBe(true);
    expect(batchIssuesBody.safeParse({ projectId: "p1", issues: [], dependencies: "nope" }).success).toBe(false);
  });
});

describe("dependenciesBatchBody", () => {
  it("accepts an edges array", () => {
    expect(dependenciesBatchBody.safeParse({ edges: [{ from: "a", to: "b" }] }).success).toBe(true);
  });

  it("rejects a missing/non-array edges field", () => {
    expect(firstMessage(dependenciesBatchBody.safeParse({}))).toBe("edges must be an array");
  });
});

describe("contractCoupledBody", () => {
  it("accepts a non-empty issueIds array with an optional leadIssueId", () => {
    expect(contractCoupledBody.safeParse({ issueIds: ["i1", "i2"] }).success).toBe(true);
    expect(contractCoupledBody.safeParse({ issueIds: ["i1"], leadIssueId: "i1" }).success).toBe(true);
  });

  it("rejects an empty issueIds array with the legacy message", () => {
    expect(firstMessage(contractCoupledBody.safeParse({ issueIds: [] })))
      .toBe("issueIds must be a non-empty array");
  });
});

describe("bulkUpdateBody", () => {
  it("accepts a non-empty issueIds array and an updates object", () => {
    expect(bulkUpdateBody.safeParse({ issueIds: ["i1"], updates: { priority: "high" } }).success).toBe(true);
  });

  it("rejects an empty issueIds array", () => {
    expect(firstMessage(bulkUpdateBody.safeParse({ issueIds: [], updates: {} })))
      .toBe("issueIds must be a non-empty array");
  });

  it("rejects a missing updates field, and — preserving the legacy `typeof === object` guard — accepts an array as updates", () => {
    expect(firstMessage(bulkUpdateBody.safeParse({ issueIds: ["i1"] }))).toBe("updates is required");
    // Deliberately preserved legacy behaviour: `typeof [] === "object"` is true, and the
    // original guard accepted it — this is NOT `z.record()`, see the file's rule 3.
    expect(bulkUpdateBody.safeParse({ issueIds: ["i1"], updates: [1, 2] }).success).toBe(true);
  });

  it("rejects null and a non-object updates value", () => {
    expect(bulkUpdateBody.safeParse({ issueIds: ["i1"], updates: null }).success).toBe(false);
    expect(bulkUpdateBody.safeParse({ issueIds: ["i1"], updates: "nope" }).success).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { attributeStaticTierFailure } from "../services/merge-train-static-attribution.js";
import { decideAttributedOwners } from "../services/merge-train-suite-owner.js";
import { classifyBreakerTrip, fileOwnerOfFailure, recordBreakerFailure } from "../services/auto-merge-breaker.js";

const A = { workspaceId: "a", branch: "A", changedFiles: ["packages/server/src/services/x.ts"] };
const B = { workspaceId: "b", branch: "B", changedFiles: ["packages/server/src/services/y.ts"] };

describe("static-tier attribution (#1769)", () => {
  it("maps an nloc offender to the member touching it; the other is innocent", () => {
    const r = attributeStaticTierFailure("services/x.ts::createX: 418 (NEW offender)", [A, B]);
    expect(r?.owners.map((m) => m.workspaceId)).toEqual(["a"]);
    expect(r?.innocent.map((m) => m.workspaceId)).toEqual(["b"]);
    // the files feed the existing re-gate-without-owners path
    expect(decideAttributedOwners(r!.files, [A, B])?.innocent).toEqual([B]);
  });

  it("maps an openapi first-difference region to the member touching the route file", () => {
    const R = { workspaceId: "r", branch: "R", changedFiles: ["packages/server/src/routes/plugins.ts"] };
    const r = attributeStaticTierFailure("openapi-drift: first difference near `/api/plugins/{id}/sync/trigger`", [R, B]);
    expect(r?.owners.map((m) => m.workspaceId)).toEqual(["r"]);
  });

  it("returns null when no member touches the named file", () => {
    expect(attributeStaticTierFailure("services/z.ts::f: 400", [A, B])).toBeNull();
  });

  it("trips branch scope when the signature maps to one member", () => {
    const msg = "services/x.ts::createX: 418 (NEW offender)";
    const owner = fileOwnerOfFailure(msg, [A, B]);
    expect(owner).toBe("a");
    let state = null as ReturnType<typeof recordBreakerFailure> | null;
    for (let i = 0; i < 3; i++) state = recordBreakerFailure(state, { signature: msg, attributedWorkspaceId: owner }, new Date().toISOString());
    expect(classifyBreakerTrip(state)).toBe("branch");
  });
});

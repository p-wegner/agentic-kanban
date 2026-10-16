import { beforeEach, describe, expect, it, vi } from "vitest";

const planVerifyPlacement = vi.fn();
const runStaticTier = vi.fn();

vi.mock("../services/static-tier.service.js", () => ({ runStaticTier: (...a: unknown[]) => runStaticTier(...a) }));
vi.mock("../services/verify-job-placement.js", () => ({
  planVerifyPlacement: (...a: unknown[]) => planVerifyPlacement(...a),
  readHeadSha: vi.fn(async () => "abc"),
  runOnPlannedWorker: vi.fn(),
  VerifyJobHeldError: class extends Error {},
}));
vi.mock("../services/pre-merge-gate-tier.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveGateVerification: vi.fn(async () => ({ verifyScript: "pnpm test:mine" })),
}));
vi.mock("../services/gate-quiesce.js", () => ({
  resolveGateHostAdmission: vi.fn(async () => ({ admit: true, reason: "host_has_room" })),
  describeGateHold: vi.fn(() => ({ message: "held" })),
}));
vi.mock("../services/stack-profile.service.js", () => ({ getStackProfile: vi.fn(async () => null) }));

import { runImplementExitCheck } from "../services/implement-exit-check.service.js";

const workspace = { id: "w1", workingDir: "/tmp/does-not-matter", baseBranch: "master" };

describe("implement-exit static tier (#1514)", () => {
  beforeEach(() => {
    planVerifyPlacement.mockReset().mockResolvedValue({ target: "hold", reason: "no free verify worker" });
    runStaticTier.mockReset();
  });

  it("returns the static red even though verify placement would hold", async () => {
    runStaticTier.mockResolvedValue({ ran: true, passed: false, message: "static tier FAILED (check:static, exit 1)", detail: "merge-queue-train.ts 1011/1000" });
    const res = await runImplementExitCheck({ workspace, projectId: "p", level: "impact", database: {} as never });
    expect(res).toMatchObject({ ran: true, passed: false, held: false });
    expect(res.failureDetail).toContain("1011/1000");
    expect(planVerifyPlacement).not.toHaveBeenCalled();
  });

  it("a green static tier leaves the held test part held", async () => {
    runStaticTier.mockResolvedValue({ ran: true, passed: true, message: "ok", detail: null });
    const res = await runImplementExitCheck({ workspace, projectId: "p", level: "impact", database: {} as never });
    expect(res).toMatchObject({ passed: true, held: true });
  });
});

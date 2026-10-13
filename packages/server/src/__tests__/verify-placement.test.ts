import { describe, expect, it } from "vitest";
import {
  acceptWorkerVerdict,
  decideVerifyPlacement,
  describePlacedChain,
  parseVerifyPlacement,
  parseVerifyWorkerAllowlist,
  verifyPlacementPrefKey,
  verifyWorkersPrefKey,
} from "../services/verify-placement.js";

const w = (name: string, extra: Record<string, unknown> = {}) => ({ id: `id-${name}`, name, freeSlots: 1, ...extra });
const allow = parseVerifyWorkerAllowlist("desktop-stable, WSL-stable");

describe("verify placement policy (#1428)", () => {
  it("defaults to host for anything unrecognised", () => {
    for (const raw of [undefined, "", "  ", "cloud", "Workers"]) expect(parseVerifyPlacement(raw)).toBe("host");
    expect(parseVerifyPlacement(" Prefer-Worker ")).toBe("prefer-worker");
    expect(parseVerifyPlacement("worker")).toBe("worker");
  });

  it("keys are per-project", () => {
    expect(verifyPlacementPrefKey("p1")).toBe("verify_placement_p1");
    expect(verifyWorkersPrefKey("p1")).toBe("verify_workers_p1");
  });

  it("host placement never moves a chain", () => {
    const d = decideVerifyPlacement({ placement: "host", kind: "rc-sweep", hostHeld: true, allowlist: allow, workers: [w("desktop-stable")] });
    expect(d.target).toBe("host");
  });

  it("prefer-worker runs on the host while it has room", () => {
    const d = decideVerifyPlacement({ placement: "prefer-worker", kind: "workspace-gate", hostHeld: false, allowlist: allow, workers: [w("desktop-stable")] });
    expect(d.target).toBe("host");
  });

  it("prefer-worker sends a held chain to an allowlisted worker", () => {
    const d = decideVerifyPlacement({ placement: "prefer-worker", kind: "rc-sweep", hostHeld: true, allowlist: allow, workers: [w("desktop-stable")] });
    expect(d).toMatchObject({ target: "worker", workerName: "desktop-stable" });
  });

  it("never offers a worker outside the allowlist or without a slot", () => {
    const d = decideVerifyPlacement({
      placement: "worker",
      kind: "train-gate",
      hostHeld: true,
      allowlist: allow,
      workers: [w("stranger"), w("desktop-stable", { freeSlots: 0 })],
    });
    expect(d.target).toBe("hold");
  });

  it("an empty allowlist trusts nobody", () => {
    const d = decideVerifyPlacement({ placement: "worker", kind: "rc-sweep", hostHeld: true, allowlist: new Set(), workers: [w("desktop-stable")] });
    expect(d).toMatchObject({ target: "hold" });
    expect(d.reason).toContain("empty");
  });

  it("prefer-worker with nobody eligible falls back to host admission, worker holds", () => {
    const base = { kind: "implement-exit" as const, hostHeld: true, allowlist: allow, workers: [] };
    expect(decideVerifyPlacement({ ...base, placement: "prefer-worker" }).target).toBe("host");
    expect(decideVerifyPlacement({ ...base, placement: "worker" }).target).toBe("hold");
  });

  it("ranks calm, then most free RAM", () => {
    const d = decideVerifyPlacement({
      placement: "worker",
      kind: "rc-sweep",
      hostHeld: true,
      allowlist: allow,
      workers: [w("desktop-stable", { freeRamGb: 40, thrashing: true }), w("wsl-stable", { freeRamGb: 8 })],
    });
    expect(d).toMatchObject({ target: "worker", workerName: "wsl-stable" });
  });
});

describe("worker verdict trust (#1428)", () => {
  const request = { requestId: "r1", workerId: "id-desktop-stable", sha: "ABC123def", tier: "full" };
  const report = { requestId: "r1", workerId: "id-desktop-stable", sha: "abc123def", tier: "full", passed: true };

  it("accepts a green for the exact sha and tier (case-insensitive sha)", () => {
    expect(acceptWorkerVerdict(request, report, allow, "desktop-stable")).toEqual({ accepted: true, verdict: "green" });
    expect(acceptWorkerVerdict(request, { ...report, passed: false }, allow, "desktop-stable")).toEqual({ accepted: true, verdict: "red" });
  });

  it("refuses a verdict for a different tree, either colour", () => {
    for (const passed of [true, false]) {
      const r = acceptWorkerVerdict(request, { ...report, sha: "deadbeef", passed }, allow, "desktop-stable");
      expect(r.accepted).toBe(false);
    }
    expect(acceptWorkerVerdict(request, { ...report, sha: "" }, allow, "desktop-stable").accepted).toBe(false);
  });

  it("refuses a different tier, request, worker or a non-allowlisted worker", () => {
    expect(acceptWorkerVerdict(request, { ...report, tier: "scoped" }, allow, "desktop-stable").accepted).toBe(false);
    expect(acceptWorkerVerdict(request, { ...report, requestId: "r2" }, allow, "desktop-stable").accepted).toBe(false);
    expect(acceptWorkerVerdict(request, { ...report, workerId: "other" }, allow, "desktop-stable").accepted).toBe(false);
    expect(acceptWorkerVerdict({ ...request, workerId: "id-x" }, { ...report, workerId: "id-x" }, allow, "x").accepted).toBe(false);
  });

  it("describes a placed chain for the watch view", () => {
    expect(describePlacedChain({ chainId: "c", kind: "rc-sweep", sha: "0123456789abcdef", tier: "full", startedAt: "t" }, "desktop-stable")).toBe(
      "rc-sweep 012345678 (full) on desktop-stable",
    );
  });
});

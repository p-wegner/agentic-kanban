import { describe, expect, it } from "vitest";
import { classifyProcessExit } from "../../../../scripts/dev-supervisor.mjs";
import { planPortOwnerKill } from "../../../../scripts/dev-port-guard.mjs";

describe("dev launcher exit classification", () => {
  it("treats intentional exits and termination signals as clean", () => {
    expect(classifyProcessExit(0, null)).toBe("clean");
    expect(classifyProcessExit(null, "SIGINT")).toBe("clean");
    expect(classifyProcessExit(null, "SIGTERM")).toBe("clean");
  });

  it("keeps code 1 fatal because tsx watch handles hot reload internally", () => {
    expect(classifyProcessExit(1, null)).toBe("fatal");
  });

  it("retries unexpected nonfatal exit codes", () => {
    expect(classifyProcessExit(143, null)).toBe("retry");
    expect(classifyProcessExit(2, null)).toBe("retry");
  });
});

describe("dev launcher port guard", () => {
  it("refuses to kill port 3001 when the owner belongs to another checkout", () => {
    const auditEvents = [];
    const decision = planPortOwnerKill({
      pid: "4242",
      port: 3001,
      checkoutRoot: "C:\\andrena\\.worktrees\\feature_ak-175-harden-board-shutdowns",
      getCommandLine: () => "node C:\\andrena\\agentic-kanban\\node_modules\\tsx\\dist\\cli.mjs src/index.ts",
      audit: (event) => auditEvents.push(event),
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("outside-checkout");
    expect(auditEvents).toContainEqual(expect.objectContaining({
      action: "dev-port-kill-blocked",
      port: 3001,
      pid: "4242",
      reason: "outside-checkout",
    }));
  });
});

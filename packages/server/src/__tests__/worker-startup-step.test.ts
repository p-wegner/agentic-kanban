import { describe, expect, it } from "vitest";
import { runStartupStep } from "../worker/worker-startup-step.js";

describe("runStartupStep (#1551)", () => {
  it("moves on when a step never settles, and says so", async () => {
    const lines: string[] = [];
    await runStartupStep("hangs", () => new Promise(() => {}), (l) => lines.push(l), 20);
    expect(lines.join("\n")).toMatch(/startup: hangs/);
    expect(lines.join("\n")).toMatch(/still running/);
  });

  it("logs and continues when a step throws", async () => {
    const lines: string[] = [];
    await runStartupStep("boom", async () => { throw new Error("nope"); }, (l) => lines.push(l), 1000);
    expect(lines.join("\n")).toMatch(/failed \(continuing\): nope/);
  });

  it("is quiet beyond the start line when the step finishes in time", async () => {
    const lines: string[] = [];
    await runStartupStep("ok", async () => 1, (l) => lines.push(l), 1000);
    expect(lines).toHaveLength(1);
  });
});

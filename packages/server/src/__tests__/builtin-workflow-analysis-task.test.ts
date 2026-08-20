// @covers builtin-workflows.analysis-task [policy]
import { describe, it, expect } from "vitest";
import { validateGraph } from "@agentic-kanban/shared/lib/workflow-engine";
import { BUILTIN_WORKFLOWS } from "../db/builtin-workflows.js";

/**
 * The "Analysis Task" builtin exists because every other template ends in a gate that an
 * analysis round cannot pass usefully:
 *
 *   - Simple Ticket routes through Review — but a round that writes documents has no product
 *     diff for a reviewer to judge, so the gate can only rubber-stamp it.
 *   - Research Task routes through Consult User — which parks the ticket until a human appears,
 *     fatal for a plugin loop that advances unattended.
 *
 * These tests pin the properties that make it fit, so a later edit cannot quietly reintroduce a
 * gate and strand every plugin round behind it again.
 */
describe("builtin workflow: analysis-task", () => {
  const template = BUILTIN_WORKFLOWS.find((t) => t.builtinKey === "analysis-task");

  it("is registered as a selectable (non-default) global template", () => {
    expect(template).toBeDefined();
    expect(template!.ticketType).toBeNull();
    // Never the default: it must be chosen, per skill or per launch — it deliberately has no
    // review, so it should never become the flow a normal code ticket silently inherits.
    expect(template!.isDefault).toBe(false);
  });

  it("has no review node and no human-consult node", () => {
    const names = template!.nodes.map((n) => n.name.toLowerCase());
    expect(names.some((n) => n.includes("review"))).toBe(false);
    expect(names.some((n) => n.includes("consult"))).toBe(false);
    expect(template!.nodes.some((n) => n.skillName === "code-review")).toBe(false);
  });

  it("advances to done automatically on a clean exit, so an unattended loop completes", () => {
    const done = template!.nodes.find((n) => n.nodeType === "end")!;
    const toDone = template!.edges.filter((e) => e.to === done.key);
    expect(toDone).toHaveLength(1);
    expect(toDone[0].condition).toBe("auto_on_exit_0");
  });

  it("leaves a failed round In Progress rather than routing it to done", () => {
    // No manual escape hatch into `done`: the ONLY way in is a clean exit. A round that fails
    // must surface as stuck, not report success.
    const done = template!.nodes.find((n) => n.nodeType === "end")!;
    const manualIntoDone = template!.edges.filter((e) => e.to === done.key && e.condition !== "auto_on_exit_0");
    expect(manualIntoDone).toEqual([]);
  });

  it("is a valid graph by the same rules the visual builder enforces", () => {
    const errors = validateGraph(
      template!.nodes.map((n) => ({ id: n.key, name: n.name, nodeType: n.nodeType })),
      template!.edges.map((e) => ({ fromNodeId: e.from, toNodeId: e.to, isLoop: !!e.isLoop })),
    );
    expect(errors).toEqual([]);
  });

  it("keeps every builtin key unique", () => {
    const keys = BUILTIN_WORKFLOWS.map((t) => t.builtinKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

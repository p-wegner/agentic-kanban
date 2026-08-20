import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProgressStepper, stepCost, type PluginProgressStep } from "./PluginLoopExtras.js";

/**
 * #453 — the live mealplan pipeline: 9 steps, a multi-artifact step, and the two states that
 * used to be indistinguishable (`locked` vs `pending`).
 */
const STEPS: PluginProgressStep[] = [
  { id: "step-5", label: "Architecture, Data Model & API Spec", state: "done", version: "v1", artifacts: [
    "docs/pm-pipeline/steps/step-5/architecture.md",
    "docs/pm-pipeline/steps/step-5/database_schema.sql",
    "docs/pm-pipeline/steps/step-5/openapi_spec.yaml",
  ] },
  { id: "step-6", label: "Code Generation (MVP skeleton)", state: "done", version: "v2", artifacts: [
    "docs/pm-pipeline/steps/step-6/code_report.md",
  ] },
  { id: "step-7", label: "Test & QA (plan + execution)", state: "awaiting-approval", version: "v1", artifacts: [
    "docs/pm-pipeline/steps/step-7/test_plan.md",
  ] },
  { id: "step-8", label: "CI/CD & Deployment", state: "pending" },
  { id: "step-9", label: "Go-To-Market & User Documentation", state: "locked" },
];

const COST = [
  { unitId: "step-6:v1", costUsd: 4.3244077, sessions: 1 },
  { unitId: "step-6:v2", costUsd: 0.5, sessions: 2 },
  { unitId: "step-7:v1", costUsd: 3.3283196, sessions: 1 },
];

describe("stepCost", () => {
  it("joins `step-<n>:v<m>` units to their step and sums the versions", () => {
    expect(stepCost("step-6", COST)).toEqual({
      totalUsd: 4.8244077,
      sessions: 3,
      versions: [COST[0], COST[1]],
    });
  });

  it("is null for a step with no recorded cost, and tolerates a missing payload", () => {
    expect(stepCost("step-9", COST)).toBeNull();
    expect(stepCost("step-6")).toBeNull();
    expect(stepCost("step-6", null)).toBeNull();
  });

  it("does not match a step id by prefix alone", () => {
    // `step-1` must not absorb `step-10`'s cost.
    expect(stepCost("step-1", [{ unitId: "step-10:v1", costUsd: 9, sessions: 1 }])).toBeNull();
  });
});

describe("ProgressStepper", () => {
  const html = renderToStaticMarkup(
    <ProgressStepper steps={STEPS} costByUnit={COST} activePath="docs/pm-pipeline/steps/step-5/database_schema.sql" onOpenStep={() => {}} />,
  );

  it("renders one row per step, each carrying its state", () => {
    expect(html).toContain('data-testid="plugin-loop-step-step-7"');
    expect(html).toContain('data-step-state="awaiting-approval"');
    expect(html).toContain("1/5");
    expect(html).toContain("5/5");
  });

  it("tells locked apart from pending in words, not only in tone", () => {
    expect(html).toContain("locked — waiting on an earlier step");
    expect(html).toContain("not started");
  });

  it("puts every artifact of a step in reach without opening one first", () => {
    expect(html).toContain("architecture.md");
    expect(html).toContain("database_schema.sql");
    expect(html).toContain("openapi_spec.yaml");
  });

  it("shows per-step cost joined from the loop's byUnit payload", () => {
    expect(html).toContain('data-testid="plugin-loop-step-cost-step-6"');
    expect(html).toContain("$4.82");
    expect(html).toContain("$3.33");
    // A step with no cost gets no money element at all.
    expect(html).not.toContain('data-testid="plugin-loop-step-cost-step-9"');
  });

  it("marks the open artifact's step and chip as current (#423)", () => {
    expect(html).toContain('aria-current="true"');
  });

  it("renders nothing without steps, and no cost when none is supplied", () => {
    expect(renderToStaticMarkup(<ProgressStepper steps={[]} onOpenStep={() => {}} />)).toBe("");
    expect(renderToStaticMarkup(<ProgressStepper steps={undefined} onOpenStep={() => {}} />)).toBe("");
    const bare = renderToStaticMarkup(<ProgressStepper steps={STEPS} onOpenStep={() => {}} />);
    expect(bare).not.toContain("plugin-loop-step-cost-");
    expect(bare).toContain("Test &amp; QA (plan + execution)");
  });
});

/**
 * #481 — the Start affordance on a planned step.
 *
 * The complaint: the panel rendered "generating" for a step nothing was working, while a
 * notice on the same screen said the ticket would not start on its own — and the step card,
 * where the user is looking, offered nothing to click.
 */
describe("ProgressStepper — Start on a planned step (#481)", () => {
  const planned: PluginProgressStep = {
    id: "step-2",
    label: "Draft the PRD",
    state: "planned",
    ticket: { issueId: "iss-4", issueNumber: 4 },
  };

  it("offers Start on a planned step that has a ticket", () => {
    const html = renderToStaticMarkup(
      <ProgressStepper steps={[planned]} onOpenStep={() => {}} onStartStep={() => {}} />,
    );
    expect(html).toContain('data-testid="plugin-loop-step-start-step-2"');
    expect(html).toContain("Start #4");
  });

  it("offers nothing when the step has no ticket to start", () => {
    // A planner can report `planned` for a step the board never ticketed; there is nothing
    // to start, and a dead button would be worse than none.
    const html = renderToStaticMarkup(
      <ProgressStepper steps={[{ ...planned, ticket: undefined }]} onOpenStep={() => {}} onStartStep={() => {}} />,
    );
    expect(html).not.toContain("plugin-loop-step-start-");
  });

  it("does NOT offer Start on a stalled step", () => {
    // `stalled` already HAS a workspace (#479) — starting a second one is not the remedy,
    // and offering it here would duplicate the loop-stall card's job.
    const html = renderToStaticMarkup(
      <ProgressStepper steps={[{ ...planned, state: "stalled" }]} onOpenStep={() => {}} onStartStep={() => {}} />,
    );
    expect(html).not.toContain("plugin-loop-step-start-");
  });

  it("does NOT offer Start when the caller passes no handler", () => {
    // Without `onStartStep` the step still SAYS planned — it just cannot be acted on here,
    // which is the pre-#481 behaviour and must stay available to other callers.
    const html = renderToStaticMarkup(<ProgressStepper steps={[planned]} onOpenStep={() => {}} />);
    expect(html).not.toContain("plugin-loop-step-start-");
    expect(html).toContain("planned — not started yet");
  });

  it("disables the button while that step's start is in flight", () => {
    const html = renderToStaticMarkup(
      <ProgressStepper steps={[planned]} onOpenStep={() => {}} onStartStep={() => {}} startingStepId="step-2" />,
    );
    expect(html).toContain("Starting…");
    expect(html).toContain("disabled");
  });
});

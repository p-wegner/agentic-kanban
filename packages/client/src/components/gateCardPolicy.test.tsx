import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GateCard, type PluginGate, type PluginGateAction } from "./PluginLoopExtras.js";
import {
  canSubmitGateAction,
  gateFeedbackText,
  gateInputPlaceholder,
  isWaiverAction,
  viewGateRecommendation,
} from "./gateCardPolicy.js";

/** The MEASURED #378 gate: plain `approve` was withdrawn AFTER the recommendation was stored. */
const waiveAction: PluginGateAction = {
  id: "approve-waive",
  label: "Approve, waiving unexecuted QA (reason required)",
  input: "text",
};
const reviseAction: PluginGateAction = { id: "revise", label: "Needs revision", input: "text" };
const staleGate: PluginGate = {
  id: "step-7:v1",
  question: "⚠ 17 acceptance criteria are UNEXECUTED — approving waives them and needs a written reason.",
  actions: [waiveAction, reviseAction],
};

describe("#378 A — a stored recommendation is revalidated against the offered actions at read time", () => {
  it("refuses to make a withdrawn action actionable", () => {
    const view = viewGateRecommendation(staleGate, { actionId: "approve", reason: "PASS WITH FIXES" });
    expect(view).toEqual({ actionable: false, skipReason: "action-not-offered" });
  });

  it("still resolves a recommendation the gate does offer", () => {
    const view = viewGateRecommendation(staleGate, { actionId: "revise", reason: "concrete defect" });
    expect(view).toEqual({ actionable: true, action: reviseAction });
  });

  it("has no view at all when nothing was recommended", () => {
    expect(viewGateRecommendation(staleGate, null)).toBeNull();
    expect(viewGateRecommendation(staleGate, undefined)).toBeNull();
  });

  it("renders NO Accept control for the withdrawn action, and says why", () => {
    const html = renderToStaticMarkup(
      <GateCard
        pluginId="p1"
        loopName="pm"
        projectId="proj"
        gate={staleGate}
        recommendation={{ actionId: "approve", reason: "PASS WITH FIXES" }}
        onResolved={() => {}}
        onOpenArtifact={() => {}}
      />,
    );
    // The pre-read itself is kept — it is still useful context.
    expect(html).toContain("Butler recommends");
    expect(html).toContain('data-recommendation-state="action-not-offered"');
    expect(html).toContain("no longer offered on this gate");
    // The dead control is gone. This is the regression: the Accept button existed, looked
    // enabled, and did nothing on click because `approve` is not in `gate.actions`.
    expect(html).not.toContain(">Accept<");
  });

  it("keeps the Accept control when the recommended action is offered", () => {
    const html = renderToStaticMarkup(
      <GateCard
        pluginId="p1"
        loopName="pm"
        projectId="proj"
        gate={staleGate}
        recommendation={{ actionId: "revise", reason: "concrete defect" }}
        onResolved={() => {}}
        onOpenArtifact={() => {}}
      />,
    );
    expect(html).toContain(">Accept<");
    expect(html).toContain('data-recommendation-state="actionable"');
  });
});

describe("#378 B — a required text input is enforced visibly, not silently", () => {
  it("cannot submit a text action with an empty box", () => {
    expect(canSubmitGateAction(waiveAction, "")).toBe(false);
    expect(canSubmitGateAction(waiveAction, "   \n  ")).toBe(false);
  });

  it("can submit once a reason is typed", () => {
    expect(canSubmitGateAction(waiveAction, "QA deferred to the next milestone")).toBe(true);
  });

  it("accepts line-anchored diff notes as the feedback on their own (#304)", () => {
    expect(canSubmitGateAction(reviseAction, "", ["status.md:12: wrong owner"])).toBe(true);
    expect(gateFeedbackText("typed", ["a", "b"])).toBe("typed\na\nb");
    expect(gateFeedbackText("  ", [])).toBe("");
  });

  it("never blocks an action that declares no input", () => {
    expect(canSubmitGateAction({ id: "approve", label: "Approve" }, "")).toBe(true);
  });
});

describe("#378 C — the text box asks the question the action actually needs", () => {
  it("asks a waiver why, not what should change", () => {
    expect(isWaiverAction(waiveAction)).toBe(true);
    const placeholder = gateInputPlaceholder(waiveAction);
    expect(placeholder).toContain("why are you waiving this?");
    expect(placeholder).not.toContain("what should change");
    // The text becomes a permanent audit record, so say so.
    expect(placeholder).toContain("permanently");
  });

  it("keeps the revise wording for a revise action", () => {
    expect(isWaiverAction(reviseAction)).toBe(false);
    expect(gateInputPlaceholder(reviseAction)).toContain("what should change");
  });
});

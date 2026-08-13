import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GateCard, type PluginCheck, type PluginGate, type PluginGateAction } from "./PluginLoopExtras.js";
import {
  canSubmitGateAction,
  gateActionButtonClasses,
  gateActionIntent,
  gateFeedbackText,
  gateInputPlaceholder,
  gateRecommendationConflict,
  isWaiverAction,
  partitionGateChecks,
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
    expect(html).toContain('data-testid="plugin-gate-recommendation-accept"');
    // #414 — the control NAMES the action it will take. "Accept" alone did not say what it
    // accepted, next to a gate where the recommended action waives unexecuted QA criteria.
    expect(html).toContain(">Do it: Needs revision<");
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

describe("#450 — actions are styled by what they MEAN, not by whether they need text", () => {
  it("reads the two opposite QA-gate decisions differently", () => {
    // The MEASURED defect: both declare `input: "text"`, so the old rule gave them the same
    // amber outline and the gate had no primary action at all.
    expect(gateActionIntent(waiveAction)).toBe("approve-override");
    expect(gateActionIntent(reviseAction)).toBe("reject");
    expect(gateActionButtonClasses(gateActionIntent(waiveAction)))
      .not.toBe(gateActionButtonClasses(gateActionIntent(reviseAction)));
  });

  it("makes a plain approve the primary action", () => {
    expect(gateActionIntent({ id: "approve", label: "Approve" })).toBe("approve");
    expect(gateActionButtonClasses("approve")).toContain("bg-brand-600");
  });

  it("marks a waiver-flavoured approve as an override, not as a plain approve", () => {
    const classes = gateActionButtonClasses("approve-override");
    expect(classes).not.toContain("bg-brand-600");
    expect(classes).toContain("ring-2"); // filled like a primary, but visibly an override
  });

  it("leaves an action it cannot read as a secondary, never promoting it", () => {
    // Conservative by design: a mis-read must not turn an unknown action into the primary one.
    expect(gateActionIntent({ id: "escalate", label: "Ask the team" })).toBe("neutral");
    expect(gateActionButtonClasses("neutral")).toBe(gateActionButtonClasses("reject"));
  });

  it("reads an ambiguous approve/revise label as the safe half", () => {
    expect(gateActionIntent({ id: "approve-or-revise", label: "Approve or request revision" })).toBe("reject");
  });

  it("renders the two decisions with different classes and keeps Summarize out of that row", () => {
    const html = renderToStaticMarkup(
      <GateCard
        pluginId="p1"
        loopName="pm"
        projectId="proj"
        gate={{ ...staleGate, artifacts: ["docs/status.md"] }}
        onResolved={() => {}}
        onOpenArtifact={() => {}}
      />,
    );
    expect(html).toContain('data-action-intent="approve-override"');
    expect(html).toContain('data-action-intent="reject"');
    // Summarize moved to the utility row beside the artifact chips (#450) — it is not a decision.
    const summarizeAt = html.indexOf('data-testid="plugin-gate-summarize"');
    const decisionAt = html.indexOf('data-testid="plugin-gate-action-approve-waive"');
    expect(summarizeAt).toBeGreaterThan(-1);
    expect(summarizeAt).toBeLessThan(decisionAt);
  });
});

describe("#449 — the card leads with what withdraws a plain approval", () => {
  const failing: PluginCheck = { name: "QA classification", verdict: "fail", detail: "the document disagrees with itself" };
  const warning: PluginCheck = { name: "Coverage", verdict: "warn", detail: "8 of 50 unexecuted" };
  const passing: PluginCheck = { name: "Inline verification", verdict: "pass", detail: "PASS" };

  it("splits checks into blocking and reassurance", () => {
    const { blocking, passing: ok } = partitionGateChecks([passing, failing, warning]);
    expect(blocking.map((c) => c.name)).toEqual(["QA classification", "Coverage"]);
    expect(ok.map((c) => c.name)).toEqual(["Inline verification"]);
    expect(partitionGateChecks(null)).toEqual({ blocking: [], passing: [] });
  });

  it("renders the blocking block ABOVE the collapsed rest", () => {
    const html = renderToStaticMarkup(
      <GateCard
        pluginId="p1"
        loopName="pm"
        projectId="proj"
        gate={staleGate}
        checks={[passing, failing]}
        gateSince={new Date(Date.now() - 3_600_000).toISOString()}
        onResolved={() => {}}
        onOpenArtifact={() => {}}
      />,
    );
    const blockingAt = html.indexOf('data-testid="plugin-gate-blocking"');
    const secondaryAt = html.indexOf('data-testid="plugin-gate-secondary"');
    expect(blockingAt).toBeGreaterThan(-1);
    expect(blockingAt).toBeLessThan(secondaryAt);
    expect(html).toContain("What stops a plain approval");
    // The gate age is secondary now, but still present and still on its own testid.
    expect(html).toContain('data-testid="plugin-gate-age"');
  });
});

describe("#451 — the butler pre-read is a full block and its consequence is never truncated", () => {
  const failing: PluginCheck = { name: "QA classification", verdict: "fail", detail: "the document disagrees with itself" };

  it("detects a recommendation that contradicts a failing check", () => {
    expect(gateRecommendationConflict(waiveAction, [failing])).toEqual({ failing: [failing] });
    // A revise recommendation agrees with a failing check — no conflict to report.
    expect(gateRecommendationConflict(reviseAction, [failing])).toBeNull();
    // Nothing failing, nothing to say.
    expect(gateRecommendationConflict(waiveAction, [{ name: "x", verdict: "pass" }])).toBeNull();
    expect(gateRecommendationConflict(null, [failing])).toBeNull();
  });

  it("never truncates the accept label and says the butler disputes the check", () => {
    const html = renderToStaticMarkup(
      <GateCard
        pluginId="p1"
        loopName="pm"
        projectId="proj"
        gate={staleGate}
        checks={[failing]}
        recommendation={{ actionId: "approve-waive", reason: "Classification flag false positive" }}
        onResolved={() => {}}
        onOpenArtifact={() => {}}
      />,
    );
    // The full consequence is in the label — `max-w-[12rem] truncate` cut it mid-word.
    expect(html).toContain(">Do it: Approve, waiving unexecuted QA (reason required)<");
    expect(html).not.toContain("max-w-[12rem]");
    expect(html).not.toContain("truncate");
    // The disagreement is stated, not left for the reader to spot across two 11px elements.
    expect(html).toContain('data-testid="plugin-gate-recommendation-conflict"');
    expect(html).toContain("QA classification");
  });

  it("says nothing about a conflict when the checks agree with the butler", () => {
    const html = renderToStaticMarkup(
      <GateCard
        pluginId="p1"
        loopName="pm"
        projectId="proj"
        gate={staleGate}
        checks={[{ name: "Inline verification", verdict: "pass" }]}
        recommendation={{ actionId: "approve-waive", reason: "looks fine" }}
        onResolved={() => {}}
        onOpenArtifact={() => {}}
      />,
    );
    expect(html).not.toContain('data-testid="plugin-gate-recommendation-conflict"');
  });
});

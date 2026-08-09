import type { PluginGate, PluginGateAction } from "./PluginLoopExtras.js";

/**
 * Pure decision logic for the approval-gate card (#378).
 *
 * Extracted from `PluginLoopExtras.tsx` because all three of these rules were previously
 * inlined into JSX and therefore only testable by driving a browser — which is exactly how
 * their failures were found. They are now plain functions with unit tests, and the card
 * renders whatever they return.
 */

/**
 * Whether the stored butler recommendation can still be acted on.
 *
 * ── The defect this exists for (#378 A, MEASURED) ──
 *
 * The recommendation is computed ONCE on a gate-id transition and persisted as a
 * `gate-recommendation` event; the card then read `recommendation.actionId` and rendered an
 * "Accept" button beside it. On habitloop's `step-7:v1` gate the two disagreed:
 *
 *   gate.actions        -> ["approve-waive", "revise"]
 *   gateRecommendation  -> { actionId: "approve", ... }
 *
 * `approve` had been WITHDRAWN by the QA gate after the recommendation was computed (17
 * acceptance criteria unexecuted). The Accept click did `gate.actions.find(...)` → `undefined`
 * → `if (action)` → nothing: no request, no toast, no console error. The human was told the
 * butler recommends approving and handed an inert button.
 *
 * `computeGateRecommendation` already refuses an unoffered action (`action-not-offered`, #333),
 * but it evaluates the CURRENT action set at recommendation time, so it cannot catch an action
 * that stops being offered afterwards. This is the same question asked at READ time, and it
 * deliberately reuses that vocabulary so the two are recognisably one rule.
 *
 * The chip is kept but demoted to informational: the recommendation is still useful context
 * ("the butler thought this was approvable"), while the one-click path to a withdrawn action
 * must not exist — making the button work would defeat the withdrawal.
 */
export type GateRecommendationView =
  | { actionable: true; action: PluginGateAction }
  | { actionable: false; skipReason: "action-not-offered" };

export function viewGateRecommendation(
  gate: Pick<PluginGate, "actions">,
  recommendation: { actionId: string; reason: string } | null | undefined,
): GateRecommendationView | null {
  if (!recommendation) return null;
  const action = gate.actions.find((a) => a.id === recommendation.actionId);
  return action ? { actionable: true, action } : { actionable: false, skipReason: "action-not-offered" };
}

/**
 * The text a text-input action would actually submit: the textarea plus any line-anchored
 * diff notes (#304), which count as feedback on their own.
 */
export function gateFeedbackText(input: string, lineNotes?: string[]): string {
  return [input.trim(), ...(lineNotes ?? [])].filter(Boolean).join("\n");
}

/**
 * Can this action be confirmed right now? (#378 B, MEASURED)
 *
 * `approve-waive` declares `input: "text"` and its label says "(reason required)". Confirming
 * with the textbox empty correctly did NOT resolve the gate — but the only feedback was a toast
 * that never appeared on the measured run, so the card's answer to "I clicked Confirm" was
 * silence. The enforcement is right; the missing signal is the defect, so the Confirm button is
 * now disabled until there is something to submit.
 */
export function canSubmitGateAction(
  action: PluginGateAction,
  input: string,
  lineNotes?: string[],
): boolean {
  if (action.input !== "text") return true;
  return gateFeedbackText(input, lineNotes).length > 0;
}

/**
 * Placeholder copy for the text box, per action kind (#378 C).
 *
 * The single revise-oriented placeholder ("what should change?") was also shown for a waiver,
 * where the question is "why are you waiving this?" — and that text is written verbatim into a
 * permanent `## QA Waiver` section of `status.md`, so the wrong prompt steers a permanent audit
 * record toward the wrong content.
 */
export function isWaiverAction(action: PluginGateAction): boolean {
  return /waiv/i.test(action.id) || /waiv/i.test(action.label);
}

export function gateInputPlaceholder(action: PluginGateAction): string {
  return isWaiverAction(action)
    ? `${action.label} — why are you waiving this? This reason is recorded permanently in the artifact's audit trail.`
    : `${action.label} — what should change? (rough notes are fine — the butler can polish them)`;
}

/** Why Confirm is disabled, shown inline so the disabled state is never a puzzle. */
export function gateInputRequirementHint(action: PluginGateAction): string {
  return isWaiverAction(action)
    ? "A written reason is required — it becomes part of the permanent record."
    : "Feedback is required before this can be submitted.";
}

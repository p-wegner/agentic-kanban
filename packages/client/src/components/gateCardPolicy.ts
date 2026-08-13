import type { PluginCheck, PluginGate, PluginGateAction } from "./PluginLoopExtras.js";

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

/**
 * What a gate action MEANS, so the card can style it by semantics (#450, MEASURED).
 *
 * The card used to style by `action.input === "text"`: an action needing text got the amber
 * outline, everything else got the brand fill. At a QA gate BOTH decisions require text
 * ("Approve, waiving unexecuted QA (reason required)" and "Needs revision"), so the two
 * OPPOSITE answers rendered identically and the gate had no primary action at all — the only
 * filled button on the whole pane was "Advance now", which at a gate plans nothing by design.
 *
 * Intent is derived from the id and the label because that is all a plugin gives us; a plugin
 * declares no semantics field. Deliberately conservative: an action we cannot read stays
 * `neutral` (outline), so a mis-read can never PROMOTE an unknown action to primary.
 */
export type GateActionIntent = "approve" | "approve-override" | "reject" | "neutral";

const APPROVE_RE = /\b(approve|approved|approving|accept|accepted|ship|sign[-\s]?off|looks good|lgtm|proceed|continue)\b/i;
const REJECT_RE = /\b(revise|revision|reject|deny|decline|block|changes? requested|needs work|redo|abort|cancel)\b/i;

function actionText(action: PluginGateAction): string {
  return `${action.id} ${action.label}`;
}

export function gateActionIntent(action: PluginGateAction): GateActionIntent {
  const text = actionText(action);
  // Reject wins over approve when both read: "approve or revise" style labels are ambiguous,
  // and the safe reading of an ambiguous action is NOT "this is the primary approve button".
  if (REJECT_RE.test(text)) return "reject";
  if (APPROVE_RE.test(text)) return isWaiverAction(action) ? "approve-override" : "approve";
  return "neutral";
}

/**
 * Tailwind classes per intent. An override (a waiver-flavoured approve) is primary — it IS the
 * forward action — but visibly marked as an override rather than sharing the plain approve's
 * look, because it resolves the gate by waiving something a check refused to pass.
 */
export function gateActionButtonClasses(intent: GateActionIntent): string {
  switch (intent) {
    case "approve":
      return "bg-brand-600 text-white hover:bg-brand-700 border border-brand-600";
    case "approve-override":
      return "bg-amber-600 text-white hover:bg-amber-700 border border-amber-700 ring-2 ring-amber-300 dark:ring-amber-800";
    default:
      return "border border-amber-400 dark:border-amber-600 text-amber-900 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-900/40";
  }
}

/** Hover text that names the consequence, so the override styling is explained, not just seen. */
export function gateActionTitle(action: PluginGateAction): string | undefined {
  const intent = gateActionIntent(action);
  if (intent === "approve-override") {
    return "Override — this approves the gate despite a check that did not pass, and the reason you type is recorded permanently.";
  }
  if (intent === "approve") return "Approve this gate and let the loop advance.";
  if (intent === "reject") return "Send the artifact back for revision with your feedback.";
  return undefined;
}

/**
 * Split checks into "what withdraws a plain approval" and the rest (#449).
 *
 * The card printed all checks at one weight in one amber block, so the two lines that actually
 * stop an approval sat in a ~500px wall of prose. Only fail/warn can withdraw an approval, so
 * they are the block the reader gets first; passing checks are reassurance and can be collapsed.
 */
export function partitionGateChecks(checks?: PluginCheck[] | null): {
  blocking: PluginCheck[];
  passing: PluginCheck[];
} {
  const all = checks ?? [];
  return {
    blocking: all.filter((c) => c.verdict === "fail" || c.verdict === "warn"),
    passing: all.filter((c) => c.verdict === "pass"),
  };
}

/**
 * Does the butler's recommendation contradict a check that FAILED? (#451, MEASURED)
 *
 * On the live gate the butler recommended approving ("Classification flag false positive: F3
 * names Sz.5 not Sz.3") while the `QA classification` check said the document disagrees with
 * itself. That disagreement is the single most decision-relevant fact on the card and it was
 * stated only in the two smallest, furthest-apart elements — the reader had to notice it.
 *
 * A conflict is not an error: the butler may well be right. It just has to be SAID.
 */
export function gateRecommendationConflict(
  recommendedAction: PluginGateAction | null | undefined,
  checks?: PluginCheck[] | null,
): { failing: PluginCheck[] } | null {
  if (!recommendedAction) return null;
  const intent = gateActionIntent(recommendedAction);
  if (intent !== "approve" && intent !== "approve-override") return null;
  const failing = (checks ?? []).filter((c) => c.verdict === "fail");
  return failing.length > 0 ? { failing } : null;
}

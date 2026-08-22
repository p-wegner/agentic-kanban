import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import type { Database } from "../../db/index.js";
import { insertPluginLoopEvent } from "../../repositories/plugin-loop-events.repository.js";
import type { BoardEvents } from "../board-events.js";
import type { GateNotifyArgs } from "../plugin-gate-butler.service.js";
import {
  beginGateRecommendationAttempt,
  endGateRecommendationAttempt,
  shouldRetryGateRecommendation,
  GATE_RECOMMENDATION_MAX_ATTEMPTS,
} from "../gate-recommendation-retry.js";

/**
 * What happens the moment an advance finds the loop BLOCKED ON A HUMAN — the notification side
 * of a gate, kept apart from the advance itself because its whole subject is "how often may this
 * fire?", and every rule here is an answer to that question:
 *
 * - The monitor re-plans a gated loop every cycle, so a gate is SEEN many times. `gate-reached`,
 *   the WS broadcast and the butler digest turn are once-per-gate-ID notifications — comparing
 *   against the PREVIOUS advance's gate is what keeps them from firing on every poll while the
 *   human hasn't acted yet.
 * - The RECOMMENDATION is the exception and is retried (#367). It used to be a one-shot on the id
 *   transition, so one transient butler failure ("Not logged in", a usage limit) cost that gate
 *   its chip permanently: MEASURED, linklocker held `step-2:v1` for 23 hours with a null
 *   recommendation across 350 further advances, and its single attempt predated the skip-trace so
 *   it left no evidence either.
 * - Nothing here is awaited by the advance. A gate must never block or fail because an LLM was
 *   slow, and the concierge is pref-gated and best-effort by construction.
 */

/** The concierge's argument shape IS the butler module's — reused rather than restated so a
 *  field added there cannot silently go unpassed here. */
export type GateConciergeArgs = GateNotifyArgs;

export interface LoopEventKey {
  pluginSlug: string;
  loopName: string;
  projectId: string;
}

/**
 * @param priorGateId the gate carried by the PREVIOUS advance — `null` when there was none.
 *   Equality with the current gate's id is what distinguishes "a new gate" from "the same gate,
 *   still open".
 */
export async function notifyGateReached(args: {
  eventKey: LoopEventKey;
  gate: GateNotifyArgs["gate"];
  priorGateId: string | null;
  conciergeArgs: GateConciergeArgs;
  pluginRowId: string | null;
  pluginName: string;
  loopLabel: string;
  boardEvents?: BoardEvents;
  database: Database;
}): Promise<void> {
  const { eventKey, gate, conciergeArgs, database } = args;
  const gateId = gate.id;

  if (gateId !== args.priorGateId) {
    await insertPluginLoopEvent(eventKey, "gate-reached", {
      gateId, question: gate.question, artifacts: gate.artifacts ?? [],
    }, database);
    args.boardEvents?.broadcastPluginGate(eventKey.projectId, {
      pluginSlug: eventKey.pluginSlug,
      pluginName: args.pluginName,
      pluginId: args.pluginRowId,
      loopName: eventKey.loopName,
      loopLabel: args.loopLabel,
      gateId,
      question: gate.question,
    });
    if (beginGateRecommendationAttempt(eventKey, gateId)) {
      void import("../plugin-gate-butler.service.js").then(async (m) => {
        // Recommendation FIRST (#317): its one-shot ask subscribes to the butler event
        // stream and resolves on the next `result` — if the digest turn were already in
        // flight, ITS result (prose, no JSON) would be misattributed to the ask and the
        // recommendation silently dropped. Reco completes, then the digest turn goes out.
        await m.computeGateRecommendation(conciergeArgs, database);
        await m.notifyButlerOfGate(conciergeArgs, database);
      }).catch((err) => {
        console.warn(`[plugins] gate concierge failed for ${eventKey.pluginSlug}:${eventKey.loopName}:`, errorMessage(err));
      }).finally(() => endGateRecommendationAttempt(eventKey, gateId));
    }
    return;
  }

  // #367 — the SAME gate, still open, on a later advance. Only the recommendation is retried:
  // NOT the gate-reached broadcast or the butler digest turn, which are genuinely
  // once-per-gate notifications and would be spam on a re-ask.
  const decision = await shouldRetryGateRecommendation(eventKey, gateId, undefined, database);
  if (decision.retry && beginGateRecommendationAttempt(eventKey, gateId)) {
    console.log(
      `[plugins] retrying the gate recommendation for ${eventKey.pluginSlug}:${eventKey.loopName} gate ${gateId} `
      + `(attempt ${decision.attemptNumber}/${GATE_RECOMMENDATION_MAX_ATTEMPTS}) — #367`,
    );
    void import("../plugin-gate-butler.service.js")
      .then((m) => m.computeGateRecommendation(conciergeArgs, database))
      .catch((err) => {
        console.warn(`[plugins] gate recommendation retry failed for ${eventKey.pluginSlug}:${eventKey.loopName}:`, errorMessage(err));
      })
      .finally(() => endGateRecommendationAttempt(eventKey, gateId));
  }
}

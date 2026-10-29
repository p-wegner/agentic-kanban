import { projectPref } from "@agentic-kanban/shared/lib/dynamic-preference-keys";
import type { PostureOverride } from "@agentic-kanban/shared/types";
import {
  MERGE_TRAIN_RED_STRATEGIES,
  MERGE_TRAIN_RED_STRATEGY_DEFAULT,
  mergeTrainRedStrategyPref,
} from "@agentic-kanban/shared/lib/merge-train-red-strategy";
import { GUARDS_AT_MERGE_VALUES, guardsAtMergeForPosture, guardsAtMergePrefKey } from "./guards-at-merge.js";
import { DEFAULT_FLUSH_GATE_SCRIPT, resolveFlushGate } from "./merge-train-flush-run.js";
import { REVIEW_MODE_DEFAULT, reviewModePref } from "./review-mode-pref.js";
import { redBasePolicyPrefKey, resolveRiskPosture, riskPosturePrefKey } from "./risk-posture.service.js";

const trainMaxSizePref = projectPref("train_max_size");
const trainMaxWaitMsPref = projectPref("train_max_wait_ms");
const verifyGateStrategyPref = projectPref("verify_gate_strategy");
const fileContentionPref = projectPref("file_contention");
const queueFlushGatePref = projectPref("queue_flush_gate");

/**
 * #1747 — every per-project pref the posture's CONSUMERS read that can contradict what the
 * level implies. `posture-overrides-coverage.test.ts` scans the resolver modules for
 * `projectPref("…")` declarations and fails on one that is neither listed here nor in its
 * exempt list, so a new override cannot be added without appearing on the chip.
 */
export const POSTURE_OVERRIDE_PREFS = [
  "train_max_size", "train_max_wait_ms", "verify_gate_strategy", "file_contention",
  "guards_at_merge", "review_mode", "queue_flush_gate", "merge_train_red_strategy", "red_base_policy",
] as const;

/**
 * Every explicit per-field pref that CONTRADICTS the project's resolved risk posture (#1560).
 *
 * Each of these is a documented escape hatch — an explicit value wins over the posture — but a
 * leftover from an earlier tuning round silently neutralises a later posture change (sprint's
 * 12-ticket/30-minute window ran as 5/2-minute behind a stale `train_max_size`). A value equal
 * to the posture's own is not a contradiction and is not reported. Pure prefMap resolver.
 *
 * `train_max_size`/`train_max_wait_ms` are only compared when the posture ASKS for batching
 * (`trainMaxSize > 1`); on `standard`/`strict` the window deliberately keeps its shipped
 * defaults, so there is no posture value to contradict.
 */
export function detectPostureOverrides(prefMap: Map<string, string>, projectId: string): PostureOverride[] {
  const posture = resolveRiskPosture(prefMap, projectId);
  const out: PostureOverride[] = [];
  const batching = posture.trainMaxSize > 1;

  const size = intPref(prefMap.get(trainMaxSizePref.key(projectId)), 1);
  if (size !== null && size !== posture.trainMaxSize) {
    out.push({ key: trainMaxSizePref.key(projectId), label: "train size", value: String(size), postureValue: String(posture.trainMaxSize) });
  }
  const wait = intPref(prefMap.get(trainMaxWaitMsPref.key(projectId)), 0);
  if (batching && wait !== null && wait !== posture.trainMaxWaitMs) {
    out.push({ key: trainMaxWaitMsPref.key(projectId), label: "train wait", value: `${wait}ms`, postureValue: `${posture.trainMaxWaitMs}ms` });
  }
  const tier = prefMap.get(verifyGateStrategyPref.key(projectId))?.trim().toLowerCase();
  if (tier && tier !== posture.gateTier) {
    out.push({ key: verifyGateStrategyPref.key(projectId), label: "gate tier", value: tier, postureValue: posture.gateTier });
  }
  const contention = prefMap.get(fileContentionPref.key(projectId))?.trim().toLowerCase();
  if (contention && contention !== posture.contentionMode) {
    out.push({ key: fileContentionPref.key(projectId), label: "file contention", value: contention, postureValue: posture.contentionMode });
  }
  pushConsumerOverrides(out, prefMap, projectId, posture);
  return out;
}

function pushConsumerOverrides(
  out: PostureOverride[],
  prefMap: Map<string, string>,
  projectId: string,
  posture: ReturnType<typeof resolveRiskPosture>,
): void {
  const guardsKey = guardsAtMergePrefKey(projectId);
  const guards = prefMap.get(guardsKey)?.trim().toLowerCase();
  const guardsPosture = guardsAtMergeForPosture(posture);
  if (guards && (GUARDS_AT_MERGE_VALUES as readonly string[]).includes(guards) && guards !== guardsPosture) {
    out.push({ key: guardsKey, label: "guards at merge", value: guards, postureValue: guardsPosture });
  }
  const reviewRaw = prefMap.get(reviewModePref.key(projectId));
  const reviewPosture = posture.reviewMode === "train-only" ? "per-train" : REVIEW_MODE_DEFAULT;
  if (reviewRaw !== undefined) {
    const review = reviewRaw === "per-train" ? "per-train" : REVIEW_MODE_DEFAULT;
    if (review !== reviewPosture) out.push({ key: reviewModePref.key(projectId), label: "review mode", value: review, postureValue: reviewPosture });
  }
  const gate = resolveFlushGate(prefMap.get(queueFlushGatePref.key(projectId)));
  if (gate.override) {
    out.push({ key: queueFlushGatePref.key(projectId), label: "flush gate", value: gate.override, postureValue: DEFAULT_FLUSH_GATE_SCRIPT });
  }
  const strategy = prefMap.get(mergeTrainRedStrategyPref.key(projectId))?.trim();
  if (strategy && (MERGE_TRAIN_RED_STRATEGIES as readonly string[]).includes(strategy) && strategy !== MERGE_TRAIN_RED_STRATEGY_DEFAULT) {
    out.push({ key: mergeTrainRedStrategyPref.key(projectId), label: "train red strategy", value: strategy, postureValue: MERGE_TRAIN_RED_STRATEGY_DEFAULT });
  }
  // The level's OWN policy, with no red_base_policy override applied, is the posture value.
  const levelPolicy = resolveRiskPosture(new Map([[riskPosturePrefKey(projectId), posture.level]]), projectId).redBasePolicy;
  if (posture.redBasePolicy !== levelPolicy) {
    out.push({ key: redBasePolicyPrefKey(projectId), label: "red base policy", value: posture.redBasePolicy, postureValue: levelPolicy });
  }
}

/** `posture sprint, overridden: train size 5, gate tier impact` — the one line every surface shows. */
export function formatPostureOverrides(level: string, overrides: PostureOverride[]): string {
  return `posture ${level}, overridden: ${overrides.map((o) => `${o.label} ${o.value}`).join(", ")}`;
}

function intPref(raw: string | undefined, min: number): number | null {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed >= min ? parsed : null;
}

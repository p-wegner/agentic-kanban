import { projectPref } from "@agentic-kanban/shared/lib/dynamic-preference-keys";
import type { PostureOverride } from "@agentic-kanban/shared/types";
import { resolveRiskPosture } from "./risk-posture.service.js";

const trainMaxSizePref = projectPref("train_max_size");
const trainMaxWaitMsPref = projectPref("train_max_wait_ms");
const verifyGateStrategyPref = projectPref("verify_gate_strategy");
const fileContentionPref = projectPref("file_contention");

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
  return out;
}

/** `posture sprint, overridden: train size 5, gate tier impact` — the one line every surface shows. */
export function formatPostureOverrides(level: string, overrides: PostureOverride[]): string {
  return `posture ${level}, overridden: ${overrides.map((o) => `${o.label} ${o.value}`).join(", ")}`;
}

function intPref(raw: string | undefined, min: number): number | null {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed >= min ? parsed : null;
}

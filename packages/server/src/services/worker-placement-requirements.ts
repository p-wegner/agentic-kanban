// What a project requires of a worker (#1382): `worker_labels_<id>` (capability labels) and
// `required_toolchains_<id>` (`pnpm, java>=21`). Split out of worker-fleet.service.ts (god-module
// ceiling); that file re-exports these so existing importers are unchanged.
import { projectPref } from "@agentic-kanban/shared/lib/dynamic-preference-keys";
import {
  parseRequiredToolchains,
  toolchainRequirementLabels,
} from "@agentic-kanban/shared/lib/worker-toolchains";
import type { Database } from "../db/index.js";
import { getPreferenceValue } from "../repositories/session-lifecycle.repository.js";

const workerLabelsPrefDef = projectPref("worker_labels");
const requiredToolchainsPrefDef = projectPref("required_toolchains");

/** CSV of labels a worker must carry to run this project's work (e.g. "docker,linux"). */
export function workerLabelsPrefKey(projectId: string): string {
  return workerLabelsPrefDef.key(projectId);
}

/** `required_toolchains_<projectId>`: CSV of `pnpm, java>=21` a worker must have detected. */
export function requiredToolchainsPrefKey(projectId: string): string {
  return requiredToolchainsPrefDef.key(projectId);
}

export function parseRequiredLabels(pref: string | undefined): string[] {
  return (pref ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * The project's placement requirements: its `worker_labels` plus its `required_toolchains` as
 * `toolchain:`-prefixed pseudo-labels, so every selector that already takes a label list filters on
 * toolchains too, and no call site can read one half and forget the other.
 */
export async function readPlacementRequirements(projectId: string, database: Database): Promise<string[]> {
  const labels = parseRequiredLabels(await getPreferenceValue(workerLabelsPrefKey(projectId), database));
  const toolchains = parseRequiredToolchains(await getPreferenceValue(requiredToolchainsPrefKey(projectId), database));
  return [...labels, ...toolchainRequirementLabels(toolchains)];
}

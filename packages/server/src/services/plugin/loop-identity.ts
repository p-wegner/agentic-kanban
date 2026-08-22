import { pluginLoopUnitKey, type PluginLoopDef, type PluginManifest } from "@agentic-kanban/shared/lib/plugin-manifest";
import type { PluginLoopEventRow } from "../../repositories/plugin-loop-events.repository.js";
import type { AdvanceEventPayload } from "../plugin-loop-types.js";

/**
 * How a loop is NAMED, FOUND, and how its last advance is read back.
 *
 * Every loop entry point starts here — resolve the loop out of the manifest, derive the
 * `external_key` prefix its tickets share, read the payload of the most recent advance — and
 * every one of them can fail in the same two ways, which is why the error lives here too.
 */

export class PluginLoopError extends Error {
  constructor(message: string, public readonly code: "NOT_FOUND" | "BAD_REQUEST" = "BAD_REQUEST") {
    super(message);
    this.name = "PluginLoopError";
  }
}

export function findLoop(manifest: PluginManifest, loopName: string): PluginLoopDef {
  const loop = (manifest.loops ?? []).find((l) => l.name === loopName);
  if (!loop) throw new PluginLoopError(`Loop "${loopName}" not found in plugin manifest`, "NOT_FOUND");
  return loop;
}

/**
 * The `external_key` prefix every ticket of one loop shares — the handle behind
 * "which tickets belong to this loop".
 *
 * `pluginLoopUnitKey` with an empty unit id IS the prefix — derived rather than
 * re-spelled so the two can never drift apart.
 */
export function keyPrefix(pluginSlug: string, loopName: string): string {
  return pluginLoopUnitKey(pluginSlug, loopName, "");
}

/**
 * The latest advance's payload IS the loop's current display state (gate/progress/checks/note),
 * so this is read on every status query as well as on every advance. A malformed row degrades to
 * "no state" rather than failing the read — a loop must stay observable after a bad write.
 */
export function parseAdvancePayload(row: PluginLoopEventRow | null): AdvanceEventPayload | null {
  if (!row?.payloadJson) return null;
  try {
    return JSON.parse(row.payloadJson) as AdvanceEventPayload;
  } catch {
    return null;
  }
}

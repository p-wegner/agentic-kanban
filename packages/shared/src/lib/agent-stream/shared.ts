import type { AgentDisplayEvent, ParseContext, ParsedStreamEvent } from "./types.js";

export function createAgentStreamParseContext(): ParseContext {
  return { toolNames: new Map<string, string>() };
}

import { objectValue } from "../json-narrow.js";

// The JSON-narrowing helpers moved to ../json-narrow.ts (#534) so non-parser code
// can import them without reaching into the agent-stream module. Re-exported here so
// every existing importer of this file is unaffected.
export {
  objectValue,
  optionalObject,
  stringValue,
  numberValue,
  stringifyValue,
  contentToText,
  getString,
  getStringArray,
  asRecord,
  isRecord,
  optionalString,
  optionalNumber,
} from "../json-narrow.js";

export function pushDisplay(result: ParsedStreamEvent, event: AgentDisplayEvent): void {
  (result.displayEvents ??= []).push(event);
}

export function hasFields(result: ParsedStreamEvent): boolean {
  return hasProviderFields(result) ||
    (result.displayEvents?.length ?? 0) > 0;
}

export function hasProviderFields(result: ParsedStreamEvent): boolean {
  return result.providerSessionId !== undefined ||
    result.exitPlanModeDenied !== undefined ||
    result.stats !== undefined ||
    result.turnComplete !== undefined ||
    result.liveStats !== undefined ||
    result.toolActivity !== undefined ||
    result.toolResult !== undefined ||
    result.assistantText !== undefined ||
    result.todos !== undefined ||
    result.rateLimitInfo !== undefined;
}

export function parseInput(value: unknown): Record<string, unknown> {
  const record = objectValue(value);
  if (Object.keys(record).length > 0) return record;
  if (typeof value === "string") {
    try {
      return objectValue(JSON.parse(value) as unknown);
    } catch {
      return {};
    }
  }
  return {};
}

export function registerToolName(context: ParseContext, id: string | undefined, name: string): void {
  if (!id) return;
  (context.toolNames ??= new Map<string, string>()).set(id, name);
}

export function toolNameFor(context: ParseContext, id: string | undefined, fallback: string): string {
  return id ? context.toolNames?.get(id) ?? fallback : fallback;
}

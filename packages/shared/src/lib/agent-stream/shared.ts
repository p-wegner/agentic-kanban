import type { AgentDisplayEvent, ParseContext, ParsedStreamEvent } from "./types.js";

export function createAgentStreamParseContext(): ParseContext {
  return { toolNames: new Map<string, string>() };
}

export function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function optionalObject(value: unknown): Record<string, unknown> | undefined {
  const record = objectValue(value);
  return Object.keys(record).length > 0 ? record : undefined;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

export function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function stringifyValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  return JSON.stringify(value) ?? "";
}

export function contentToText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((block) => {
      if (typeof block === "string") return block;
      const record = objectValue(block);
      return stringValue(record.text) ?? stringValue(record.content) ?? stringValue(record.message) ?? "";
    })
    .filter(Boolean)
    .join("\n");
}

export function getString(obj: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

export function getStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

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

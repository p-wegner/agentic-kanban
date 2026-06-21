/**
 * Pure parsing/formatting helpers for the board-health-events endpoint.
 *
 * Extracted out of the projects route so the query-string parsing (limit clamp,
 * comma-list whitelisting) and the details-summarization are unit-testable without
 * a server, and the route stays a thin adapter.
 */
import type {
  BoardHealthEventType,
  BoardHealthEventCategory,
} from "../repositories/board-health-events.repository.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MIN_LIMIT = 1;

const VALID_EVENT_TYPES: Set<string> = new Set([
  "cycle_start",
  "cycle_end",
  "observation",
  "action",
  "error",
]);
const VALID_CATEGORIES: Set<string> = new Set([
  "merge",
  "launch",
  "server",
  "refill",
  "smoke_check",
]);

/** Parse the `limit` query param, clamped to [1, 50]; defaults to 20 on missing/invalid. */
export function parseBoardHealthEventsLimit(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, parsed));
}

/** Parse a comma-separated `eventType` filter, keeping only valid types; undefined if none. */
export function parseBoardHealthEventTypes(raw: string | undefined): BoardHealthEventType[] | undefined {
  if (!raw) return undefined;
  const types = raw.split(",").map((t) => t.trim()).filter((t) => VALID_EVENT_TYPES.has(t));
  return types.length > 0 ? (types as BoardHealthEventType[]) : undefined;
}

/** Parse a comma-separated `category` filter, keeping only valid categories; undefined if none. */
export function parseBoardHealthCategories(raw: string | undefined): BoardHealthEventCategory[] | undefined {
  if (!raw) return undefined;
  const cats = raw.split(",").map((t) => t.trim()).filter((t) => VALID_CATEGORIES.has(t));
  return cats.length > 0 ? (cats as BoardHealthEventCategory[]) : undefined;
}

/**
 * Row shape (subset) emitted by the board-health-events repository that the wire
 * DTOs are projected from. `cycleId` is only present on the single-event read.
 */
export interface BoardHealthEventRecord {
  id: string;
  cycleId?: string | null;
  createdAt: string;
  eventType: string;
  category: string | null;
  issueNumber: number | null;
  summary: string;
  details: string | null;
}

/** UI severity for an event row: errors render distinctly, everything else is info. */
export function boardHealthEventLevel(eventType: string): "error" | "info" {
  return eventType === "error" ? "error" : "info";
}

/**
 * Parse a single event's `details` blob for the full (non-compacted) view: the
 * parsed JSON value, the raw string when it is not valid JSON, or null when absent.
 */
export function parseBoardHealthEventDetails(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Project a row into the list DTO (compacted one-line `details`). */
export function toBoardHealthEventSummary(event: BoardHealthEventRecord) {
  return {
    id: event.id,
    timestamp: event.createdAt,
    level: boardHealthEventLevel(event.eventType),
    type: event.eventType,
    category: event.category ?? null,
    issueNumber: event.issueNumber ?? null,
    summary: event.summary,
    details: compactBoardHealthEventDetails(event.details),
  };
}

/** Project a row into the single-event DTO (full parsed `details` + cycleId). */
export function toBoardHealthEventDetail(event: BoardHealthEventRecord) {
  return {
    id: event.id,
    cycleId: event.cycleId ?? null,
    timestamp: event.createdAt,
    level: boardHealthEventLevel(event.eventType),
    type: event.eventType,
    category: event.category ?? null,
    issueNumber: event.issueNumber ?? null,
    summary: event.summary,
    details: parseBoardHealthEventDetails(event.details),
  };
}

/**
 * Summarize a JSON `details` blob into a short human-readable line for the events
 * list: scalars verbatim, arrays as "N items", objects as the first 4 non-null
 * fields ("key: value" / "key: N items" / "key: N fields"). Falls back to a 160-char
 * slice of the raw string when it is not valid JSON.
 */
export function compactBoardHealthEventDetails(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const details = JSON.parse(raw) as unknown;
    if (details === null || details === undefined) return null;
    if (typeof details !== "object") return String(details);
    if (Array.isArray(details)) return `${details.length} item${details.length === 1 ? "" : "s"}`;

    const entries = Object.entries(details as Record<string, unknown>)
      .filter(([, value]) => value !== null && value !== undefined)
      .slice(0, 4);
    if (entries.length === 0) return null;

    return entries
      .map(([key, value]) => {
        if (Array.isArray(value)) return `${key}: ${value.length} item${value.length === 1 ? "" : "s"}`;
        if (typeof value === "object") return `${key}: ${Object.keys(value as Record<string, unknown>).length} fields`;
        return `${key}: ${String(value)}`;
      })
      .join(", ");
  } catch {
    return raw.slice(0, 160);
  }
}

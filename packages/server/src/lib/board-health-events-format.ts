/**
 * Pure parsing/formatting helpers for the board-health-events endpoint.
 *
 * Extracted out of the projects route so the query-string parsing (limit clamp,
 * comma-list whitelisting) and the details-summarization are unit-testable without
 * a server, and the route stays a thin adapter.
 */
import {
  isBoardHealthEventType,
  isBoardHealthEventCategory,
  type BoardHealthEventType,
  type BoardHealthEventCategory,
  type BoardHealthEventLevel,
  type BoardHealthEventDto,
  type BoardHealthEventDetailDto,
} from "@agentic-kanban/shared/lib/board-health-events";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MIN_LIMIT = 1;

/**
 * The `eventType`/`category` columns are plain text, so a row can in principle carry a
 * value outside the vocabulary (an older writer, a hand-edited row). The projections
 * narrow with the shared guards rather than casting: an unrecognised type becomes
 * "observation" and an unrecognised category becomes null, which is what the client
 * filters already do with them — the old code cast and let the bad value through typed.
 */
function narrowEventType(raw: string): BoardHealthEventType {
  return isBoardHealthEventType(raw) ? raw : "observation";
}
function narrowCategory(raw: string | null): BoardHealthEventCategory | null {
  return isBoardHealthEventCategory(raw) ? raw : null;
}

/** Parse the `limit` query param, clamped to [1, 50]; defaults to 20 on missing/invalid. */
export function parseBoardHealthEventsLimit(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, parsed));
}

/** Parse a comma-separated `eventType` filter, keeping only valid types; undefined if none. */
export function parseBoardHealthEventTypes(raw: string | undefined): BoardHealthEventType[] | undefined {
  if (!raw) return undefined;
  const types = raw.split(",").map((t) => t.trim()).filter(isBoardHealthEventType);
  return types.length > 0 ? types : undefined;
}

/** Parse a comma-separated `category` filter, keeping only valid categories; undefined if none. */
export function parseBoardHealthCategories(raw: string | undefined): BoardHealthEventCategory[] | undefined {
  if (!raw) return undefined;
  const cats = raw.split(",").map((t) => t.trim()).filter(isBoardHealthEventCategory);
  return cats.length > 0 ? cats : undefined;
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
export function boardHealthEventLevel(eventType: string): BoardHealthEventLevel {
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
export function toBoardHealthEventSummary(event: BoardHealthEventRecord): BoardHealthEventDto {
  return {
    id: event.id,
    timestamp: event.createdAt,
    level: boardHealthEventLevel(event.eventType),
    type: narrowEventType(event.eventType),
    category: narrowCategory(event.category),
    issueNumber: event.issueNumber ?? null,
    summary: event.summary,
    details: compactBoardHealthEventDetails(event.details),
  };
}

/** Project a row into the single-event DTO (full parsed `details` + cycleId). */
export function toBoardHealthEventDetail(event: BoardHealthEventRecord): BoardHealthEventDetailDto {
  return {
    id: event.id,
    cycleId: event.cycleId ?? null,
    timestamp: event.createdAt,
    level: boardHealthEventLevel(event.eventType),
    type: narrowEventType(event.eventType),
    category: narrowCategory(event.category),
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
    if (typeof details !== "object") return String(details as string | number | boolean);
    if (Array.isArray(details)) return `${details.length} item${details.length === 1 ? "" : "s"}`;

    const entries = Object.entries(details as Record<string, unknown>)
      .filter(([, value]) => value !== null && value !== undefined)
      .slice(0, 4);
    if (entries.length === 0) return null;

    return entries
      .map(([key, value]) => {
        if (Array.isArray(value)) return `${key}: ${value.length} item${value.length === 1 ? "" : "s"}`;
        if (typeof value === "object") return `${key}: ${Object.keys(value as Record<string, unknown>).length} fields`;
        return `${key}: ${String(value as string | number | boolean)}`;
      })
      .join(", ");
  } catch {
    return raw.slice(0, 160);
  }
}

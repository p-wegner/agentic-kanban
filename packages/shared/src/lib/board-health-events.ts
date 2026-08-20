/**
 * The board-health-event vocabulary and wire DTOs, declared once (#568).
 *
 * The five event types and five categories were written out four times: as unions in
 * `board-health-events.repository.ts`, again as `Set<string>` whitelists in
 * `board-health-events-format.ts` (which then had to cast the filtered strings back
 * to the union), and a third time in a schema comment. The DTO was re-declared three
 * times in the client, and one of those copies had already lost the category union to
 * a bare `string`.
 *
 * Runtime arrays, not just types: the route needs a membership test, so a
 * types-only declaration would have left the whitelists hand-maintained — which is
 * exactly how they drifted.
 */

export const BOARD_HEALTH_EVENT_TYPES = ["cycle_start", "cycle_end", "observation", "action", "error"] as const;
export type BoardHealthEventType = (typeof BOARD_HEALTH_EVENT_TYPES)[number];

/** Business-level grouping shown in the notification center filter bar. */
export const BOARD_HEALTH_EVENT_CATEGORIES = ["merge", "launch", "server", "refill", "smoke_check"] as const;
export type BoardHealthEventCategory = (typeof BOARD_HEALTH_EVENT_CATEGORIES)[number];

export function isBoardHealthEventType(value: unknown): value is BoardHealthEventType {
  return typeof value === "string" && (BOARD_HEALTH_EVENT_TYPES as readonly string[]).includes(value);
}

export function isBoardHealthEventCategory(value: unknown): value is BoardHealthEventCategory {
  return typeof value === "string" && (BOARD_HEALTH_EVENT_CATEGORIES as readonly string[]).includes(value);
}

/** UI severity for an event row: errors render distinctly, everything else is info. */
export type BoardHealthEventLevel = "info" | "error";

/** `GET /api/projects/:id/board-health-events` list row. `details` is compacted to one line. */
export interface BoardHealthEventDto {
  id: string;
  timestamp: string;
  level: BoardHealthEventLevel;
  type: BoardHealthEventType;
  category: BoardHealthEventCategory | null;
  issueNumber: number | null;
  summary: string;
  details: string | null;
}

/** Single-event read: carries the owning cycle and the fully parsed `details` blob. */
export interface BoardHealthEventDetailDto extends Omit<BoardHealthEventDto, "details"> {
  cycleId: string | null;
  details: unknown;
}

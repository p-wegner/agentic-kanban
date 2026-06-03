export const WIP_LIMIT_PREFIX = "wip_limit_";

export function wipLimitKey(statusId: string): string {
  return `${WIP_LIMIT_PREFIX}${statusId}`;
}

export function getWipLimit(settings: Record<string, string>, statusId: string): number | null {
  const raw = settings[wipLimitKey(statusId)];
  if (!raw) return null;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export type WipStatus = "under" | "at" | "over";

export function evaluateWipLimit(count: number, limit: number | null): WipStatus {
  if (limit === null) return "under";
  if (count > limit) return "over";
  if (count === limit) return "at";
  return "under";
}

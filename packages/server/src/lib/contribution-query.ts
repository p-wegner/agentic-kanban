import type { ContributionGroupBy } from "@agentic-kanban/shared";

const GROUP_BYS: readonly ContributionGroupBy[] = ["provider", "profile", "model", "author"];

export type ContributionQuery =
  | { ok: true; groupBy: ContributionGroupBy; window: { from?: string; to?: string } }
  | { ok: false; error: string };

function parseIsoBound(raw: string | undefined, name: string): { value?: string; error?: string } {
  if (!raw) return {};
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return { error: `Invalid ${name}: expected an ISO-8601 timestamp` };
  return { value: new Date(ms).toISOString() };
}

/** Validate `?from=&to=&groupBy=` of the contributions endpoint (default groupBy: provider). */
export function parseContributionQuery(query: Record<string, string | undefined>): ContributionQuery {
  const groupBy = (query.groupBy ?? "provider") as ContributionGroupBy;
  if (!GROUP_BYS.includes(groupBy)) {
    return { ok: false, error: `Invalid groupBy: expected one of ${GROUP_BYS.join(", ")}` };
  }
  const from = parseIsoBound(query.from, "from");
  const to = parseIsoBound(query.to, "to");
  if (from.error || to.error) return { ok: false, error: (from.error ?? to.error) as string };
  if (from.value && to.value && from.value > to.value) {
    return { ok: false, error: "Invalid range: from is after to" };
  }
  return { ok: true, groupBy, window: { from: from.value, to: to.value } };
}

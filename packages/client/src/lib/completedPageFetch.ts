import type { IssueWithStatus } from "@agentic-kanban/shared";
import { apiFetch } from "./api.js";

// #1541: one page of the paged `/board/completed` endpoint.
const PAGE_SIZE = 50;
/** Without a query the first server pages mostly repeat the board's own capped cards; bound the skip. */
const MAX_PAGES_PER_LOAD = 40;
interface CompletedPage {
  issues: IssueWithStatus[];
  total: number;
  offset: number;
}

export interface LoadedPage {
  issues: IssueWithStatus[];
  total: number;
  nextOffset: number;
}

/** One `useInfiniteQuery` page: keep fetching until something not already on the board turns up. */
export async function fetchUntilFresh(
  projectId: string,
  query: string,
  startOffset: number,
  boardIds: ReadonlySet<string>,
): Promise<LoadedPage> {
  let offset = startOffset;
  const issues: IssueWithStatus[] = [];
  let total = 0;
  for (let page = 0; page < MAX_PAGES_PER_LOAD; page++) {
    const res = await apiFetch<CompletedPage>(
      `/api/projects/${projectId}/board/completed?offset=${offset}&limit=${PAGE_SIZE}${query ? `&q=${encodeURIComponent(query)}` : ""}`,
    );
    offset += res.issues.length;
    total = res.total;
    issues.push(...res.issues);
    if (res.issues.length === 0 || offset >= total) break;
    // Search matches are all "new" to the user; for the plain listing keep paging until
    // something the board does not already show turns up.
    if (res.issues.some((i) => !boardIds.has(i.id))) break;
  }
  return { issues, total, nextOffset: offset };
}


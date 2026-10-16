import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";
import { fetchUntilFresh } from "../lib/completedPageFetch.js";
import { useCompletedPagingStore } from "../stores/completedPagingStore.js";

/**
 * #1541: Done/Cancelled reachable beyond the board payload's per-column cap.
 *
 * The board API returns only the newest N of each terminal column, so older tickets could be
 * neither paged to nor found by search (search filtered the loaded cards only). This hook asks
 * the paged `/board/completed` endpoint for the rest:
 * - **search**: a (debounced) non-empty query fetches the first page of matches server-side;
 * - **load more**: pages onward, newest first, deduplicated against what the board already holds.
 */

const DEBOUNCE_MS = 220;
const ARCHIVE_NAMES = new Set(["Done", "Cancelled"]);

/**
 * Board columns with the extra Done/Cancelled pages merged into their columns, and the paging
 * state published to `completedPagingStore` for the Completed grid.
 */
export function useCompletedColumns(
  projectId: string | null,
  searchQuery: string,
  columns: StatusWithIssues[],
): StatusWithIssues[] {
  const rawQuery = searchQuery.trim();
  const [query, setQuery] = useState(rawQuery);
  useEffect(() => {
    if (!rawQuery) { setQuery(""); return; }
    const timer = setTimeout(() => setQuery(rawQuery), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [rawQuery]);
  const [plainFor, setPlainFor] = useState<string | null>(null);

  const boardIds = useMemo(
    () => new Set(columns.flatMap((col) => col.issues.map((issue) => issue.id))),
    [columns],
  );
  const boardIdsRef = useRef(boardIds);
  boardIdsRef.current = boardIds;
  const totals = useMemo(() => {
    const archive = columns.filter((col) => ARCHIVE_NAMES.has(col.name));
    return {
      total: archive.reduce((sum, col) => sum + col.count, 0),
      loaded: archive.reduce((sum, col) => sum + col.issues.length, 0),
    };
  }, [columns]);

  const enabled = !!projectId && (query !== "" || plainFor === projectId);
  const q = useInfiniteQuery({
    queryKey: ["projects", projectId, "board-completed", query],
    enabled,
    initialPageParam: 0,
    queryFn: ({ pageParam }) => fetchUntilFresh(projectId as string, query, pageParam, boardIdsRef.current),
    getNextPageParam: (last) => (last.nextOffset < last.total && last.issues.length > 0 ? last.nextOffset : undefined),
    staleTime: 30_000,
  });

  const extras = useMemo(() => {
    const seen = new Set<string>();
    const out: IssueWithStatus[] = [];
    for (const page of enabled ? (q.data?.pages ?? []) : []) {
      for (const issue of page.issues) {
        if (boardIds.has(issue.id) || seen.has(issue.id)) continue;
        seen.add(issue.id);
        out.push(issue);
      }
    }
    return out;
  }, [enabled, q.data, boardIds]);

  const fetchNext = q.fetchNextPage;
  const loadMore = useCallback(() => {
    if (!projectId) return;
    if (!enabled) setPlainFor(projectId);
    else void fetchNext();
  }, [projectId, enabled, fetchNext]);

  // Plain listing: more remain while the board+extras hold fewer than the total. Search: more
  // remain once the first page has arrived and the server has matches past what is loaded.
  const hasMore = query
    ? !!q.data && q.hasNextPage
    : !!projectId && (q.data ? q.hasNextPage : true) && totals.loaded + extras.length < totals.total;
  const loading = q.isFetching;
  const setPaging = useCompletedPagingStore((s) => s.set);
  useEffect(() => {
    setPaging({ hasMore, loading, loadMore });
  }, [hasMore, loading, loadMore, setPaging]);

  return useMemo(
    () => extras.length === 0
      ? columns
      : columns.map((col) => (ARCHIVE_NAMES.has(col.name)
        ? { ...col, issues: [...col.issues, ...extras.filter((issue) => issue.statusId === col.id)] }
        : col)),
    [columns, extras],
  );
}

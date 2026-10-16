import { useCallback, useEffect, useRef, useState } from "react";
import type { IssueWithStatus } from "@agentic-kanban/shared";
import { apiFetch } from "../lib/api.js";

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
const PAGE_SIZE = 50;
/** Without a query the first server pages mostly repeat the board's own capped cards; bound the skip. */
const MAX_PAGES_PER_LOAD = 40;

interface CompletedPage {
  issues: IssueWithStatus[];
  total: number;
  offset: number;
}

export interface CompletedExtras {
  /** Issues fetched beyond the board payload (already deduplicated, newest first). */
  extras: IssueWithStatus[];
  /** True while a page is in flight. */
  loading: boolean;
  /** True when the server holds more matching Done/Cancelled issues than are loaded. */
  hasMore: boolean;
  loadMore: () => void;
}

export function useCompletedExtras(
  projectId: string | null,
  searchQuery: string,
  /** Ids the board payload already holds (any column) — pages never re-add these. */
  boardIssueIds: ReadonlySet<string>,
  /** Done + Cancelled total from the board payload; the page total replaces it once fetched. */
  boardTotal: number,
  /** Done/Cancelled issues the board payload holds. */
  boardLoaded: number,
): CompletedExtras {
  const query = searchQuery.trim();
  const [extras, setExtras] = useState<IssueWithStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const [serverTotal, setServerTotal] = useState<number | null>(null);
  const [exhausted, setExhausted] = useState(false);
  const nextOffset = useRef(0);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const boardIdsRef = useRef(boardIssueIds);
  boardIdsRef.current = boardIssueIds;
  const seen = useRef(new Set<string>());

  const fetchMore = useCallback(async (gen: number, pid: string, q: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    try {
      for (let page = 0; page < MAX_PAGES_PER_LOAD; page++) {
        const res = await apiFetch<CompletedPage>(
          `/api/projects/${pid}/board/completed?offset=${nextOffset.current}&limit=${PAGE_SIZE}${q ? `&q=${encodeURIComponent(q)}` : ""}`,
        );
        if (generation.current !== gen) return;
        nextOffset.current += res.issues.length;
        setServerTotal(res.total);
        const fresh = res.issues.filter((i) => !boardIdsRef.current.has(i.id) && !seen.current.has(i.id));
        fresh.forEach((i) => seen.current.add(i.id));
        const done = res.issues.length === 0 || nextOffset.current >= res.total;
        if (fresh.length > 0) setExtras((prev) => [...prev, ...fresh]);
        if (done) {
          setExhausted(true);
          return;
        }
        // Search matches are all "new" to the user; for the plain listing keep paging until
        // something the board does not already show turns up.
        if (fresh.length > 0) return;
      }
    } catch {
      // Leave what is loaded in place; the Load more button stays so the user can retry.
    } finally {
      if (generation.current === gen) setLoading(false);
      inFlight.current = false;
    }
  }, []);

  // A new project or query starts a fresh result set; a non-empty query loads its first page.
  useEffect(() => {
    const gen = ++generation.current;
    inFlight.current = false;
    nextOffset.current = 0;
    seen.current = new Set();
    setExtras([]);
    setServerTotal(null);
    setExhausted(false);
    setLoading(false);
    if (!projectId || !query) return;
    const timer = setTimeout(() => { void fetchMore(gen, projectId, query); }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [projectId, query, fetchMore]);

  const loadMore = useCallback(() => {
    if (!projectId) return;
    void fetchMore(generation.current, projectId, query);
  }, [projectId, query, fetchMore]);

  // Plain listing: more remain while the board+extras hold fewer than the total. Search: more
  // remain once the first page has arrived and the server has matches past the offset.
  const hasMore = !exhausted && (query
    ? serverTotal !== null && nextOffset.current < serverTotal
    : boardLoaded + extras.length < boardTotal);

  return { extras, loading, hasMore, loadMore };
}

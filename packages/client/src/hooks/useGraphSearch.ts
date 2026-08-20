import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../lib/api.js";

/**
 * Server-side graph search (#370).
 *
 * The graph payload stopped shipping `description` (309,477 -> ~62,000 gzipped bytes) and search
 * silently became title-only — the semantics-for-bytes trade #345 refused twice. Sending the
 * descriptions back to the client as a search index measured 364,380 gzipped bytes, i.e. worse
 * than the payload the diet removed, so the match happens on the server and only issue IDs return.
 *
 * Two properties make that safe to type into:
 * - **Debounced**, so a keystroke does not become a request.
 * - **Fallback, never a gap**: until a result arrives, the caller filters on titles — today's
 *   behaviour. A slow or failed search therefore shows fewer matches, never an empty graph.
 */

/** Long enough that ordinary typing produces one request, short enough to feel immediate. */
const DEBOUNCE_MS = 220;

export function useGraphSearch(projectId: string | null, query: string): {
  /** Matching issue ids, or null while unresolved (caller falls back to titles). */
  matches: Set<string> | null;
  searching: boolean;
} {
  const [matches, setMatches] = useState<Set<string> | null>(null);
  const [searching, setSearching] = useState(false);
  // Guards against an out-of-order response overwriting a newer query's result.
  const latest = useRef(0);

  useEffect(() => {
    const trimmed = query.trim();
    if (!projectId || !trimmed) {
      setMatches(null);
      setSearching(false);
      return;
    }
    const token = ++latest.current;
    setSearching(true);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const res = await apiFetch<{ issueIds: string[] }>(
            `/api/projects/${projectId}/graph/search?q=${encodeURIComponent(trimmed)}`,
          );
          if (latest.current === token) setMatches(new Set(res.issueIds));
        } catch {
          // Leave the previous answer in place; the caller's title fallback covers the gap.
          if (latest.current === token) setMatches(null);
        } finally {
          if (latest.current === token) setSearching(false);
        }
      })();
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [projectId, query]);

  return { matches, searching };
}

/**
 * Does this issue match the query?
 *
 * With server matches, the answer is exact — title OR description, decided where the text lives.
 * Without them (still debouncing, or the request failed) it falls back to the title, so search
 * never returns FEWER results than the title-only behaviour it replaces; it only adds the
 * description matches back.
 */
export function graphNodeMatches(
  query: string,
  issueId: string,
  title: string,
  matches: Set<string> | null,
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  if (matches) return matches.has(issueId);
  return title.toLowerCase().includes(needle);
}

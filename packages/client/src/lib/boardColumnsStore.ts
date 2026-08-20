import type { QueryClient } from "@tanstack/react-query";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { StatusWithIssues } from "@agentic-kanban/shared";
import { boardQueryKeys } from "./boardQueryKeys.js";

const EMPTY: StatusWithIssues[] = [];

export interface BoardColumnsStore {
  /** Live read of the active project's columns straight from the query cache. */
  readColumns: () => StatusWithIssues[];
  /** `SetStateAction`-compatible writer — routes to `queryClient.setQueryData`. */
  setColumns: Dispatch<SetStateAction<StatusWithIssues[]>>;
  /** `MutableRefObject` facade: `.current` reads/writes the same query-cache slot. */
  columnsRef: MutableRefObject<StatusWithIssues[]>;
}

/**
 * react-query is the SINGLE owner of the board's columns (finding §3.5). This
 * adapter preserves the legacy `setColumns` / `columnsRef` surface every board
 * handler was written against — a `SetStateAction` dispatcher and a
 * `MutableRefObject` — but backs both by the `board(projectId)` query cache.
 *
 * Because reads and writes hit one slot, the old triple-write (useState mirror +
 * ref mirror + `setQueryData`) collapses to one copy, so there is no inter-mirror
 * drift left for a reconcile effect to patch. Writes are synchronous
 * (`setQueryData`), so the read-after-write pattern (`setColumns(x); …
 * columnsRef.current`) that the optimistic handlers rely on still observes `x`.
 */
export function createBoardColumnsStore(
  queryClient: QueryClient,
  getProjectId: () => string | null,
): BoardColumnsStore {
  const readColumns = (): StatusWithIssues[] => {
    const pid = getProjectId();
    if (!pid) return EMPTY;
    return queryClient.getQueryData<StatusWithIssues[]>(boardQueryKeys.board(pid)) ?? EMPTY;
  };

  const setColumns: Dispatch<SetStateAction<StatusWithIssues[]>> = (update) => {
    const pid = getProjectId();
    if (!pid) return;
    queryClient.setQueryData<StatusWithIssues[]>(boardQueryKeys.board(pid), (prev) => {
      const base = prev ?? EMPTY;
      return typeof update === "function"
        ? (update as (p: StatusWithIssues[]) => StatusWithIssues[])(base)
        : update;
    });
  };

  const columnsRef: MutableRefObject<StatusWithIssues[]> = {
    get current() {
      return readColumns();
    },
    set current(next: StatusWithIssues[]) {
      setColumns(next);
    },
  };

  return { readColumns, setColumns, columnsRef };
}

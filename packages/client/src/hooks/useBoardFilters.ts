import { useCallback, useEffect, useState } from "react";

/**
 * Board filter state (issue-type, priority, tag-set) with per-project
 * localStorage persistence, extracted from BoardPage. Loads the stored filters
 * when the active project changes and persists each change. setActiveTagIds is
 * exposed for the saved-view apply path. The page destructures these with the
 * same names so its render is unchanged.
 */
export function useBoardFilters(activeProjectId: string | null) {
  const [activeTagIds, setActiveTagIds] = useState<Set<string>>(new Set());
  const [issueTypeFilter, setIssueTypeFilter] = useState<string | null>(null);
  const [priorityFilter, setPriorityFilter] = useState<string | null>(null);

  useEffect(() => {
    if (!activeProjectId) return;
    try {
      const stored = localStorage.getItem(`board-type-filter-${activeProjectId}`);
      setIssueTypeFilter(stored || null);
    } catch {
      // ignore
    }
  }, [activeProjectId]);

  const handleIssueTypeFilterChange = useCallback((type: string | null) => {
    setIssueTypeFilter(type);
    if (activeProjectId) {
      try {
        if (type) {
          localStorage.setItem(`board-type-filter-${activeProjectId}`, type);
        } else {
          localStorage.removeItem(`board-type-filter-${activeProjectId}`);
        }
      } catch {
        // ignore
      }
    }
  }, [activeProjectId]);

  useEffect(() => {
    if (!activeProjectId) return;
    try {
      const stored = localStorage.getItem(`board-priority-filter-${activeProjectId}`);
      setPriorityFilter(stored || null);
    } catch {
      // ignore
    }
  }, [activeProjectId]);

  const handlePriorityFilterChange = useCallback((priority: string | null) => {
    setPriorityFilter(priority);
    if (activeProjectId) {
      try {
        if (priority) {
          localStorage.setItem(`board-priority-filter-${activeProjectId}`, priority);
        } else {
          localStorage.removeItem(`board-priority-filter-${activeProjectId}`);
        }
      } catch {
        // ignore
      }
    }
  }, [activeProjectId]);

  useEffect(() => {
    if (!activeProjectId) return;
    try {
      const stored = localStorage.getItem(`board-tag-filter-${activeProjectId}`);
      setActiveTagIds(stored ? new Set(stored.split(",").filter(Boolean)) : new Set());
    } catch {
      // ignore
    }
  }, [activeProjectId]);

  const handleTagFilterToggle = useCallback((tagId: string) => {
    setActiveTagIds((prev) => {
      const next = new Set(prev);
      if (next.has(tagId)) {
        next.delete(tagId);
      } else {
        next.add(tagId);
      }
      if (activeProjectId) {
        try {
          if (next.size > 0) {
            localStorage.setItem(`board-tag-filter-${activeProjectId}`, [...next].join(","));
          } else {
            localStorage.removeItem(`board-tag-filter-${activeProjectId}`);
          }
        } catch {
          // ignore
        }
      }
      return next;
    });
  }, [activeProjectId]);

  const handleClearTagFilter = useCallback(() => {
    setActiveTagIds(new Set());
    if (activeProjectId) {
      try {
        localStorage.removeItem(`board-tag-filter-${activeProjectId}`);
      } catch {
        // ignore
      }
    }
  }, [activeProjectId]);

  const handleSetTagFilterIds = useCallback((tagIds: string[]) => {
    const next = new Set(tagIds);
    setActiveTagIds(next);
    if (activeProjectId) {
      try {
        if (next.size > 0) {
          localStorage.setItem(`board-tag-filter-${activeProjectId}`, [...next].join(","));
        } else {
          localStorage.removeItem(`board-tag-filter-${activeProjectId}`);
        }
      } catch {
        // ignore
      }
    }
  }, [activeProjectId]);

  return {
    activeTagIds,
    setActiveTagIds,
    issueTypeFilter,
    priorityFilter,
    handleIssueTypeFilterChange,
    handlePriorityFilterChange,
    handleTagFilterToggle,
    handleClearTagFilter,
    handleSetTagFilterIds,
  };
}

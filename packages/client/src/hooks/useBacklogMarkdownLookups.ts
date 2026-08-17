import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../lib/api.js";

export interface StatusRow { id: string; name: string; sortOrder: number }
export interface TagRow { id: string; name: string }

/** The two lookups the Backlog Markdown export dialog filters on: the project's statuses (sorted) and all tags. */
export function useBacklogMarkdownLookups(projectId: string) {
  const statusesQ = useQuery({ queryKey: ["projects", projectId, "statuses", "backlog-md"], queryFn: () => apiFetch<StatusRow[]>(`/api/projects/${projectId}/statuses`), staleTime: 60_000 });
  const tagsQ = useQuery({ queryKey: ["tags", "backlog-md"], queryFn: () => apiFetch<TagRow[]>("/api/tags"), staleTime: 60_000 });
  const statuses = useMemo(() => (statusesQ.data ?? []).slice().sort((a, b) => a.sortOrder - b.sortOrder), [statusesQ.data]);
  return { statuses, tags: tagsQ.data ?? [] };
}

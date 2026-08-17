import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../lib/api.js";

export type PluginDocItem = { pluginId: string; pluginName: string; file: string; title: string; description?: string | null };

/** Docs the INSTALLED plugins declare (manifest `docs[]`) — an empty list on a board without any. */
export function usePluginDocs(enabled: boolean) {
  const q = useQuery({ queryKey: ["plugins", "docs"], queryFn: () => apiFetch<PluginDocItem[]>("/api/plugins/docs"), enabled, staleTime: 30_000 });
  return Array.isArray(q.data) ? q.data : [];
}

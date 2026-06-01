import { VIEW_IDS, type ViewMode } from "./viewRegistry.js";

export const BOARD_SAVED_VIEWS_PREFIX = "board_saved_views_";

export type BoardSortMode = "rank";

export interface BoardViewState {
  searchQuery: string;
  showBlocked: boolean;
  statusId: string | null;
  statusName: string | null;
  tagId: string | null;
  tagName: string | null;
  sortMode: BoardSortMode;
  viewMode: ViewMode;
}

export interface SavedBoardView {
  id: string;
  name: string;
  state: BoardViewState;
  createdAt: string;
  updatedAt: string;
}

export interface SavedViewReference {
  id: string;
  name: string;
}

export interface ResolvedBoardViewState {
  state: BoardViewState;
  dropped: Array<"status" | "tag">;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function normalizeName(name: string) {
  return name.trim().toLowerCase();
}

function isViewMode(value: unknown): value is ViewMode {
  return typeof value === "string" && VIEW_IDS.includes(value as ViewMode);
}

export function boardSavedViewsKey(projectId: string) {
  return `${BOARD_SAVED_VIEWS_PREFIX}${projectId}`;
}

export function sanitizeSavedBoardViews(raw: string | undefined): SavedBoardView[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item): SavedBoardView[] => {
      if (!isRecord(item) || !isRecord(item.state)) return [];
      const id = optionalString(item.id);
      const name = optionalString(item.name);
      if (!id || !name) return [];
      const state = item.state;
      return [{
        id,
        name: name.trim(),
        state: {
          searchQuery: typeof state.searchQuery === "string" ? state.searchQuery : "",
          showBlocked: state.showBlocked === true,
          statusId: optionalString(state.statusId),
          statusName: optionalString(state.statusName),
          tagId: optionalString(state.tagId),
          tagName: optionalString(state.tagName),
          sortMode: "rank",
          viewMode: isViewMode(state.viewMode) ? state.viewMode : "kanban",
        },
        createdAt: typeof item.createdAt === "string" ? item.createdAt : "",
        updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : "",
      }];
    }).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export function upsertSavedBoardView(
  views: SavedBoardView[],
  name: string,
  state: BoardViewState,
  now = new Date().toISOString(),
): SavedBoardView[] {
  const trimmed = name.trim();
  if (!trimmed) return views;
  const existing = views.find((view) => normalizeName(view.name) === normalizeName(trimmed));
  const nextView: SavedBoardView = {
    id: existing?.id ?? `view-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: trimmed,
    state,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  return [...views.filter((view) => view.id !== nextView.id), nextView]
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function renameSavedBoardView(
  views: SavedBoardView[],
  viewId: string,
  nextName: string,
  now = new Date().toISOString(),
): SavedBoardView[] {
  const trimmed = nextName.trim();
  if (!trimmed) return views;
  return views
    .map((view) => view.id === viewId ? { ...view, name: trimmed, updatedAt: now } : view)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function deleteSavedBoardView(views: SavedBoardView[], viewId: string): SavedBoardView[] {
  return views.filter((view) => view.id !== viewId);
}

export function resolveBoardViewState(
  saved: BoardViewState,
  statuses: SavedViewReference[],
  tags: SavedViewReference[],
): ResolvedBoardViewState {
  const dropped: Array<"status" | "tag"> = [];
  const state: BoardViewState = { ...saved };

  if (saved.statusId || saved.statusName) {
    const status = statuses.find((candidate) => candidate.id === saved.statusId)
      ?? statuses.find((candidate) => saved.statusName && candidate.name.toLowerCase() === saved.statusName.toLowerCase());
    if (status) {
      state.statusId = status.id;
      state.statusName = status.name;
    } else {
      state.statusId = null;
      state.statusName = null;
      dropped.push("status");
    }
  }

  if (saved.tagId || saved.tagName) {
    const tag = tags.find((candidate) => candidate.id === saved.tagId)
      ?? tags.find((candidate) => saved.tagName && candidate.name.toLowerCase() === saved.tagName.toLowerCase());
    if (tag) {
      state.tagId = tag.id;
      state.tagName = tag.name;
    } else {
      state.tagId = null;
      state.tagName = null;
      dropped.push("tag");
    }
  }

  return { state, dropped };
}

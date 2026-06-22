export const BOARD_SAVED_VIEWS_PREFIX = "board_saved_views_";

export interface BoardViewState {
  tagIds: string[];
  tagNames: string[];
  issueType: string | null;
  priority: string | null;
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
  dropped: Array<"tag">;
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

function optionalStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
}

export function boardSavedViewsKey(projectId: string) {
  return `${BOARD_SAVED_VIEWS_PREFIX}${projectId}`;
}

export function sanitizeSavedBoardViews(raw: string | undefined): SavedBoardView[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item): SavedBoardView[] => {
      if (!isRecord(item) || !isRecord(item.state)) return [];
      const id = optionalString(item.id);
      const name = optionalString(item.name);
      if (!id || !name) return [];
      const state = item.state;
      const legacyTagId = optionalString(state.tagId);
      const legacyTagName = optionalString(state.tagName);
      return [{
        id,
        name: name.trim(),
        state: {
          tagIds: optionalStringArray(state.tagIds).length > 0
            ? optionalStringArray(state.tagIds)
            : legacyTagId ? [legacyTagId] : [],
          tagNames: optionalStringArray(state.tagNames).length > 0
            ? optionalStringArray(state.tagNames)
            : legacyTagName ? [legacyTagName] : [],
          issueType: optionalString(state.issueType),
          priority: optionalString(state.priority),
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
  tags: SavedViewReference[],
): ResolvedBoardViewState {
  const dropped: Array<"tag"> = [];
  const state: BoardViewState = { ...saved };

  if (saved.tagIds.length > 0 || saved.tagNames.length > 0) {
    const resolvedTags: SavedViewReference[] = [];
    const seenTagIds = new Set<string>();
    let missingTags = false;
    const tagCount = Math.max(saved.tagIds.length, saved.tagNames.length);

    for (let i = 0; i < tagCount; i += 1) {
      const savedId = saved.tagIds[i];
      const savedName = saved.tagNames[i]?.toLowerCase();
      const tag = tags.find((candidate) => candidate.id === savedId)
        ?? tags.find((candidate) => !!savedName && candidate.name.toLowerCase() === savedName);
      if (!tag) {
        missingTags = true;
        continue;
      }
      if (!seenTagIds.has(tag.id)) {
        resolvedTags.push(tag);
        seenTagIds.add(tag.id);
      }
    }

    state.tagIds = resolvedTags.map((tag) => tag.id);
    state.tagNames = resolvedTags.map((tag) => tag.name);
    if (missingTags) {
      dropped.push("tag");
    }
  }

  return { state, dropped };
}

export function boardViewStatesEqual(a: BoardViewState, b: BoardViewState): boolean {
  return (
    sorted(a.tagIds).join("\0") === sorted(b.tagIds).join("\0") &&
    (a.issueType ?? "") === (b.issueType ?? "") &&
    (a.priority ?? "") === (b.priority ?? "")
  );
}

function sorted(values: string[]) {
  return [...values].sort((a, b) => a.localeCompare(b));
}

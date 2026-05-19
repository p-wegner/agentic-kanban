export type ActionCategory = "board" | "navigation" | "issue" | "settings";

export interface Action {
  id: string;
  label: string;
  description?: string;
  icon?: string;
  shortcut?: string;
  category: ActionCategory;
  handler: () => void;
}

const actions = new Map<string, Action>();

export function registerAction(action: Action): () => void {
  actions.set(action.id, action);
  return () => actions.delete(action.id);
}

export function getActions(): Action[] {
  return Array.from(actions.values());
}

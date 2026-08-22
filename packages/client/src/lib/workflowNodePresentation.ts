/**
 * How a workflow node TYPE presents itself — everything derived from the type alone (#722).
 *
 * The builder asks the same question about a node type in three places that must agree: the
 * palette button's caption and its colour swatch, the react-flow node's inline style, and
 * the board status a freshly added node starts on. All three are functions of the type
 * string and nothing else, which is why they belong together and away from the component:
 * a new node type is added here once instead of in three render sites.
 */

/** The node types a workflow graph may contain, in palette order. */
export const NODE_TYPES = ["start", "normal", "parallel-fork", "parallel-join", "end"] as const;

/** Canvas fill per node type — also the palette swatch colour. */
export const NODE_COLORS: Record<string, string> = {
  start: "#dcfce7",
  normal: "#eff6ff",
  "parallel-fork": "#f3e8ff",
  "parallel-join": "#f3e8ff",
  end: "#e5e7eb",
};

/** Human caption for a node type ("parallel-fork" → "Parallel fork"). */
export function nodeTypeLabel(type: string): string {
  return type.charAt(0).toUpperCase() + type.slice(1).replace(/-/g, " ");
}

/** The react-flow inline style for a node of this type. */
export function nodeStyle(type: string) {
  return {
    background: NODE_COLORS[type] ?? "#fff",
    border: "1px solid #94a3b8",
    borderRadius: 8,
    fontSize: 12,
    padding: 6,
    color: "#111",
  };
}

/** The board status a newly added node of this type starts on. */
export function defaultStatus(type: string): string | null {
  if (type === "start") return "In Progress";
  if (type === "end") return "Done";
  if (type === "normal") return "In Progress";
  return "In Review";
}

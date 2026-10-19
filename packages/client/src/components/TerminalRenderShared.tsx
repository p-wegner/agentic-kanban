// Shared render types + highlightText for TerminalEventRenderer and TerminalToolUseRenderer
// (kept apart so the two renderers do not import each other).

import type { SubagentGroup } from "../lib/terminal-transcript.js";

export interface RenderContext {
  multiTurn?: boolean;
  expandedSections: Set<number>;
  toggleExpand: (idx: number) => void;
  parseOutput: "minimal" | "false";
  activeSubagentToolUseIds: Set<string>;
  subagentGroups: Map<string, SubagentGroup>;
  eventToSubagent: Map<number, string>;
  isMaximized: boolean;
  searchQuery: string;
}

export function highlightText(text: string, query: string): React.ReactNode {
  const needle = query.trim();
  if (!needle) return text;

  const lowerText = text.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  let matchIdx = lowerText.indexOf(lowerNeedle);

  while (matchIdx !== -1) {
    if (matchIdx > cursor) parts.push(text.slice(cursor, matchIdx));
    const end = matchIdx + needle.length;
    parts.push(
      <mark key={`${matchIdx}-${end}`} className="rounded bg-yellow-300 px-0.5 text-gray-950">
        {text.slice(matchIdx, end)}
      </mark>,
    );
    cursor = end;
    matchIdx = lowerText.indexOf(lowerNeedle, cursor);
  }

  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

/** Shared, event-agnostic view flags computed once per event before dispatch. */
export interface DerivedRenderState {
  isExpanded: boolean;
  isMinimal: boolean;
  isInsideSubagent: boolean;
  isSubagentStart: boolean;
  isSubagentEnd: boolean;
}

import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * The board's markdown renderer.
 *
 * Bare `<ReactMarkdown>` parses CommonMark only — **no tables, no task lists, no
 * strikethrough, no autolinks, no footnotes**. Those are GitHub-Flavoured Markdown,
 * and they arrive only with `remark-gfm`. Two call sites passed the plugin and the
 * rest did not, so the same document rendered differently depending on which pane
 * you opened it in.
 *
 * MEASURED on the PM-pipeline artifact viewer (`docs/pm-pipeline/steps/step-7/test_plan.md`,
 * a 50-row acceptance-criteria table): 0 `<table>` elements, 16 paragraphs of literal
 * `|`-pipe rows. The pane already carried `prose-table:*` classes, so the styling
 * implied tables worked — nothing pointed at the missing plugin. A reviewer's core
 * artifact was unreadable in the tool built for reviewing it.
 *
 * So: one component, GFM always on, and nobody has to remember the plugin again.
 *
 * `rehype-raw` is deliberately NOT enabled — artifacts are agent-written files, and
 * raw HTML in them would render unsanitised.
 */

/**
 * Tables scroll in their OWN box rather than via `prose-table:block`.
 *
 * The `display:block` trick makes a wide table scrollable but drops it out of table
 * layout, so columns stop aligning to a shared width — on a 50-row plan that is the
 * difference between a table and a ragged list. Wrapping instead keeps `display:table`
 * (real column alignment) and puts the overflow on the wrapper, where it belongs.
 */
const DEFAULT_COMPONENTS: Components = {
  table: ({ children, ...props }) => (
    <div className="not-prose my-3 overflow-x-auto rounded border border-gray-200 dark:border-gray-700">
      <table className="w-full text-xs border-collapse" {...props}>{children}</table>
    </div>
  ),
  thead: ({ children }) => (
    <thead className="bg-gray-50 dark:bg-gray-800/60 text-gray-700 dark:text-gray-200">{children}</thead>
  ),
  th: ({ children }) => (
    <th className="border border-gray-200 dark:border-gray-700 px-2 py-1 text-left font-medium align-top">{children}</th>
  ),
  td: ({ children }) => (
    <td className="border border-gray-200 dark:border-gray-700 px-2 py-1 align-top text-gray-700 dark:text-gray-300">{children}</td>
  ),
  // A GFM task list renders a real, focusable checkbox. In a REVIEW surface that is a
  // lie — the file is read-only here and ticking it changes nothing (this is the same
  // trap #454 folded away for the gate's own approval block). Keep the glyph, drop the
  // affordance.
  input: ({ type, checked }) =>
    type === "checkbox"
      ? <span aria-hidden="true" className="mr-1 select-none">{checked ? "☑" : "☐"}</span>
      : null,
};

export interface MarkdownViewProps {
  children: string;
  /** Merged over the defaults, so a caller can override one element without losing the rest. */
  components?: Components;
}

export function MarkdownView({ children, components }: MarkdownViewProps) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={components ? { ...DEFAULT_COMPONENTS, ...components } : DEFAULT_COMPONENTS}
    >
      {children}
    </ReactMarkdown>
  );
}

/** Exported for tests and for callers that need to extend rather than replace. */
export { DEFAULT_COMPONENTS as markdownViewDefaultComponents };

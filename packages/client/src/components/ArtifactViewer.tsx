import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { MarkdownView } from "./MarkdownView.js";
import type { DiffComment, CreateDiffCommentRequest } from "@agentic-kanban/shared";
import { apiFetch } from "../lib/api.js";
import { DiffViewer } from "./DiffViewer.js";
import {
  findMatchingLines,
  parseMarkdownOutline,
  slugifyHeading,
  splitHighlight,
  splitLines,
  type MarkdownHeading,
} from "./markdownNavigation.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

export { findMatchingLines, parseMarkdownOutline, slugifyHeading, splitHighlight, type MarkdownHeading };

// ── Artifact viewer (#288) ────────────────────────────────────────────
//
// Split out of PluginLoopExtras (#465) so that file stays under the god-module ceiling. The
// markdown-navigation primitives (outline/find/highlight) live in `markdownNavigation.ts`
// since ArtifactViewer + its gate-bookkeeping detection alone were still over 1000 lines.

// ── Plugin gate bookkeeping (#454) ──────────────────────────────────
//
// A file-backed gate keeps its answer IN the artifact: pm-pipeline's `status.md` opens with
//
//   ## Approval
//   - [ ] Approved
//   - [ ] Needs revision
//   ## Feedback
//   (reviewer writes here)
//
// Rendered verbatim, that is a second, non-functional approval form sitting directly above the
// real buttons — and hand-ticking it is explicitly forbidden (the plugin's own resolve script
// owns that file). So the viewer collapses it behind a disclosure that says what it is and who
// answers it.
//
// The detection is deliberately structural, never plugin-specific: a heading whose body is
// NOTHING BUT task-list items, whose labels mirror the gate's own action labels. When no action
// labels are supplied it falls back to a generic approval vocabulary on the heading. Anything
// that does not match is rendered unchanged — the failure mode is "show it", never "hide
// something we did not understand".

export type GateBookkeepingItem = { label: string; checked: boolean };
export type GateBookkeepingBlock = {
  /** 0-based inclusive line range covered, including an adjoining placeholder Feedback section. */
  startLine: number;
  endLine: number;
  heading: string;
  items: GateBookkeepingItem[];
  /** True once the file itself carries an answer — then it is a record, not a prompt. */
  answered: boolean;
  /** Set when a `## Feedback` placeholder section was folded in with the approval section. */
  feedbackHeading?: string;
};

const TASK_ITEM_RE = /^\s*[-*+]\s+\[([ xX])\]\s+(.*\S)\s*$/;
const GENERIC_APPROVAL_HEADING = /^(approval|approvals|sign[- ]?off|decision|review decision|gate)\b/i;

function normalizeLabel(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** "Approved" mirrors the gate action "Approve"; "Needs revision" mirrors "Needs revision". */
function labelsMirror(a: string, b: string): boolean {
  const x = normalizeLabel(a);
  const y = normalizeLabel(b);
  if (x.length < 4 || y.length < 4) return false;
  return x === y || x.startsWith(y) || y.startsWith(x);
}

export function detectGateBookkeeping(
  content: string,
  actionLabels?: string[] | null,
): GateBookkeepingBlock[] {
  const lines = splitLines(content);
  const headings = parseMarkdownOutline(content);
  if (headings.length === 0) return [];
  const sectionEnd = (i: number) => (i + 1 < headings.length ? headings[i + 1].line - 1 : lines.length - 1);

  const blocks: GateBookkeepingBlock[] = [];
  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i];
    const end = sectionEnd(i);
    const body = lines.slice(heading.line + 1, end + 1);
    const items: GateBookkeepingItem[] = [];
    let foreign = 0;
    for (const line of body) {
      if (!line.trim()) continue;
      const m = TASK_ITEM_RE.exec(line);
      if (m) items.push({ label: m[2].trim(), checked: m[1].toLowerCase() === "x" });
      else foreign++;
    }
    if (items.length < 2 || foreign > 0) continue;

    const labels = (actionLabels ?? []).filter(Boolean);
    const mirrored = labels.length > 0
      ? items.filter((item) => labels.some((label) => labelsMirror(item.label, label))).length
      : 0;
    const qualifies = labels.length > 0
      ? mirrored * 2 >= items.length
      : GENERIC_APPROVAL_HEADING.test(heading.text);
    if (!qualifies) continue;

    const block: GateBookkeepingBlock = {
      startLine: heading.line,
      endLine: end,
      heading: heading.text,
      items,
      answered: items.some((item) => item.checked),
    };

    // The "(reviewer writes here)" prompt belongs to the same machinery — the board collects
    // that feedback in a textarea — but only fold it in when it really is a placeholder.
    const next = headings[i + 1];
    if (next && /^feedback\b/i.test(next.text)) {
      const nextEnd = sectionEnd(i + 1);
      const nextBody = lines.slice(next.line + 1, nextEnd + 1).filter((l) => l.trim());
      const placeholder = nextBody.length === 0
        || (nextBody.length === 1 && /^\(.*\)$/.test(nextBody[0].trim()));
      if (placeholder) {
        block.endLine = nextEnd;
        block.feedbackHeading = next.text;
        i++;
      }
    }
    blocks.push(block);
  }
  return blocks;
}

/** The document split into plain-markdown runs and collapsible bookkeeping runs. */
export type ArtifactSegment =
  | { kind: "markdown"; text: string }
  | { kind: "bookkeeping"; text: string; block: GateBookkeepingBlock };

export function segmentArtifact(content: string, blocks: GateBookkeepingBlock[]): ArtifactSegment[] {
  if (blocks.length === 0) return [{ kind: "markdown", text: content }];
  const lines = splitLines(content);
  const segments: ArtifactSegment[] = [];
  let cursor = 0;
  for (const block of blocks) {
    if (block.startLine > cursor) {
      segments.push({ kind: "markdown", text: lines.slice(cursor, block.startLine).join("\n") });
    }
    segments.push({ kind: "bookkeeping", text: lines.slice(block.startLine, block.endLine + 1).join("\n"), block });
    cursor = block.endLine + 1;
  }
  if (cursor < lines.length) segments.push({ kind: "markdown", text: lines.slice(cursor).join("\n") });
  return segments.filter((s) => s.kind === "bookkeeping" || s.text.trim().length > 0);
}

/** Flatten a ReactMarkdown heading's children back to text so it can carry a stable anchor id. */
function reactNodeText(node: unknown): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(reactNodeText).join("");
  if (typeof node === "object" && "props" in (node as Record<string, unknown>)) {
    return reactNodeText((node as { props?: { children?: unknown } }).props?.children);
  }
  return "";
}

type ArtifactResponse = {
  path: string;
  exists: boolean;
  content: string | null;
  truncated: boolean;
  commits: Array<{ sha: string; date: string }>;
  diff: string | null;
  /** Whether a v(N-1)→vN diff can be fetched (#421) — the diff itself is deferred. */
  hasPreviousVersion?: boolean;
};

export function ArtifactViewer({ pluginId, loopName, projectId, path, step, gateActionLabels, findHints, initialFind, onOpenArtifact, onClose, onLineNotesChange }: {
  pluginId: string;
  loopName: string;
  projectId: string;
  path: string;
  /**
   * The step this artifact belongs to, when it was opened from the stepper (#422/#423).
   * Supplies the human-readable header ("Step 7/9 — Test & QA · v3") and, when the step
   * declares more than one artifact, the sibling picker. Absent when the viewer is opened
   * from the gate card or the unit list, which have their own per-file affordances.
   */
  step?: { label: string; version?: string; artifacts?: string[]; index?: number; total?: number };
  /**
   * The gate's own action labels (#454). Supplied, the viewer can tell a file-backed gate's
   * `[ ] Approved / [ ] Needs revision` machinery apart from ordinary checklist content and
   * collapse it. Omitted, detection falls back to a generic approval heading vocabulary — and
   * when neither matches, the file renders exactly as before.
   */
  gateActionLabels?: string[];
  /**
   * Identifiers a failing check quoted (#452) — offered as one-click "jump to" chips. The
   * caller extracts them with `checkLocationTokens` from `gateCardPolicy`.
   */
  findHints?: string[];
  /** Open the viewer already searching for this token, scrolled to the first hit (#452). */
  initialFind?: string;
  /** Switch to a sibling artifact of the same step without closing the viewer. */
  onOpenArtifact?: (path: string) => void;
  onClose: () => void;
  /**
   * Line-anchored review notes (#304): comments created on the version diff are
   * reported upward as "file:line: body" strings so the gate card can attach them
   * to revision feedback. Local-only — nothing is persisted server-side.
   */
  onLineNotesChange?: (notes: string[]) => void;
}) {
  const [artifact, setArtifact] = useState<ArtifactResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"rendered" | "raw" | "diff">("rendered");
  const [diffComments, setDiffComments] = useState<DiffComment[]>([]);
  // Find-in-document (#452). It operates on the RAW lines, which is the only representation
  // whose positions we can address: the rendered tree is arbitrary markdown output with no
  // line identity. So typing a query moves the viewer to the raw line view and highlights
  // there; the outline works in both tabs (rendered headings carry anchor ids).
  const [query, setQuery] = useState(initialFind ?? "");
  const [matchIndex, setMatchIndex] = useState(0);

  function publishNotes(comments: DiffComment[]) {
    onLineNotesChange?.(comments
      .filter((c) => !c.resolvedAt)
      .map((c) => `${c.filePath}:${c.lineNumNew ?? c.lineNumOld ?? "?"}: ${c.body}`));
  }

  function handleCreateComment(data: CreateDiffCommentRequest) {
    const now = new Date().toISOString();
    const next: DiffComment[] = [...diffComments, {
      id: `local-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      workspaceId: "",
      filePath: data.filePath,
      lineNumOld: data.lineNumOld ?? null,
      lineNumNew: data.lineNumNew ?? null,
      side: data.side,
      body: data.body,
      resolvedAt: null,
      createdAt: now,
      updatedAt: now,
    }];
    setDiffComments(next);
    publishNotes(next);
  }

  function handleEditComment(commentId: string, body: string) {
    const next = diffComments.map((c) => (c.id === commentId ? { ...c, body, updatedAt: new Date().toISOString() } : c));
    setDiffComments(next);
    publishNotes(next);
  }

  function handleDeleteComment(commentId: string) {
    const next = diffComments.filter((c) => c.id !== commentId);
    setDiffComments(next);
    publishNotes(next);
  }

  function handleResolveComment(commentId: string, resolved: boolean) {
    const next = diffComments.map((c) => (c.id === commentId ? { ...c, resolvedAt: resolved ? new Date().toISOString() : null } : c));
    setDiffComments(next);
    publishNotes(next);
  }

  const diffStats = useMemo(() => {
    const diff = artifact?.diff ?? "";
    let insertions = 0;
    let deletions = 0;
    for (const line of diff.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) insertions++;
      else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
    }
    return { filesChanged: 1, insertions, deletions };
  }, [artifact?.diff]);

  // The diff is fetched lazily (#421): opening an artifact costs one `git log`, and the
  // second `git` spawn only happens if the reader actually asks for the Diff tab.
  const [wantDiff, setWantDiff] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setArtifact(null);
    setError(null);
    setTab(initialFind ? "raw" : "rendered");
    setWantDiff(false);
    setQuery(initialFind ?? "");
    setMatchIndex(0);
    return () => { cancelled = true; void cancelled; };
  }, [pluginId, loopName, projectId, path, initialFind]);

  useEffect(() => {
    let cancelled = false;
    apiFetch<ArtifactResponse>(
      `/api/plugins/${pluginId}/loops/${encodeURIComponent(loopName)}/artifact`
      + `?projectId=${projectId}&path=${encodeURIComponent(path)}${wantDiff ? "&withDiff=1" : ""}`,
    )
      .then((res) => { if (!cancelled) setArtifact(res); })
      .catch((err) => { if (!cancelled) setError(errorMessage(err)); });
    return () => { cancelled = true; };
  }, [pluginId, loopName, projectId, path, wantDiff]);

  /** Offering the Diff tab must not depend on the diff being loaded — that is the deferral. */
  const canDiff = artifact?.hasPreviousVersion ?? artifact?.diff != null;
  const diffPending = tab === "diff" && artifact?.diff == null;

  function openDiff() {
    setTab("diff");
    setWantDiff(true);
  }

  const siblings = step?.artifacts ?? [];

  const isMarkdown = /\.(md|markdown)$/i.test(path);

  const content = artifact?.content ?? "";
  const outline = useMemo(
    () => (isMarkdown && content ? parseMarkdownOutline(content) : []),
    [isMarkdown, content],
  );
  const bookkeeping = useMemo(
    () => (isMarkdown && content ? detectGateBookkeeping(content, gateActionLabels) : []),
    [isMarkdown, content, gateActionLabels],
  );
  const segments = useMemo(() => segmentArtifact(content, bookkeeping), [content, bookkeeping]);
  const matches = useMemo(() => findMatchingLines(content, query), [content, query]);
  const rawLines = useMemo(() => splitLines(content), [content]);
  const currentMatchLine = matches.length > 0 ? matches[Math.min(matchIndex, matches.length - 1)] : null;

  const bodyRef = useRef<HTMLDivElement | null>(null);

  function scrollToLine(line: number) {
    const el = bodyRef.current?.querySelector(`[data-artifact-line="${line}"]`);
    (el as HTMLElement | null)?.scrollIntoView?.({ block: "center" });
  }

  function search(next: string) {
    setQuery(next);
    setMatchIndex(0);
    if (next.trim() && tab !== "raw") setTab("raw");
  }

  function stepMatch(delta: number) {
    if (matches.length === 0) return;
    setMatchIndex((i) => (i + delta + matches.length) % matches.length);
  }

  // Scroll the current hit into view once the raw lines are on screen.
  useEffect(() => {
    if (tab !== "raw" || currentMatchLine == null) return;
    scrollToLine(currentMatchLine);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, currentMatchLine, artifact?.content]);

  function jumpToHeading(heading: MarkdownHeading) {
    if (tab === "rendered") {
      // `slugifyHeading` only ever emits [a-z0-9-], so the id is selector-safe as written.
      const el = bodyRef.current?.querySelector(`#artifact-h-${heading.slug}`);
      (el as HTMLElement | null)?.scrollIntoView?.({ block: "start" });
      return;
    }
    if (tab !== "raw") setTab("raw");
    // The raw lines may not be mounted yet on a tab switch — retry after paint.
    scrollToLine(heading.line);
    setTimeout(() => scrollToLine(heading.line), 0);
  }

  /** Anchor ids on rendered headings, so the outline works in the Rendered tab too. */
  const markdownComponents = useMemo(() => {
    const heading = (Tag: "h1" | "h2" | "h3" | "h4" | "h5" | "h6") =>
      function Heading({ children }: { children?: ReactNode }) {
        return <Tag id={`artifact-h-${slugifyHeading(reactNodeText(children))}`}>{children}</Tag>;
      };
    return { h1: heading("h1"), h2: heading("h2"), h3: heading("h3"), h4: heading("h4"), h5: heading("h5"), h6: heading("h6") };
  }, []);

  // The viewer renders inline BELOW the gate card / loop stats, so opening it from
  // a chip near the top of a long pane put it entirely below the fold — the click
  // appeared to do nothing (measured in the 2026-08-11 UX round). Scroll it into
  // view whenever it opens or switches artifact.
  const containerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    containerRef.current?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  }, [path]);

  // Below sm the viewer is a FULL-SCREEN sheet, not an inline max-h-[60vh] box (#434).
  // Inline, it was the third nested scroll container (pane -> viewer -> diff body): a
  // vertical swipe inside it moved neither the page nor reliably the intended layer, and
  // ~60vh of a phone (with dynamic browser chrome) is too little to read a PRD in. The
  // sheet also makes the ✕ meaningful instead of a way to shrink one box inside another.
  //
  // At `lg` this is the LEFT column of the loop pane's split review layout (#447): the pane
  // stops scrolling there, so the viewer takes the full pane height (`max-h-none`) and its
  // body is the only scroller on this side — which is what puts the document and the gate's
  // decision buttons on screen at the same time. The pane only ever renders this component
  // when an artifact is open, and an open artifact at `lg` IS the split layout, so these
  // variants need no flag to stay in step with it.
  return (
    <div
      ref={containerRef}
      className="fixed inset-0 z-40 rounded-none max-h-none sm:static sm:z-auto sm:rounded sm:max-h-[60vh] lg:order-first lg:flex-1 lg:min-w-0 lg:min-h-0 lg:max-h-none border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 flex flex-col"
      data-testid="plugin-artifact-viewer"
    >
      <div className="border-b border-gray-100 dark:border-gray-800 px-3 py-2 space-y-1">
        <div className="flex items-center gap-2">
          {/* Which STEP this file belongs to (#423). The path alone only reads as a step
              because THIS plugin encodes the number in it; a plugin writing `docs/prd.md`
              would leave the reader with nothing. */}
          <div className="min-w-0 flex-1">
            {step ? (
              <>
                <div className="text-xs font-medium text-gray-800 dark:text-gray-100 truncate" data-testid="plugin-artifact-step">
                  {step.index && step.total ? `Step ${step.index}/${step.total} — ` : ""}{step.label}
                  {step.version && <span className="ml-1 text-gray-500 dark:text-gray-400 font-normal">{step.version}</span>}
                </div>
                <div className="text-[10px] font-mono text-gray-500 dark:text-gray-400 truncate" title={path}>{path}</div>
              </>
            ) : (
              <span className="text-xs font-mono text-gray-600 dark:text-gray-300 truncate block" title={path}>{path}</span>
            )}
          </div>
          {artifact?.exists && (
            <div className="flex items-center gap-1 text-[11px] shrink-0">
              {(["rendered", "raw"] as const).filter((t) => t !== "rendered" || isMarkdown).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`px-3 py-2 sm:px-2 sm:py-0.5 min-h-11 sm:min-h-0 rounded ${tab === t ? "bg-brand-600 text-white" : "text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"}`}
                >
                  {t === "rendered" ? "Rendered" : "Raw"}
                </button>
              ))}
              {canDiff && (
                <button
                  onClick={openDiff}
                  className={`px-3 py-2 sm:px-2 sm:py-0.5 min-h-11 sm:min-h-0 rounded ${tab === "diff" ? "bg-brand-600 text-white" : "text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"}`}
                  title="Diff between the artifact's last two committed versions"
                >
                  Diff v-1→v
                </button>
              )}
            </div>
          )}
          <button
            onClick={onClose}
            className="text-xs px-3 py-2 sm:px-2 sm:py-0.5 min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 rounded text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 shrink-0"
            aria-label="Close artifact"
          >
            ✕
          </button>
        </div>
        {/* Sibling artifacts of the same step (#422). Without this the step chip opens
            artifacts[0] and the rest of the step's output has no route in the UI at all. */}
        {siblings.length > 1 && onOpenArtifact && (
          <div className="flex flex-wrap items-center gap-1" data-testid="plugin-artifact-siblings">
            {siblings.map((sib) => {
              const active = sib === path;
              return (
                <button
                  key={sib}
                  type="button"
                  onClick={() => !active && onOpenArtifact(sib)}
                  title={sib}
                  aria-current={active ? "true" : undefined}
                  className={`text-[10px] font-mono px-2.5 py-2 sm:px-1.5 sm:py-0.5 min-h-11 sm:min-h-0 rounded border ${
                    active
                      ? "border-brand-500 bg-brand-50 dark:bg-brand-900/30 text-brand-700 dark:text-brand-300"
                      : "border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
                  }`}
                >
                  {sib.split("/").pop()}
                </button>
              );
            })}
          </div>
        )}
        {/* Find-in-document + outline (#452). A check detail names one row of a 50-row table;
            before this the only tool was the browser's Ctrl+F, which inside a 60vh nested
            scroller scrolls the wrong layer as often as the right one. */}
        {artifact?.exists && artifact.content !== null && tab !== "diff" && (
          <div className="flex flex-wrap items-center gap-1.5" data-testid="plugin-artifact-find-bar">
            <input
              type="search"
              value={query}
              onChange={(e) => search(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); stepMatch(e.shiftKey ? -1 : 1); } }}
              placeholder="Find in file…"
              // text-base below sm: iOS Safari zooms the page on focus for any input under
              // 16px and never zooms back out (same guard as the gate textarea, #433).
              className="text-base sm:text-[11px] px-2 py-2 sm:py-0.5 min-h-11 sm:min-h-0 w-40 sm:w-52 rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900"
              data-testid="plugin-artifact-find"
            />
            {query.trim() && (
              <>
                <span className="text-[11px] text-gray-500 dark:text-gray-400" data-testid="plugin-artifact-find-count">
                  {matches.length === 0 ? "no matches" : `${Math.min(matchIndex, matches.length - 1) + 1}/${matches.length}`}
                </span>
                <button
                  type="button"
                  onClick={() => stepMatch(-1)}
                  disabled={matches.length === 0}
                  className="text-[11px] px-3 py-2 sm:px-1.5 sm:py-0.5 min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 rounded border border-gray-200 dark:border-gray-700 text-gray-500 disabled:opacity-40"
                  aria-label="Previous match"
                >↑</button>
                <button
                  type="button"
                  onClick={() => stepMatch(1)}
                  disabled={matches.length === 0}
                  className="text-[11px] px-3 py-2 sm:px-1.5 sm:py-0.5 min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 rounded border border-gray-200 dark:border-gray-700 text-gray-500 disabled:opacity-40"
                  aria-label="Next match"
                  data-testid="plugin-artifact-find-next"
                >↓</button>
              </>
            )}
            {/* Identifiers a failing check quoted — the whole point is not having to retype
                `STORY-2-1 Sz.3` from a paragraph two panes up. */}
            {(findHints ?? []).slice(0, 6).map((hint) => (
              <button
                key={hint}
                type="button"
                onClick={() => search(hint)}
                title={`Find "${hint}" in this file`}
                className={`text-[11px] font-mono px-2.5 py-2 sm:px-1.5 sm:py-0.5 min-h-11 sm:min-h-0 rounded border ${
                  query === hint
                    ? "border-brand-500 bg-brand-50 dark:bg-brand-900/30 text-brand-700 dark:text-brand-300"
                    : "border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
                }`}
                data-testid="plugin-artifact-find-hint"
              >
                🔎 {hint}
              </button>
            ))}
            {outline.length > 1 && (
              <details className="relative" data-testid="plugin-artifact-outline">
                <summary className="cursor-pointer select-none text-[11px] px-2.5 py-2 sm:px-1.5 sm:py-0.5 min-h-11 sm:min-h-0 rounded border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400">
                  ☰ Outline ({outline.length})
                </summary>
                <ul className="absolute z-10 mt-1 max-h-64 w-72 overflow-auto rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-1 shadow-lg">
                  {outline.map((heading, i) => (
                    <li key={`${heading.slug}-${i}`}>
                      <button
                        type="button"
                        onClick={() => jumpToHeading(heading)}
                        style={{ paddingLeft: `${(heading.depth - 1) * 10 + 6}px` }}
                        className="block w-full truncate text-left text-[11px] py-1.5 rounded text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
                        title={heading.text}
                      >
                        {heading.text}
                      </button>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
      </div>
      <div ref={bodyRef} className="flex-1 min-h-0 overflow-auto p-3">
        {error && <div className="text-xs text-red-600 dark:text-red-400">{error}</div>}
        {!artifact && !error && <div className="text-xs text-gray-500 dark:text-gray-400">Loading…</div>}
        {artifact && !artifact.exists && (
          <div className="text-xs text-gray-500 dark:text-gray-400">
            Not produced yet — the file will appear once its step has run.
          </div>
        )}
        {artifact?.exists && diffPending && (
          <div className="text-xs text-gray-500 dark:text-gray-400">Loading diff…</div>
        )}
        {artifact?.exists && artifact.content !== null && !diffPending && (
          tab === "diff" && artifact.diff ? (
            // Full diff surface (#304): syntax highlight + INLINE COMMENTS. Comments stay
            // local; the gate card attaches them to revision feedback as "file:line: note".
            <DiffViewer
              diff={artifact.diff}
              stats={diffStats}
              comments={diffComments}
              onCreateComment={handleCreateComment}
              onEditComment={handleEditComment}
              onDeleteComment={handleDeleteComment}
              onResolveComment={handleResolveComment}
            />
          ) : tab === "rendered" && isMarkdown ? (
            // A PM Pipeline PRD routinely contains wide tables and fenced code. Typography's
            // table/pre do not wrap, so without this they push the whole pane sideways (#434).
            // Tables get their overflow from MarkdownView's own wrapper, NOT `prose-table:block`
            // — that trick drops the table out of table layout and un-aligns every column.
            <div className="prose prose-sm dark:prose-invert max-w-none prose-pre:whitespace-pre-wrap prose-pre:break-words prose-img:max-w-full">
              {segments.map((segment, i) =>
                segment.kind === "markdown" ? (
                  <MarkdownView key={`md-${i}`} components={markdownComponents}>{segment.text}</MarkdownView>
                ) : (
                  <details
                    key={`bk-${i}`}
                    className="not-prose my-2 rounded border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/40 px-2.5 py-1.5"
                    data-testid="plugin-artifact-bookkeeping"
                    data-bookkeeping-answered={segment.block.answered ? "true" : "false"}
                  >
                    <summary className="cursor-pointer select-none text-[11px] text-gray-500 dark:text-gray-400">
                      🔒 Plugin bookkeeping: {segment.block.heading}
                      {segment.block.feedbackHeading ? ` + ${segment.block.feedbackHeading}` : ""} —{" "}
                      {segment.block.answered
                        ? `recorded in the file (${segment.block.items.filter((it) => it.checked).map((it) => it.label).join(", ")})`
                        : "not yet answered; use the gate buttons, not this file"}
                    </summary>
                    <pre className="mt-1 text-[11px] whitespace-pre-wrap break-words text-gray-500 dark:text-gray-400">
                      {segment.text.trim()}
                    </pre>
                  </details>
                ),
              )}
            </div>
          ) : (
            // Raw is line-addressed (#452): every line carries its number so find, the outline
            // and a check's quoted identifier can all scroll to it and highlight it.
            <pre className="text-[11px] text-gray-700 dark:text-gray-300" data-testid="plugin-artifact-raw">
              {rawLines.map((line, i) => (
                <div
                  key={i}
                  data-artifact-line={i}
                  className={`whitespace-pre-wrap break-all ${
                    currentMatchLine === i ? "bg-amber-100 dark:bg-amber-900/40 rounded" : ""
                  }`}
                >
                  {query.trim()
                    ? splitHighlight(line, query).map((part, j) =>
                        part.hit
                          ? <mark key={j} className="bg-amber-300 dark:bg-amber-600 dark:text-white rounded-sm">{part.text}</mark>
                          : <span key={j}>{part.text}</span>,
                      )
                    : line}
                  {line.trim() === "" ? " " : ""}
                </div>
              ))}
            </pre>
          )
        )}
        {artifact?.truncated && (
          <div className="mt-2 text-[11px] text-amber-700 dark:text-amber-400">Truncated — the full file is in the repo.</div>
        )}
      </div>
    </div>
  );
}

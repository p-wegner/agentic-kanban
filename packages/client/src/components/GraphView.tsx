import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";
import { apiFetch } from "../lib/api.js";
import { STATUS_COLORS, TYPE_COLORS, BRAND, ACCENT } from "../lib/chartColors";
import { computeCriticalPath, type CriticalPathResult, type ChainStep } from "../lib/criticalPath.js";

interface Dependency {
  id: string;
  issueId: string;
  dependsOnId: string;
  type: string;
  issueTitle: string;
  issueStatusName: string;
  issueNumber: number | null;
}

interface GraphData {
  nodes: IssueWithStatus[];
  edges: Dependency[];
}

interface Node {
  id: string;
  x: number;
  y: number;
  issue: IssueWithStatus;
}

// Ordered workflow columns for status-based layout
const STATUS_ORDER = ["Backlog", "Todo", "In Progress", "In Review", "AI Reviewed", "Done", "Cancelled"];

const DEPENDENCY_COLORS: Record<string, string> = {
  depends_on: "#8a8175",
  blocked_by: "#b4453a",
  related_to: ACCENT,
  parent_of: "#c79a3e",
  child_of: "#c79a3e",
  duplicates: "#b07a8c",
};

/** Root blocker color — warm brick (same family as TYPE_COLORS.bug). */
const ROOT_BLOCKER_COLOR = "#b4453a";
/** Critical-chain edge color. */
const CHAIN_EDGE_COLOR = "#c25f36";
/** Cycle indicator color — amber. */
const CYCLE_COLOR = "#f59e0b";

const NODE_W = 220;
const NODE_H = 64;
const H_GAP = 48;
const V_GAP = 16;
const COL_HEADER_H = 28;
const SWIMLANE_NODES_PER_ROW = 2;
const DEPENDENCY_ROWS_PER_COLUMN = 8;
const BAND_GAP = 64; // gap between status groups in swimlane layout

function computeLayout(nodes: IssueWithStatus[], edges: Dependency[]): Node[] {
  if (nodes.length === 0) return [];

  const hasEdges = edges.length > 0;

  if (hasEdges) {
    // Dependency-based topological layout
    const outEdges = new Map<string, string[]>();
    const inDegree = new Map<string, number>();
    for (const n of nodes) {
      outEdges.set(n.id, []);
      inDegree.set(n.id, 0);
    }
    for (const e of edges) {
      if (outEdges.has(e.dependsOnId) && outEdges.has(e.issueId)) {
        outEdges.get(e.dependsOnId)!.push(e.issueId);
        inDegree.set(e.issueId, (inDegree.get(e.issueId) ?? 0) + 1);
      }
    }

    const levels = new Map<string, number>();
    const queue: string[] = [];
    for (const [id, deg] of inDegree) {
      if (deg === 0) queue.push(id);
    }
    while (queue.length > 0) {
      const id = queue.shift()!;
      const level = levels.get(id) ?? 0;
      for (const next of outEdges.get(id) ?? []) {
        const nextLevel = Math.max(levels.get(next) ?? 0, level + 1);
        levels.set(next, nextLevel);
        const deg = (inDegree.get(next) ?? 1) - 1;
        inDegree.set(next, deg);
        if (deg === 0) queue.push(next);
      }
    }
    for (const n of nodes) {
      if (!levels.has(n.id)) levels.set(n.id, 0);
    }

    const byLevel = new Map<number, IssueWithStatus[]>();
    for (const n of nodes) {
      const lv = levels.get(n.id) ?? 0;
      if (!byLevel.has(lv)) byLevel.set(lv, []);
      byLevel.get(lv)!.push(n);
    }

    const result: Node[] = [];
    const sortedLevels = Array.from(byLevel.keys()).sort((a, b) => a - b);
    let levelX = 40;
    for (const lv of sortedLevels) {
      const group = byLevel.get(lv)!;
      for (let i = 0; i < group.length; i++) {
        const subCol = Math.floor(i / DEPENDENCY_ROWS_PER_COLUMN);
        const row = i % DEPENDENCY_ROWS_PER_COLUMN;
        const x = levelX + subCol * (NODE_W + H_GAP);
        const y = row * (NODE_H + V_GAP) + 40;
        result.push({ id: group[i].id, x, y, issue: group[i] });
      }
      const levelCols = Math.max(1, Math.ceil(group.length / DEPENDENCY_ROWS_PER_COLUMN));
      levelX += levelCols * (NODE_W + H_GAP) + BAND_GAP;
    }
    return result;
  }

  // Status-based swimlane layout (no dependency edges)
  const byStatus = new Map<string, IssueWithStatus[]>();
  for (const n of nodes) {
    const s = n.statusName;
    if (!byStatus.has(s)) byStatus.set(s, []);
    byStatus.get(s)!.push(n);
  }

  // Order columns by STATUS_ORDER, then any remaining statuses alphabetically
  const knownOrder = STATUS_ORDER.filter((s) => byStatus.has(s));
  const extraStatuses = [...byStatus.keys()]
    .filter((s) => !STATUS_ORDER.includes(s))
    .sort();
  const orderedStatuses = [...knownOrder, ...extraStatuses];

  const result: Node[] = [];
  let swimlaneX = 40;
  for (let col = 0; col < orderedStatuses.length; col++) {
    const status = orderedStatuses[col];
    const group = byStatus.get(status)!;
    for (let i = 0; i < group.length; i++) {
      const subCol = i % SWIMLANE_NODES_PER_ROW;
      const row = Math.floor(i / SWIMLANE_NODES_PER_ROW);
      const x = swimlaneX + subCol * (NODE_W + H_GAP);
      const y = row * (NODE_H + V_GAP) + COL_HEADER_H + 48;
      result.push({ id: group[i].id, x, y, issue: group[i] });
    }
    const subCols = Math.min(group.length, SWIMLANE_NODES_PER_ROW);
    swimlaneX += subCols * (NODE_W + H_GAP) + BAND_GAP;
  }
  return result;
}

/** Column headers for the status-based layout (no edges mode) */
function computeColumns(nodes: IssueWithStatus[], edges: Dependency[]) {
  if (edges.length > 0 || nodes.length === 0) return [];
  const byStatus = new Map<string, number>();
  for (const n of nodes) {
    byStatus.set(n.statusName, (byStatus.get(n.statusName) ?? 0) + 1);
  }
  const knownOrder = STATUS_ORDER.filter((s) => byStatus.has(s));
  const extraStatuses = [...byStatus.keys()]
    .filter((s) => !STATUS_ORDER.includes(s))
    .sort();
  const orderedStatuses = [...knownOrder, ...extraStatuses];
  const result = [];
  let swimlaneX = 40;
  for (const status of orderedStatuses) {
    const count = byStatus.get(status) ?? 0;
    result.push({ status, count, x: swimlaneX });
    const subCols = Math.min(count, SWIMLANE_NODES_PER_ROW);
    swimlaneX += subCols * (NODE_W + H_GAP) + BAND_GAP;
  }
  return result;
}

const BACKLOG_STATUS_NAME = "Backlog";
const ARCHIVE_STATUS_NAMES = new Set(["Done", "Cancelled"]);
const DEFAULT_HIDDEN_STATUS_NAMES = new Set([BACKLOG_STATUS_NAME, ...ARCHIVE_STATUS_NAMES]);

function orderedStatusNames(statusNames: string[]) {
  const unique = [...new Set(statusNames)];
  const knownOrder = STATUS_ORDER.filter((s) => unique.includes(s));
  const extraStatuses = unique
    .filter((s) => !STATUS_ORDER.includes(s))
    .sort();
  return [...knownOrder, ...extraStatuses];
}

type GraphMode = "dependency" | "critical-path";

interface GraphViewProps {
  columns: StatusWithIssues[];
  projectId: string;
  onIssueClick: (issue: IssueWithStatus) => void;
  searchQuery?: string;
}

interface GraphFilterControlsProps {
  statusFilters: string[];
  statusNames: string[];
  onStatusFiltersChange: (statuses: string[]) => void;
  graphMode: GraphMode;
  onGraphModeChange: (mode: GraphMode) => void;
  hasBlockingEdges: boolean;
}

function GraphFilterControls({ statusFilters, statusNames, onStatusFiltersChange, graphMode, onGraphModeChange, hasBlockingEdges }: GraphFilterControlsProps) {
  return (
    <div className="absolute top-3 left-3 z-10 flex items-center gap-2 rounded-md border border-gray-200 bg-white/95 px-2.5 py-1.5 shadow-sm dark:border-gray-700 dark:bg-gray-900/95">
      {hasBlockingEdges && (
        <div className="flex items-center gap-0.5 mr-1">
          <button
            onClick={() => onGraphModeChange("dependency")}
            className={`text-xs px-2 py-0.5 rounded ${graphMode === "dependency" ? "bg-brand-600 text-white" : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"}`}
          >Graph</button>
          <button
            onClick={() => onGraphModeChange("critical-path")}
            className={`text-xs px-2 py-0.5 rounded ${graphMode === "critical-path" ? "bg-brand-600 text-white" : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"}`}
            title="Show critical blocking chains"
          >Critical Path</button>
        </div>
      )}
      <span className="text-xs font-medium text-gray-500 dark:text-gray-400">Status</span>
      <select
        multiple
        size={Math.min(statusNames.length + 2, 5)}
        value={statusFilters}
        onChange={(e) => {
          const selected = Array.from(e.target.selectedOptions, (option) => option.value);
          if (selected.includes("all")) {
            onStatusFiltersChange(["all"]);
            return;
          }
          const statuses = selected.filter((status) => status !== "active");
          onStatusFiltersChange(statuses.length > 0 ? statuses : ["active"]);
        }}
        className="min-w-32 text-xs border border-gray-200 dark:border-gray-700 rounded px-2 py-1 bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-300"
        aria-label="Graph status filter"
      >
        <option value="active">Active only</option>
        <option value="all">All statuses</option>
        {statusNames.map((s) => (
          <option key={s} value={s}>{s}</option>
        ))}
      </select>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Critical Path Side Panel
// ---------------------------------------------------------------------------

interface CriticalPathSidePanelProps {
  chainRoot: string;
  criticalPathResult: CriticalPathResult;
  nodeIssueMap: Map<string, IssueWithStatus>;
  onClose: () => void;
  onIssueClick: (issue: IssueWithStatus) => void;
}

function CriticalPathSidePanel({ chainRoot, criticalPathResult, nodeIssueMap, onClose, onIssueClick }: CriticalPathSidePanelProps) {
  const chain = criticalPathResult.chainsByRoot.get(chainRoot);
  const rootBlocker = criticalPathResult.rootBlockers.find((r) => r.id === chainRoot);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  if (!chain || chain.length === 0) return null;

  const rootIssue = nodeIssueMap.get(chainRoot);

  return (
    <div className="absolute top-0 right-0 bottom-0 z-20 animate-slide-in-right" style={{ width: 320 }}>
      <div ref={panelRef} className="h-full bg-white dark:bg-gray-900 border-l border-gray-200 dark:border-gray-700 shadow-lg flex flex-col">
        {/* Header */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-200 dark:border-gray-700">
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">
              Critical Path
            </h3>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {rootBlocker ? `${rootBlocker.downstreamCount} issue${rootBlocker.downstreamCount !== 1 ? "s" : ""} blocked downstream` : "Chain details"}
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded px-1.5 py-0.5 text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800 text-sm"
          >
            ✕
          </button>
        </div>

        {/* Chain steps */}
        <div className="flex-1 overflow-y-auto px-3 py-2">
          {chain.map((step: ChainStep, idx: number) => {
            const isRoot = idx === 0;
            return (
              <div key={step.id}>
                <button
                  onClick={() => {
                    const issue = nodeIssueMap.get(step.id);
                    if (issue) onIssueClick(issue);
                  }}
                  className={`w-full text-left rounded-md px-2.5 py-2 mb-0.5 transition-colors ${
                    isRoot
                      ? "bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800"
                      : "hover:bg-gray-50 dark:hover:bg-gray-800 border border-transparent"
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    {step.issueNumber != null && (
                      <span className="text-[10px] font-mono text-gray-400">#{step.issueNumber}</span>
                    )}
                    <span className="text-xs font-medium text-gray-800 dark:text-gray-200 truncate">
                      {step.title}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span
                      className="w-1.5 h-1.5 rounded-full inline-block"
                      style={{ background: STATUS_COLORS[step.statusName] ?? "#6b7280" }}
                    />
                    <span className="text-[10px] text-gray-500 dark:text-gray-400">{step.statusName}</span>
                    {isRoot && (
                      <span className="text-[10px] px-1 py-0.5 rounded bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300 ml-auto">
                        root blocker
                      </span>
                    )}
                    {step.isBlocked && !isRoot && (
                      <span className="text-[10px] px-1 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300 ml-auto">
                        blocked
                      </span>
                    )}
                  </div>
                </button>
                {/* Connector arrow */}
                {idx < chain.length - 1 && (
                  <div className="flex items-center justify-center py-0.5">
                    <svg width="12" height="12" viewBox="0 0 12 12" className="text-gray-300 dark:text-gray-600">
                      <path d="M6 2 L6 8 M3 6 L6 9 L9 6" stroke="currentColor" strokeWidth="1.5" fill="none" />
                    </svg>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Best unblock callout */}
        {criticalPathResult.bestUnblock && (
          <div className="border-t border-gray-200 dark:border-gray-700 px-3 py-2.5 bg-amber-50 dark:bg-amber-900/20">
            <div className="text-[10px] font-semibold text-amber-700 dark:text-amber-300 uppercase tracking-wide mb-1">
              Next best unblock
            </div>
            <button
              onClick={() => {
                const issue = nodeIssueMap.get(criticalPathResult.bestUnblock!.id);
                if (issue) onIssueClick(issue);
              }}
              className="w-full text-left"
            >
              <span className="text-xs text-gray-800 dark:text-gray-200">
                Resolve{" "}
                {(() => {
                  const bi = nodeIssueMap.get(criticalPathResult.bestUnblock.id);
                  return bi ? (
                    <>
                      {bi.issueNumber != null && <span className="font-mono text-gray-500">#{bi.issueNumber}</span>}
                      {" "}{bi.title.length > 32 ? bi.title.slice(0, 32) + "…" : bi.title}
                    </>
                  ) : "this issue";
                })()}
              </span>
              <span className="block text-[10px] text-amber-600 dark:text-amber-400 mt-0.5">
                to unblock {criticalPathResult.bestUnblock.downstreamCount} issue{criticalPathResult.bestUnblock.downstreamCount !== 1 ? "s" : ""}
              </span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main GraphView component
// ---------------------------------------------------------------------------

export function GraphView({ columns, projectId, onIssueClick, searchQuery }: GraphViewProps) {
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusFilters, setStatusFilters] = useState<string[]>(["active"]);
  const [graphMode, setGraphMode] = useState<GraphMode>("dependency");
  const [selectedChainRoot, setSelectedChainRoot] = useState<string | null>(null);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [colHeaders, setColHeaders] = useState<{ status: string; count: number; x: number }[]>([]);
  const [dragNode, setDragNode] = useState<string | null>(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const didDragRef = useRef(false);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef({ x: 0, y: 0 });
  const panOrigin = useRef({ x: 0, y: 0 });
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);

  const allIssues = columns.flatMap((c) => c.issues);
  const statusNames = orderedStatusNames([
    ...columns.map((c) => c.name),
    ...(graphData?.nodes.map((n) => n.statusName) ?? []),
  ]);

  // Whether there are any blocking edges (depends_on or blocked_by)
  const hasBlockingEdges = useMemo(() => {
    if (!graphData) return false;
    return graphData.edges.some((e) => e.type === "depends_on" || e.type === "blocked_by");
  }, [graphData]);

  // Compute critical path analysis when in critical-path mode
  const criticalPathResult = useMemo<CriticalPathResult | null>(() => {
    if (graphMode !== "critical-path" || !graphData) return null;
    return computeCriticalPath(graphData.nodes, graphData.edges);
  }, [graphMode, graphData]);

  useEffect(() => {
    async function load() {
      try {
        setLoading(true);
        const result = await apiFetch<{ nodes: IssueWithStatus[]; edges: Dependency[] }>(
          `/api/projects/${projectId}/graph`
        );
        setGraphData(result);
      } catch {
        setGraphData({ nodes: allIssues, edges: [] });
      } finally {
        setLoading(false);
      }
    }
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, columns]);

  useLayoutEffect(() => {
    if (!graphData) return;
    const visibleStatuses = new Set(statusFilters);
    const visibleNodes = graphData.nodes.filter((n) => {
      if (visibleStatuses.has("all")) return true;
      if (visibleStatuses.has("active")) return !DEFAULT_HIDDEN_STATUS_NAMES.has(n.statusName);
      return visibleStatuses.has(n.statusName);
    });
    const filtered = searchQuery
      ? visibleNodes.filter(
          (n) =>
            n.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
            n.description?.toLowerCase().includes(searchQuery.toLowerCase())
        )
      : visibleNodes;
    const filteredIds = new Set(filtered.map((n) => n.id));
    const filteredEdges = graphData.edges.filter(
      (e) => filteredIds.has(e.issueId) && filteredIds.has(e.dependsOnId)
    );
    const laid = computeLayout(filtered, filteredEdges);
    setNodes(laid);
    setColHeaders(computeColumns(filtered, filteredEdges));

    // Auto-fit after layout is set — defer so the container has rendered
    requestAnimationFrame(() => {
      if (laid.length === 0 || !containerRef.current) return;
      const cw = containerRef.current.clientWidth;
      const ch = containerRef.current.clientHeight;
      if (cw === 0 || ch === 0) return;
      const minX = Math.min(...laid.map((n) => n.x));
      const minY = Math.min(...laid.map((n) => n.y));
      const maxX = Math.max(...laid.map((n) => n.x + NODE_W));
      const maxY = Math.max(...laid.map((n) => n.y + NODE_H));
      const contentW = maxX - minX + 80;
      const contentH = maxY - minY + 80;
      const z = Math.max(0.1, Math.min(cw / contentW, ch / contentH));
      const px = (cw - contentW * z) / 2 - minX * z + 40 * z;
      const py = (ch - contentH * z) / 2 - minY * z + 40 * z;
      setZoom(z);
      setPan({ x: px, y: py });
    });
  }, [graphData, searchQuery, statusFilters]);

  const fitView = useCallback(() => {
    if (nodes.length === 0 || !containerRef.current) return;
    const cw = containerRef.current.clientWidth;
    const ch = containerRef.current.clientHeight;
    const minX = Math.min(...nodes.map((n) => n.x));
    const minY = Math.min(...nodes.map((n) => n.y));
    const maxX = Math.max(...nodes.map((n) => n.x + NODE_W));
    const maxY = Math.max(...nodes.map((n) => n.y + NODE_H));
    const contentW = maxX - minX + 80;
    const contentH = maxY - minY + 80;
    const z = Math.max(0.1, Math.min(cw / contentW, ch / contentH));
    const px = (cw - contentW * z) / 2 - minX * z + 40 * z;
    const py = (ch - contentH * z) / 2 - minY * z + 40 * z;
    setZoom(z);
    setPan({ x: px, y: py });
  }, [nodes]);

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  // Precompute critical-path lookup sets for rendering
  const rootBlockerIds = useMemo(() => {
    if (!criticalPathResult) return new Set<string>();
    return new Set(criticalPathResult.rootBlockers.map((r) => r.id));
  }, [criticalPathResult]);

  const downstreamCountMap = useMemo(() => {
    if (!criticalPathResult) return new Map<string, number>();
    return new Map(criticalPathResult.rootBlockers.map((r) => [r.id, r.downstreamCount]));
  }, [criticalPathResult]);

  // Map from chain step id to its root (for chain highlighting when a root is selected)
  const selectedChainIds = useMemo(() => {
    if (!selectedChainRoot || !criticalPathResult) return new Set<string>();
    const chain = criticalPathResult.chainsByRoot.get(selectedChainRoot);
    return chain ? new Set(chain.map((s) => s.id)) : new Set<string>();
  }, [selectedChainRoot, criticalPathResult]);

  // Map from edge key to whether it's in the selected chain
  const selectedChainEdgeKeys = useMemo(() => {
    if (!selectedChainRoot || !criticalPathResult) return new Set<string>();
    const chain = criticalPathResult.chainsByRoot.get(selectedChainRoot);
    if (!chain || chain.length < 2) return new Set<string>();
    const keys = new Set<string>();
    for (let i = 0; i < chain.length - 1; i++) {
      keys.add(`${chain[i].id}->${chain[i + 1].id}`);
    }
    return keys;
  }, [selectedChainRoot, criticalPathResult]);

  function getEdges() {
    if (!graphData) return [];
    return graphData.edges.filter(
      (e) => nodeMap.has(e.issueId) && nodeMap.has(e.dependsOnId)
    );
  }

  function svgPoint(e: React.MouseEvent): { x: number; y: number } {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left - pan.x) / zoom,
      y: (e.clientY - rect.top - pan.y) / zoom,
    };
  }

  function handleMouseDownNode(e: React.MouseEvent, nodeId: string) {
    e.stopPropagation();
    const pt = svgPoint(e);
    const node = nodeMap.get(nodeId)!;
    didDragRef.current = false;
    setDragNode(nodeId);
    setDragOffset({ x: pt.x - node.x, y: pt.y - node.y });
    setSelectedNode(nodeId);
  }

  function handleMouseMoveSvg(e: React.MouseEvent) {
    if (dragNode) {
      didDragRef.current = true;
      const pt = svgPoint(e);
      setNodes((prev) =>
        prev.map((n) =>
          n.id === dragNode
            ? { ...n, x: pt.x - dragOffset.x, y: pt.y - dragOffset.y }
            : n
        )
      );
    } else if (isPanning) {
      setPan({
        x: panOrigin.current.x + (e.clientX - panStart.current.x),
        y: panOrigin.current.y + (e.clientY - panStart.current.y),
      });
    }
  }

  function handleMouseUpSvg() {
    setDragNode(null);
    setIsPanning(false);
  }

  function handleMouseDownSvg(e: React.MouseEvent) {
    if ((e.target as SVGElement).closest("[data-node]")) return;
    setIsPanning(true);
    panStart.current = { x: e.clientX, y: e.clientY };
    panOrigin.current = { x: pan.x, y: pan.y };
  }

  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    setZoom((z) => Math.min(3, Math.max(0.1, z * factor)));
  }, []);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    svg.addEventListener("wheel", handleWheel, { passive: false });
    return () => svg.removeEventListener("wheel", handleWheel);
  }, [handleWheel]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500 dark:text-gray-400 text-sm">
        Loading graph…
      </div>
    );
  }

  if (nodes.length === 0) {
    return (
      <div ref={containerRef} className="relative h-full w-full overflow-hidden bg-gray-50 dark:bg-gray-950 select-none">
        <GraphFilterControls
          statusFilters={statusFilters}
          statusNames={statusNames}
          onStatusFiltersChange={setStatusFilters}
          graphMode={graphMode}
          onGraphModeChange={setGraphMode}
          hasBlockingEdges={hasBlockingEdges}
        />
        <div className="flex h-full flex-col items-center justify-center gap-3 text-gray-500 dark:text-gray-400 text-sm">
          <span>No issues to display</span>
        </div>
      </div>
    );
  }

  const edges = getEdges();
  const isCriticalPathMode = graphMode === "critical-path" && criticalPathResult !== null;

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden bg-gray-50 dark:bg-gray-950 select-none">
      <GraphFilterControls
        statusFilters={statusFilters}
        statusNames={statusNames}
        onStatusFiltersChange={setStatusFilters}
        graphMode={graphMode}
        onGraphModeChange={(mode) => {
          setGraphMode(mode);
          if (mode === "dependency") setSelectedChainRoot(null);
        }}
        hasBlockingEdges={hasBlockingEdges}
      />
      {/* Controls */}
      <div className="absolute top-3 right-3 z-10 flex flex-col gap-1">
        <button
          onClick={() => setZoom((z) => Math.min(3, z * 1.2))}
          className="w-7 h-7 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 flex items-center justify-center text-sm font-bold shadow-sm"
        >+</button>
        <button
          onClick={() => setZoom((z) => Math.max(0.1, z * 0.8))}
          className="w-7 h-7 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 flex items-center justify-center text-sm font-bold shadow-sm"
        >−</button>
        <button
          onClick={fitView}
          className="w-7 h-7 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 flex items-center justify-center shadow-sm"
          title="Fit to view"
        >
          <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
            <path d="M3 3v5h5" />
          </svg>
        </button>
      </div>
      {/* Legend */}
      <div className="absolute bottom-3 left-3 z-10 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-md p-2 shadow-sm text-xs text-gray-600 dark:text-gray-400 space-y-1">
        {isCriticalPathMode ? (
          <>
            <div className="font-medium text-gray-700 dark:text-gray-300 mb-1">Critical Path</div>
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full inline-block shrink-0" style={{ background: ROOT_BLOCKER_COLOR }} />
              Root blocker
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded inline-block shrink-0 border-2 border-dashed" style={{ borderColor: CYCLE_COLOR }} />
              Cycle
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full inline-block shrink-0" style={{ background: CHAIN_EDGE_COLOR }} />
              Blocking edge
            </div>
            {criticalPathResult!.rootBlockers.length === 0 && (
              <div className="text-gray-400 italic mt-1">No blocking chains found</div>
            )}
          </>
        ) : (
          <>
            <div className="font-medium text-gray-700 dark:text-gray-300 mb-1">Status</div>
            {Object.entries(STATUS_COLORS).map(([name, color]) => (
              <div key={name} className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full inline-block shrink-0" style={{ background: color }} />
                {name}
              </div>
            ))}
          </>
        )}
      </div>

      {/* Best unblock callout (critical-path mode only) */}
      {isCriticalPathMode && criticalPathResult!.bestUnblock && (() => {
        const best = criticalPathResult!.bestUnblock;
        const bestIssue = nodeMap.get(best.id)?.issue;
        return (
          <div
            className="absolute bottom-3 right-3 z-10 bg-white dark:bg-gray-900 border border-amber-300 dark:border-amber-700 rounded-md p-2.5 shadow-sm text-xs cursor-pointer hover:border-amber-400 transition-colors max-w-56"
            onClick={() => {
              setSelectedChainRoot(best.id);
              if (bestIssue) onIssueClick(bestIssue);
            }}
          >
            <div className="text-[10px] font-semibold text-amber-700 dark:text-amber-300 uppercase tracking-wide mb-0.5">
              Next best unblock
            </div>
            <div className="text-gray-800 dark:text-gray-200">
              {bestIssue?.issueNumber != null && <span className="font-mono text-gray-500">#{bestIssue.issueNumber}</span>}
              {" "}{bestIssue ? (bestIssue.title.length > 30 ? bestIssue.title.slice(0, 30) + "…" : bestIssue.title) : "this issue"}
            </div>
            <div className="text-amber-600 dark:text-amber-400 mt-0.5">
              → {best.downstreamCount} issue{best.downstreamCount !== 1 ? "s" : ""} downstream
            </div>
          </div>
        );
      })()}

      <svg
        ref={svgRef}
        className="w-full h-full"
        style={{ cursor: isPanning ? "grabbing" : dragNode ? "grabbing" : "grab" }}
        onMouseMove={handleMouseMoveSvg}
        onMouseUp={handleMouseUpSvg}
        onMouseLeave={handleMouseUpSvg}
        onMouseDown={handleMouseDownSvg}
      >
        <defs>
          <marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
            <path d="M0,0 L0,6 L8,3 z" fill="#9ca3af" />
          </marker>
          {Object.entries(DEPENDENCY_COLORS).map(([type, color]) => (
            <marker key={type} id={`arrow-${type}`} markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
              <path d="M0,0 L0,6 L8,3 z" fill={color} />
            </marker>
          ))}
          {/* Critical-path chain edge arrow */}
          <marker id="arrow-critical-chain" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
            <path d="M0,0 L0,6 L8,3 z" fill={CHAIN_EDGE_COLOR} />
          </marker>
        </defs>
        <g transform={`translate(${pan.x},${pan.y}) scale(${zoom})`}>
          {/* Column headers (status swimlane mode) */}
          {colHeaders.map(({ status, count, x }) => {
            const color = STATUS_COLORS[status] ?? "#6b7280";
            const subCols = Math.min(count, SWIMLANE_NODES_PER_ROW);
            const headerW = subCols * NODE_W + (subCols - 1) * H_GAP;
            return (
              <g key={status}>
                <rect
                  x={x}
                  y={8}
                  width={headerW}
                  height={COL_HEADER_H}
                  rx={5}
                  fill={color}
                  opacity={0.12}
                />
                <rect x={x} y={8} width={4} height={COL_HEADER_H} rx={2} fill={color} />
                <text x={x + 12} y={8 + COL_HEADER_H / 2 + 4} fontSize={11} fontWeight={600} fill={color}>
                  {status}
                </text>
                <text x={x + headerW - 8} y={8 + COL_HEADER_H / 2 + 4} fontSize={10} fill={color} textAnchor="end" opacity={0.7}>
                  {count}
                </text>
              </g>
            );
          })}
          {/* Edges */}
          {edges.map((edge) => {
            const src = nodeMap.get(edge.dependsOnId);
            const dst = nodeMap.get(edge.issueId);
            if (!src || !dst) return null;
            const x1 = src.x + NODE_W;
            const y1 = src.y + NODE_H / 2;
            const x2 = dst.x;
            const y2 = dst.y + NODE_H / 2;
            const mx = (x1 + x2) / 2;
            const isBlockingEdge = edge.type === "depends_on" || edge.type === "blocked_by";

            // Critical-path mode: highlight chain edges, dim non-chain
            if (isCriticalPathMode) {
              const isInSelectedChain = selectedChainRoot
                ? selectedChainEdgeKeys.has(`${edge.dependsOnId}->${edge.issueId}`)
                : isBlockingEdge && criticalPathResult!.chainNodeIds.has(edge.dependsOnId) && criticalPathResult!.chainNodeIds.has(edge.issueId);
              const edgeOpacity = isInSelectedChain ? 0.9 : (isBlockingEdge ? 0.25 : 0.1);
              const edgeStroke = isInSelectedChain ? CHAIN_EDGE_COLOR : (isBlockingEdge ? "#d17d54" : "#d1d5db");
              const edgeWidth = isInSelectedChain ? 3 : 1.5;
              const markerRef = isInSelectedChain ? "url(#arrow-critical-chain)" : `url(#arrow-${edge.type})`;

              return (
                <g key={edge.id}>
                  <path
                    d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`}
                    fill="none"
                    stroke={edgeStroke}
                    strokeWidth={edgeWidth}
                    opacity={edgeOpacity}
                    markerEnd={markerRef}
                  />
                </g>
              );
            }

            const color = DEPENDENCY_COLORS[edge.type] ?? "#9ca3af";
            return (
              <g key={edge.id}>
                <path
                  d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`}
                  fill="none"
                  stroke={color}
                  strokeWidth={1.5}
                  opacity={0.7}
                  markerEnd={`url(#arrow-${edge.type})`}
                />
                <text
                  x={mx}
                  y={(y1 + y2) / 2 - 4}
                  fontSize={9}
                  fill={color}
                  textAnchor="middle"
                  opacity={0.8}
                >
                  {edge.type.replace("_", " ")}
                </text>
              </g>
            );
          })}
          {/* Nodes */}
          {nodes.map((node) => {
            const color = STATUS_COLORS[node.issue.statusName] ?? "#6b7280";
            const isSelected = selectedNode === node.id;
            const isHighlighted = searchQuery
              ? node.issue.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
                (node.issue.description?.toLowerCase().includes(searchQuery.toLowerCase()) ?? false)
              : true;
            const title = node.issue.title;
            const displayTitle = title.length > 28 ? title.slice(0, 28) + "…" : title;

            // Critical-path mode visual overrides
            let nodeOpacity = isHighlighted ? 1 : 0.3;
            let nodeStroke = isSelected ? BRAND : color;
            let nodeStrokeWidth = isSelected ? 2 : 1.5;
            let nodeStrokeDasharray: string | undefined;
            let isRootBlocker = false;
            let downstreamBadge: number | null = null;

            if (isCriticalPathMode) {
              const isChainNode = criticalPathResult!.chainNodeIds.has(node.id);
              const isCycleNode = criticalPathResult!.cycleNodeIds.has(node.id);
              isRootBlocker = rootBlockerIds.has(node.id);
              const isInSelectedChain = selectedChainRoot
                ? selectedChainIds.has(node.id)
                : isChainNode;

              if (isCycleNode) {
                nodeStroke = CYCLE_COLOR;
                nodeStrokeWidth = 2;
                nodeStrokeDasharray = "4 2";
                nodeOpacity = 0.6;
              } else if (isRootBlocker) {
                nodeStroke = ROOT_BLOCKER_COLOR;
                nodeStrokeWidth = 3;
                downstreamBadge = downstreamCountMap.get(node.id) ?? null;
                nodeOpacity = 1;
              } else if (isInSelectedChain) {
                nodeStroke = isSelected ? BRAND : color;
                nodeOpacity = 1;
              } else if (isChainNode) {
                nodeOpacity = 0.5;
              } else {
                nodeOpacity = 0.2;
              }

              // If a chain root is selected, highlight its chain strongly
              if (selectedChainRoot) {
                if (isInSelectedChain || isRootBlocker) {
                  nodeOpacity = 1;
                } else {
                  nodeOpacity = 0.15;
                }
              }
            }

            return (
              <g
                key={node.id}
                data-node
                data-critical-path-root={isRootBlocker || undefined}
                data-critical-path-chain={isCriticalPathMode && criticalPathResult!.chainNodeIds.has(node.id) || undefined}
                transform={`translate(${node.x},${node.y})`}
                style={{ cursor: "pointer", opacity: nodeOpacity }}
                onMouseDown={(e) => handleMouseDownNode(e, node.id)}
                onClick={(e) => {
                  e.stopPropagation();
                  if (didDragRef.current) return;
                  if (isCriticalPathMode && isRootBlocker) {
                    setSelectedChainRoot(selectedChainRoot === node.id ? null : node.id);
                  }
                  onIssueClick(node.issue);
                }}
              >
                <rect
                  width={NODE_W}
                  height={NODE_H}
                  rx={6}
                  ry={6}
                  fill="white"
                  stroke={nodeStroke}
                  strokeWidth={nodeStrokeWidth}
                  strokeDasharray={nodeStrokeDasharray}
                  filter="drop-shadow(0 1px 3px rgba(0,0,0,0.12))"
                />
                {/* Status indicator bar */}
                <rect width={4} height={NODE_H} rx={3} fill={color} />
                {/* Priority dot */}
                <circle
                  cx={NODE_W - 12}
                  cy={12}
                  r={4}
                  fill={
                    node.issue.issueType === "bug" ? TYPE_COLORS.bug :
                    node.issue.issueType === "feature" ? TYPE_COLORS.feature :
                    node.issue.issueType === "chore" ? TYPE_COLORS.chore : "#a8a195"
                  }
                />
                {/* Issue number */}
                {node.issue.issueNumber != null && (
                  <text x={12} y={18} fontSize={9} fill="#9ca3af" fontFamily="monospace">
                    #{node.issue.issueNumber}
                  </text>
                )}
                {/* Title */}
                <text x={12} y={36} fontSize={11} fill="#111827" fontWeight={500}>
                  {displayTitle}
                </text>
                {/* Status label */}
                <text x={12} y={54} fontSize={9} fill={color}>
                  {node.issue.statusName}
                </text>
                {/* Blocked indicator */}
                {node.issue.isBlocked && !isCriticalPathMode && (
                  <text x={NODE_W - 22} y={NODE_H - 6} fontSize={9} fill="#f59e0b">⚠</text>
                )}
                {/* Cycle label */}
                {isCriticalPathMode && criticalPathResult!.cycleNodeIds.has(node.id) && (
                  <text x={NODE_W - 40} y={NODE_H - 6} fontSize={8} fill={CYCLE_COLOR}>cycle</text>
                )}
                {/* Downstream count badge (root blockers in critical-path mode) */}
                {downstreamBadge != null && downstreamBadge > 0 && (
                  <>
                    <circle
                      cx={NODE_W - 8}
                      cy={-4}
                      r={9}
                      fill={ROOT_BLOCKER_COLOR}
                      stroke="white"
                      strokeWidth={1.5}
                    />
                    <text
                      x={NODE_W - 8}
                      y={-0.5}
                      fontSize={8}
                      fill="white"
                      fontWeight={700}
                      textAnchor="middle"
                    >
                      {downstreamBadge > 99 ? "99+" : downstreamBadge}
                    </text>
                  </>
                )}
              </g>
            );
          })}
        </g>
      </svg>

      {/* Critical-path side panel */}
      {isCriticalPathMode && selectedChainRoot && criticalPathResult && (
        <CriticalPathSidePanel
          chainRoot={selectedChainRoot}
          criticalPathResult={criticalPathResult}
          nodeIssueMap={new Map(nodes.map((n) => [n.id, n.issue]))}
          onClose={() => setSelectedChainRoot(null)}
          onIssueClick={onIssueClick}
        />
      )}
    </div>
  );
}

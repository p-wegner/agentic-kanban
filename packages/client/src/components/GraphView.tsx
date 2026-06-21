import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";
import { apiFetch, apiPost, apiDelete } from "../lib/api.js";
import { STATUS_COLORS } from "../lib/chartColors";
import { computeCriticalPath, type CriticalPathResult } from "../lib/criticalPath.js";
import {
  CHAIN_EDGE_COLOR,
  COL_HEADER_H,
  CYCLE_COLOR,
  DEPENDENCY_COLORS,
  H_GAP,
  NODE_H,
  NODE_W,
  ROOT_BLOCKER_COLOR,
  SWIMLANE_NODES_PER_ROW,
  computeColumns,
  computeLayout,
  orderedStatusNames,
  type Dependency,
  type DependencyType,
  type Node,
} from "../lib/graphLayout.js";
import { AddEdgePanel } from "./AddEdgePanel.js";
import { CriticalPathSidePanel } from "./CriticalPathSidePanel.js";
import { EdgeEditPanel } from "./EdgeEditPanel.js";
import { GraphEdges } from "./GraphEdges.js";
import { GraphNodes } from "./GraphNodes.js";

interface GraphData {
  nodes: IssueWithStatus[];
  edges: Dependency[];
}

const BACKLOG_STATUS_NAME = "Backlog";
const ARCHIVE_STATUS_NAMES = new Set(["Done", "Cancelled"]);
const DEFAULT_HIDDEN_STATUS_NAMES = new Set([BACKLOG_STATUS_NAME, ...ARCHIVE_STATUS_NAMES]);

type GraphMode = "dependency" | "critical-path";

interface GraphViewProps {
  columns: StatusWithIssues[];
  projectId: string;
  onIssueClick: (issue: IssueWithStatus) => void;
  searchQuery?: string;
  /** When set, the graph scrolls to and highlights this issue on first render. */
  focusIssueId?: string;
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
// Main GraphView component
// ---------------------------------------------------------------------------

export function GraphView({ columns, projectId, onIssueClick, searchQuery, focusIssueId }: GraphViewProps) {
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
  const [selectedEdge, setSelectedEdge] = useState<Dependency | null>(null);
  const [addingEdge, setAddingEdge] = useState(false);
  const [addEdgeSourceId, setAddEdgeSourceId] = useState<string | null>(null);

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
    void load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, columns]);

  // IDs of nodes that participate in at least one edge (have ≥1 dependency).
  const nodesWithDepsIds = useMemo(() => {
    if (!graphData) return new Set<string>();
    const ids = new Set<string>();
    for (const e of graphData.edges) {
      ids.add(e.issueId);
      ids.add(e.dependsOnId);
    }
    return ids;
  }, [graphData]);

  useLayoutEffect(() => {
    if (!graphData) return;
    const visibleStatuses = new Set(statusFilters);
    const statusFiltered = graphData.nodes.filter((n) => {
      if (visibleStatuses.has("all")) return true;
      if (visibleStatuses.has("active")) return !DEFAULT_HIDDEN_STATUS_NAMES.has(n.statusName);
      return visibleStatuses.has(n.statusName);
    });
    // When there are any edges in the project, only show nodes that participate
    // in at least one dependency (the "dependency graph" view).
    const hasAnyEdges = graphData.edges.length > 0;
    const depFiltered = hasAnyEdges
      ? statusFiltered.filter((n) => nodesWithDepsIds.has(n.id))
      : statusFiltered;
    const filtered = searchQuery
      ? depFiltered.filter(
          (n) =>
            n.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
            n.description?.toLowerCase().includes(searchQuery.toLowerCase())
        )
      : depFiltered;
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

      // If a focusIssueId is provided, center on that node instead of fitting all
      if (focusIssueId) {
        const focusNode = laid.find((n) => n.id === focusIssueId);
        if (focusNode) {
          const z = 1;
          const px = cw / 2 - (focusNode.x + NODE_W / 2) * z;
          const py = ch / 2 - (focusNode.y + NODE_H / 2) * z;
          setZoom(z);
          setPan({ x: px, y: py });
          return;
        }
      }

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
  }, [graphData, searchQuery, statusFilters, nodesWithDepsIds, focusIssueId]);

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
  // Full issue map (all loaded issues, not just visible nodes) for edge panel lookups
  const issueMap = useMemo(() => {
    if (!graphData) return new Map<string, IssueWithStatus>();
    return new Map(graphData.nodes.map((n) => [n.id, n]));
  }, [graphData]);

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

  async function reloadGraph() {
    try {
      const result = await apiFetch<{ nodes: IssueWithStatus[]; edges: Dependency[] }>(
        `/api/projects/${projectId}/graph`
      );
      setGraphData(result);
    } catch {
      // silently ignore reload errors — graph stays as-is
    }
  }

  async function handleRemoveEdge(edgeId: string) {
    const edge = graphData?.edges.find((e) => e.id === edgeId);
    if (!edge) throw new Error("Dependency not found");
    await apiDelete(`/api/issues/${edge.issueId}/dependencies/${edgeId}`);
    await reloadGraph();
  }

  async function handleChangeEdgeType(edgeId: string, newType: DependencyType) {
    // Remove the old edge, add a new one with the new type.
    // If the POST fails, restore the original edge so nothing is silently lost.
    const edge = graphData?.edges.find((e) => e.id === edgeId);
    if (!edge) return;
    await apiDelete(`/api/issues/${edge.issueId}/dependencies/${edgeId}`);
    try {
      await apiPost(`/api/issues/${edge.issueId}/dependencies`, { dependsOnId: edge.dependsOnId, type: newType });
    } catch (err) {
      // Rollback: restore the original edge so the graph is not left with a missing edge
      await apiPost(`/api/issues/${edge.issueId}/dependencies`, { dependsOnId: edge.dependsOnId, type: edge.type }).catch(() => {/* best-effort rollback */});
      await reloadGraph();
      throw err;
    }
    // Update selectedEdge with new type so panel stays open and reflects change
    setSelectedEdge({ ...edge, type: newType });
    await reloadGraph();
  }

  async function handleAddEdge(sourceId: string, targetId: string, type: DependencyType) {
    await apiPost(`/api/issues/${targetId}/dependencies`, { dependsOnId: sourceId, type });
    await reloadGraph();
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
    const target = e.target as SVGElement;
    if (target.closest("[data-node]") || target.closest("[data-edge-id]")) return;
    setSelectedEdge(null);
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

  // Empty state: no dependencies defined in this project at all
  if (graphData && graphData.edges.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 bg-gray-50 dark:bg-gray-950 text-gray-500 dark:text-gray-400">
        <svg className="w-12 h-12 opacity-30" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <circle cx="5" cy="12" r="2" />
          <circle cx="19" cy="5" r="2" />
          <circle cx="19" cy="19" r="2" />
          <path d="M7 12h6M15 6.5l-4 4M15 17.5l-4-4" />
        </svg>
        <div className="text-center">
          <p className="text-sm font-medium text-gray-600 dark:text-gray-400">No dependencies defined</p>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">Add dependencies between issues to visualize relationships here.</p>
        </div>
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
          <span>No issues match the current filter</span>
        </div>
      </div>
    );
  }

  const edges = getEdges();
  const isCriticalPathMode = graphMode === "critical-path" && criticalPathResult !== null;

  function handleEdgeClick(edge: Dependency) {
    setSelectedEdge(selectedEdge?.id === edge.id ? null : edge);
    setAddingEdge(false);
  }

  function handleNodeClick(node: Node) {
    // In add-edge mode: first click sets source, second click sets target and opens add panel
    if (addingEdge) {
      if (!addEdgeSourceId) {
        setAddEdgeSourceId(node.id);
      } else if (addEdgeSourceId !== node.id) {
        // Keep the add panel open with source pre-selected; don't navigate away
      }
      return;
    }
    if (isCriticalPathMode && rootBlockerIds.has(node.id)) {
      setSelectedChainRoot(selectedChainRoot === node.id ? null : node.id);
    }
    setSelectedEdge(null);
    onIssueClick(node.issue);
  }

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
          onClick={() => {
            setAddingEdge(true);
            setAddEdgeSourceId(selectedNode);
            setSelectedEdge(null);
          }}
          title="Add dependency"
          aria-label="Add dependency"
          className={`w-7 h-7 border rounded flex items-center justify-center shadow-sm text-sm ${
            addingEdge
              ? "bg-blue-600 border-blue-500 text-white"
              : "bg-white dark:bg-gray-900 border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
          }`}
        >
          <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5}>
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
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
            {criticalPathResult.rootBlockers.length === 0 && (
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
      {isCriticalPathMode && criticalPathResult.bestUnblock && (() => {
        const best = criticalPathResult.bestUnblock;
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
          <GraphEdges
            edges={edges}
            nodeMap={nodeMap}
            isCriticalPathMode={isCriticalPathMode}
            criticalPathResult={criticalPathResult}
            selectedChainRoot={selectedChainRoot}
            selectedChainEdgeKeys={selectedChainEdgeKeys}
            selectedEdge={selectedEdge}
            didDragRef={didDragRef}
            onEdgeClick={handleEdgeClick}
          />
          {/* Nodes */}
          <GraphNodes
            nodes={nodes}
            selectedNode={selectedNode}
            focusIssueId={focusIssueId}
            searchQuery={searchQuery}
            isCriticalPathMode={isCriticalPathMode}
            criticalPathResult={criticalPathResult}
            rootBlockerIds={rootBlockerIds}
            downstreamCountMap={downstreamCountMap}
            selectedChainRoot={selectedChainRoot}
            selectedChainIds={selectedChainIds}
            didDragRef={didDragRef}
            onNodeMouseDown={handleMouseDownNode}
            onNodeClick={handleNodeClick}
          />
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

      {/* Edge edit panel — shown when an edge is selected (dependency mode only) */}
      {!isCriticalPathMode && selectedEdge && (
        <EdgeEditPanel
          edge={selectedEdge}
          sourceIssue={issueMap.get(selectedEdge.dependsOnId) ?? null}
          targetIssue={issueMap.get(selectedEdge.issueId) ?? null}
          onClose={() => setSelectedEdge(null)}
          onRemove={handleRemoveEdge}
          onTypeChange={handleChangeEdgeType}
        />
      )}

      {/* Add edge panel */}
      {addingEdge && (
        <AddEdgePanel
          sourceIssue={addEdgeSourceId ? (issueMap.get(addEdgeSourceId) ?? null) : null}
          allIssues={graphData?.nodes ?? []}
          projectId={projectId}
          onAdd={handleAddEdge}
          onCancel={() => {
            setAddingEdge(false);
            setAddEdgeSourceId(null);
          }}
        />
      )}
    </div>
  );
}

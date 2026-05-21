import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";
import { apiFetch } from "../lib/api.js";

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

const STATUS_COLORS: Record<string, string> = {
  "Todo": "#6b7280",
  "In Progress": "#3b82f6",
  "In Review": "#8b5cf6",
  "AI Reviewed": "#06b6d4",
  "Done": "#22c55e",
  "Cancelled": "#ef4444",
};

// Ordered workflow columns for status-based layout
const STATUS_ORDER = ["Todo", "In Progress", "In Review", "AI Reviewed", "Done", "Cancelled"];

const DEPENDENCY_COLORS: Record<string, string> = {
  depends_on: "#6b7280",
  blocked_by: "#ef4444",
  related_to: "#8b5cf6",
  parent_of: "#f59e0b",
  child_of: "#f59e0b",
  duplicates: "#ec4899",
};

const NODE_W = 220;
const NODE_H = 64;
const H_GAP = 48;
const V_GAP = 16;
const COL_HEADER_H = 28;
const SWIMLANE_NODES_PER_ROW = 2;
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
    for (const lv of sortedLevels) {
      const group = byLevel.get(lv)!;
      const x = lv * (NODE_W + H_GAP) + 40;
      for (let i = 0; i < group.length; i++) {
        const y = i * (NODE_H + V_GAP) + 40;
        result.push({ id: group[i].id, x, y, issue: group[i] });
      }
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

const ARCHIVE_STATUS_NAMES = new Set(["Done", "Cancelled"]);

interface GraphViewProps {
  columns: StatusWithIssues[];
  projectId: string;
  onIssueClick: (issue: IssueWithStatus) => void;
  searchQuery?: string;
}

export function GraphView({ columns, projectId, onIssueClick, searchQuery }: GraphViewProps) {
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(true);
  const [showArchived, setShowArchived] = useState(false);
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
    const visibleNodes = showArchived
      ? graphData.nodes
      : graphData.nodes.filter((n) => !ARCHIVE_STATUS_NAMES.has(n.statusName));
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
  }, [graphData, searchQuery, showArchived]);

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
      <div className="flex items-center justify-center h-full text-gray-500 text-sm">
        Loading graph…
      </div>
    );
  }

  if (nodes.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500 text-sm">
        No issues to display
      </div>
    );
  }

  const edges = getEdges();

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden bg-gray-50 select-none">
      {/* Archive toggle */}
      <div className="absolute top-3 left-3 z-10">
        <button
          onClick={() => setShowArchived((v) => !v)}
          className={`px-2.5 py-1 text-xs rounded border shadow-sm font-medium transition-colors ${
            showArchived
              ? "bg-blue-50 border-blue-300 text-blue-700"
              : "bg-white border-gray-300 text-gray-600 hover:bg-gray-50"
          }`}
        >
          {showArchived ? "Hide completed" : "Show completed"}
        </button>
      </div>
      {/* Controls */}
      <div className="absolute top-3 right-3 z-10 flex flex-col gap-1">
        <button
          onClick={() => setZoom((z) => Math.min(3, z * 1.2))}
          className="w-7 h-7 bg-white border border-gray-300 rounded text-gray-600 hover:bg-gray-100 flex items-center justify-center text-sm font-bold shadow-sm"
        >+</button>
        <button
          onClick={() => setZoom((z) => Math.max(0.1, z * 0.8))}
          className="w-7 h-7 bg-white border border-gray-300 rounded text-gray-600 hover:bg-gray-100 flex items-center justify-center text-sm font-bold shadow-sm"
        >−</button>
        <button
          onClick={fitView}
          className="w-7 h-7 bg-white border border-gray-300 rounded text-gray-600 hover:bg-gray-100 flex items-center justify-center shadow-sm"
          title="Fit to view"
        >
          <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
            <path d="M3 3v5h5" />
          </svg>
        </button>
      </div>
      {/* Legend */}
      <div className="absolute bottom-3 left-3 z-10 bg-white border border-gray-200 rounded-md p-2 shadow-sm text-xs text-gray-600 space-y-1">
        <div className="font-medium text-gray-700 mb-1">Status</div>
        {Object.entries(STATUS_COLORS).map(([name, color]) => (
          <div key={name} className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full inline-block shrink-0" style={{ background: color }} />
            {name}
          </div>
        ))}
      </div>

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
            return (
              <g
                key={node.id}
                data-node
                transform={`translate(${node.x},${node.y})`}
                style={{ cursor: "pointer", opacity: isHighlighted ? 1 : 0.3 }}
                onMouseDown={(e) => handleMouseDownNode(e, node.id)}
                onClick={(e) => {
                  e.stopPropagation();
                  if (!didDragRef.current) onIssueClick(node.issue);
                }}
              >
                <rect
                  width={NODE_W}
                  height={NODE_H}
                  rx={6}
                  ry={6}
                  fill="white"
                  stroke={isSelected ? "#3b82f6" : color}
                  strokeWidth={isSelected ? 2 : 1.5}
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
                    node.issue.priority === "critical" ? "#ef4444" :
                    node.issue.priority === "high" ? "#f97316" :
                    node.issue.priority === "medium" ? "#3b82f6" : "#9ca3af"
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
                {node.issue.isBlocked && (
                  <text x={NODE_W - 22} y={NODE_H - 6} fontSize={9} fill="#f59e0b">⚠</text>
                )}
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}

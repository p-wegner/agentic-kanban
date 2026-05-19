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

const DEPENDENCY_COLORS: Record<string, string> = {
  depends_on: "#6b7280",
  blocked_by: "#ef4444",
  related_to: "#8b5cf6",
  parent_of: "#f59e0b",
  child_of: "#f59e0b",
  duplicates: "#ec4899",
};

const NODE_W = 160;
const NODE_H = 60;
const H_GAP = 60;
const V_GAP = 40;

function computeLayout(nodes: IssueWithStatus[], edges: Dependency[]): Node[] {
  if (nodes.length === 0) return [];

  // Build adjacency for topological sort
  const outEdges = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  for (const n of nodes) {
    outEdges.set(n.id, []);
    inDegree.set(n.id, 0);
  }
  for (const e of edges) {
    // depends_on: issueId -> dependsOnId (source depends on target = edge from source to target in execution order)
    // For layout: dependsOnId should appear before issueId
    if (outEdges.has(e.dependsOnId) && outEdges.has(e.issueId)) {
      outEdges.get(e.dependsOnId)!.push(e.issueId);
      inDegree.set(e.issueId, (inDegree.get(e.issueId) ?? 0) + 1);
    }
  }

  // Kahn's algorithm for level assignment
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
  // Any unreached nodes (cycles) get level 0
  for (const n of nodes) {
    if (!levels.has(n.id)) levels.set(n.id, 0);
  }

  // Group by level
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

interface GraphViewProps {
  columns: StatusWithIssues[];
  projectId: string;
  onIssueClick: (issue: IssueWithStatus) => void;
  searchQuery?: string;
}

export function GraphView({ columns, projectId, onIssueClick, searchQuery }: GraphViewProps) {
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(true);
  const [localSearch, setLocalSearch] = useState("");
  const [nodes, setNodes] = useState<Node[]>([]);
  const dragNodeRef = useRef<string | null>(null);
  const dragOffsetRef = useRef({ x: 0, y: 0 });
  const didDragRef = useRef(false);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const panRef = useRef({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const isPanningRef = useRef(false);
  const panStart = useRef({ x: 0, y: 0 });
  const panOrigin = useRef({ x: 0, y: 0 });
  const svgRef = useRef<SVGSVGElement>(null);
  const rafRef = useRef<number | null>(null);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);

  const allIssues = columns.flatMap((c) => c.issues);

  useEffect(() => {
    async function load() {
      try {
        setLoading(true);
        // Fetch all dependencies for the project
        const result = await apiFetch<{ nodes: IssueWithStatus[]; edges: Dependency[] }>(
          `/api/projects/${projectId}/graph`
        );
        setGraphData(result);
      } catch {
        // Fallback: build from columns data with no edges
        setGraphData({ nodes: allIssues, edges: [] });
      } finally {
        setLoading(false);
      }
    }
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, columns]);

  const effectiveSearch = localSearch || searchQuery || "";

  useLayoutEffect(() => {
    if (!graphData) return;
    const filtered = effectiveSearch
      ? graphData.nodes.filter(
          (n) =>
            n.title.toLowerCase().includes(effectiveSearch.toLowerCase()) ||
            n.description?.toLowerCase().includes(effectiveSearch.toLowerCase())
        )
      : graphData.nodes;
    const filteredIds = new Set(filtered.map((n) => n.id));
    const filteredEdges = graphData.edges.filter(
      (e) => filteredIds.has(e.issueId) && filteredIds.has(e.dependsOnId)
    );
    setNodes(computeLayout(filtered, filteredEdges));
  }, [graphData, effectiveSearch]);

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  function getEdges() {
    if (!graphData) return [];
    return graphData.edges.filter(
      (e) => nodeMap.has(e.issueId) && nodeMap.has(e.dependsOnId)
    );
  }

  function svgPoint(e: React.MouseEvent | MouseEvent): { x: number; y: number } {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    const p = panRef.current;
    return {
      x: (e.clientX - rect.left - p.x) / zoom,
      y: (e.clientY - rect.top - p.y) / zoom,
    };
  }

  function handleMouseDownNode(e: React.MouseEvent, nodeId: string) {
    e.stopPropagation();
    const pt = svgPoint(e);
    const node = nodeMap.get(nodeId)!;
    didDragRef.current = false;
    dragNodeRef.current = nodeId;
    dragOffsetRef.current = { x: pt.x - node.x, y: pt.y - node.y };
    setSelectedNode(nodeId);
  }

  function handleMouseMoveSvg(e: React.MouseEvent) {
    if (dragNodeRef.current) {
      didDragRef.current = true;
      const pt = svgPoint(e);
      const dx = dragOffsetRef.current;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        setNodes((prev) =>
          prev.map((n) =>
            n.id === dragNodeRef.current
              ? { ...n, x: pt.x - dx.x, y: pt.y - dx.y }
              : n
          )
        );
      });
    } else if (isPanningRef.current) {
      const nx = panOrigin.current.x + (e.clientX - panStart.current.x);
      const ny = panOrigin.current.y + (e.clientY - panStart.current.y);
      panRef.current = { x: nx, y: ny };
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => setPan({ x: nx, y: ny }));
    }
  }

  function handleMouseUpSvg() {
    dragNodeRef.current = null;
    isPanningRef.current = false;
  }

  function handleMouseDownSvg(e: React.MouseEvent) {
    if ((e.target as SVGElement).closest("[data-node]")) return;
    isPanningRef.current = true;
    panStart.current = { x: e.clientX, y: e.clientY };
    panOrigin.current = { x: panRef.current.x, y: panRef.current.y };
  }

  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    setZoom((z) => Math.min(3, Math.max(0.2, z * factor)));
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
  const maxX = Math.max(...nodes.map((n) => n.x + NODE_W)) + 40;
  const maxY = Math.max(...nodes.map((n) => n.y + NODE_H)) + 40;

  return (
    <div className="relative h-full w-full overflow-hidden bg-gray-50 select-none">
      {/* Search toolbar */}
      <div className="absolute top-3 left-3 z-10">
        <input
          type="text"
          value={localSearch}
          onChange={(e) => setLocalSearch(e.target.value)}
          placeholder="Search nodes..."
          className="px-2.5 py-1.5 text-xs border border-gray-300 rounded-md bg-white shadow-sm focus:outline-none focus:ring-1 focus:ring-blue-500 w-44"
        />
      </div>
      {/* Controls */}
      <div className="absolute top-3 right-3 z-10 flex flex-col gap-1">
        <button
          onClick={() => setZoom((z) => Math.min(3, z * 1.2))}
          className="w-7 h-7 bg-white border border-gray-300 rounded text-gray-600 hover:bg-gray-100 flex items-center justify-center text-sm font-bold shadow-sm"
        >+</button>
        <button
          onClick={() => setZoom((z) => Math.max(0.2, z * 0.8))}
          className="w-7 h-7 bg-white border border-gray-300 rounded text-gray-600 hover:bg-gray-100 flex items-center justify-center text-sm font-bold shadow-sm"
        >−</button>
        <button
          onClick={() => { setZoom(1); panRef.current = { x: 0, y: 0 }; setPan({ x: 0, y: 0 }); }}
          className="w-7 h-7 bg-white border border-gray-300 rounded text-gray-600 hover:bg-gray-100 flex items-center justify-center shadow-sm"
          title="Reset view"
        >
          <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
            <path d="M3 3v5h5" />
          </svg>
        </button>
        <button
          onClick={() => {
            const svg = svgRef.current;
            if (!svg || nodes.length === 0) return;
            const rect = svg.getBoundingClientRect();
            const fitZoom = Math.min(rect.width / maxX, rect.height / maxY, 1) * 0.9;
            setZoom(fitZoom);
            setPan({ x: 0, y: 0 });
          }}
          className="w-7 h-7 bg-white border border-gray-300 rounded text-gray-600 hover:bg-gray-100 flex items-center justify-center shadow-sm"
          title="Fit to screen"
        >
          <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
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
        className="w-full h-full cursor-grab active:cursor-grabbing"
        viewBox={`0 0 ${Math.max(maxX, 400)} ${Math.max(maxY, 300)}`}
        style={{ cursor: isPanningRef.current || dragNodeRef.current ? "grabbing" : "grab" }}
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
            const isHighlighted = effectiveSearch
              ? node.issue.title.toLowerCase().includes(effectiveSearch.toLowerCase()) ||
                (node.issue.description?.toLowerCase().includes(effectiveSearch.toLowerCase()) ?? false)
              : true;
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
                  filter="drop-shadow(0 1px 2px rgba(0,0,0,0.1))"
                />
                {/* Status indicator bar */}
                <rect width={4} height={NODE_H} rx={3} fill={color} />
                {/* Priority dot */}
                <circle
                  cx={NODE_W - 10}
                  cy={10}
                  r={4}
                  fill={
                    node.issue.priority === "critical" ? "#ef4444" :
                    node.issue.priority === "high" ? "#f97316" :
                    node.issue.priority === "medium" ? "#3b82f6" : "#9ca3af"
                  }
                />
                {/* Issue number */}
                {node.issue.issueNumber != null && (
                  <text x={10} y={16} fontSize={9} fill="#9ca3af" fontFamily="monospace">
                    #{node.issue.issueNumber}
                  </text>
                )}
                {/* Title */}
                <text
                  x={10}
                  y={32}
                  fontSize={11}
                  fill="#111827"
                  fontWeight={500}
                >
                  <tspan>
                    {node.issue.title.length > 18
                      ? node.issue.title.slice(0, 18) + "…"
                      : node.issue.title}
                  </tspan>
                </text>
                {/* Status label */}
                <text x={10} y={50} fontSize={9} fill={color}>
                  {node.issue.statusName}
                </text>
                {/* Blocked indicator */}
                {node.issue.isBlocked && (
                  <text x={NODE_W - 20} y={NODE_H - 6} fontSize={9} fill="#f59e0b">⚠</text>
                )}
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}

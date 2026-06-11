import type { MutableRefObject } from "react";
import { BRAND } from "../lib/chartColors";
import type { CriticalPathResult } from "../lib/criticalPath.js";
import {
  CHAIN_EDGE_COLOR,
  DEPENDENCY_COLORS,
  NODE_H,
  NODE_W,
  type Dependency,
  type Node,
} from "../lib/graphLayout.js";

interface GraphEdgesProps {
  edges: Dependency[];
  nodeMap: Map<string, Node>;
  isCriticalPathMode: boolean;
  criticalPathResult: CriticalPathResult | null;
  selectedChainRoot: string | null;
  selectedChainEdgeKeys: Set<string>;
  selectedEdge: Dependency | null;
  didDragRef: MutableRefObject<boolean>;
  onEdgeClick: (edge: Dependency) => void;
}

/** SVG edge rendering for the dependency graph (both dependency and critical-path modes). */
export function GraphEdges({
  edges,
  nodeMap,
  isCriticalPathMode,
  criticalPathResult,
  selectedChainRoot,
  selectedChainEdgeKeys,
  selectedEdge,
  didDragRef,
  onEdgeClick,
}: GraphEdgesProps) {
  return (
    <>
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
        const isSelectedEdge = selectedEdge?.id === edge.id;

        // Critical-path mode: highlight chain edges, dim non-chain (no edge selection in this mode)
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
        const d = `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
        return (
          <g
            key={edge.id}
            data-edge-id={edge.id}
            style={{ cursor: "pointer" }}
            onClick={(e) => {
              e.stopPropagation();
              if (didDragRef.current) return;
              onEdgeClick(edge);
            }}
          >
            {/* Invisible wider hit target for easier clicking */}
            <path
              d={d}
              fill="none"
              stroke="transparent"
              strokeWidth={12}
            />
            <path
              d={d}
              fill="none"
              stroke={isSelectedEdge ? BRAND : color}
              strokeWidth={isSelectedEdge ? 2.5 : 1.5}
              opacity={isSelectedEdge ? 1 : 0.7}
              markerEnd={`url(#arrow-${edge.type})`}
            />
            <text
              x={mx}
              y={(y1 + y2) / 2 - 4}
              fontSize={9}
              fill={isSelectedEdge ? BRAND : color}
              textAnchor="middle"
              opacity={0.8}
            >
              {edge.type.replace(/_/g, " ")}
            </text>
          </g>
        );
      })}
    </>
  );
}

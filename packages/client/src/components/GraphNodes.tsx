import type { MouseEvent as ReactMouseEvent, MutableRefObject } from "react";
import { BRAND, STATUS_COLORS, TYPE_COLORS } from "../lib/chartColors";
import type { CriticalPathResult } from "../lib/criticalPath.js";
import {
  ACTIVE_GLOW_COLOR,
  CYCLE_COLOR,
  isActivelyWorked,
  NODE_H,
  NODE_W,
  ROOT_BLOCKER_COLOR,
  type Node,
} from "../lib/graphLayout.js";

interface GraphNodesProps {
  nodes: Node[];
  selectedNode: string | null;
  focusIssueId?: string;
  searchQuery?: string;
  isCriticalPathMode: boolean;
  criticalPathResult: CriticalPathResult | null;
  rootBlockerIds: Set<string>;
  downstreamCountMap: Map<string, number>;
  selectedChainRoot: string | null;
  selectedChainIds: Set<string>;
  didDragRef: MutableRefObject<boolean>;
  onNodeMouseDown: (e: ReactMouseEvent, nodeId: string) => void;
  onNodeClick: (node: Node) => void;
}

/** SVG node rendering for the dependency graph, including critical-path styling overrides. */
export function GraphNodes({
  nodes,
  selectedNode,
  focusIssueId,
  searchQuery,
  isCriticalPathMode,
  criticalPathResult,
  rootBlockerIds,
  downstreamCountMap,
  selectedChainRoot,
  selectedChainIds,
  didDragRef,
  onNodeMouseDown,
  onNodeClick,
}: GraphNodesProps) {
  return (
    <>
      {nodes.map((node) => {
        const color = STATUS_COLORS[node.issue.statusName] ?? "#6b7280";
        const isSelected = selectedNode === node.id;
        const isFocused = focusIssueId === node.id;
        const isHighlighted = searchQuery
          ? node.issue.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
            (node.issue.description?.toLowerCase().includes(searchQuery.toLowerCase()) ?? false)
          : true;
        const title = node.issue.title;
        const displayTitle = title.length > 28 ? title.slice(0, 28) + "…" : title;
        // Active = an agent is currently working this issue. Suppressed in
        // critical-path mode, which uses the whole node-stroke channel itself.
        const isActive = !isCriticalPathMode && isActivelyWorked(node.issue);

        // Critical-path mode visual overrides
        let nodeOpacity = isHighlighted ? 1 : 0.3;
        let nodeStroke = isFocused ? BRAND : (isSelected ? BRAND : (isActive ? ACTIVE_GLOW_COLOR : color));
        let nodeStrokeWidth = isFocused ? 3 : (isSelected ? 2 : (isActive ? 2 : 1.5));
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
            onMouseDown={(e) => onNodeMouseDown(e, node.id)}
            onClick={(e) => {
              e.stopPropagation();
              if (didDragRef.current) return;
              onNodeClick(node);
            }}
          >
            {/* Pulsing halo — animated "actively worked on" indicator */}
            {isActive && (
              <rect
                className="graph-active-halo"
                x={-3}
                y={-3}
                width={NODE_W + 6}
                height={NODE_H + 6}
                rx={9}
                ry={9}
                fill="none"
                stroke={ACTIVE_GLOW_COLOR}
                strokeWidth={2}
                pointerEvents="none"
              />
            )}
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
            {/* Status indicator bar (pulses while actively worked) */}
            <rect
              className={isActive ? "graph-active-bar" : undefined}
              width={4}
              height={NODE_H}
              rx={3}
              fill={isActive ? ACTIVE_GLOW_COLOR : color}
            />
            {/* Active "working" dot */}
            {isActive && (
              <circle
                className="graph-active-dot"
                cx={NODE_W - 26}
                cy={12}
                r={3.5}
                fill={ACTIVE_GLOW_COLOR}
              />
            )}
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
    </>
  );
}

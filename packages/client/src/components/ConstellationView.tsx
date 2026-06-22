import { useEffect, useRef, useState, useCallback } from "react";
import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";
import { STATUS_COLORS, TYPE_COLORS, PRIORITY_META } from "../lib/chartColors";

interface ConstellationViewProps {
  columns: StatusWithIssues[];
  onIssueClick: (issue: IssueWithStatus) => void;
  searchQuery?: string;
}

const PRIORITY_RADIUS: Record<string, number> = {
  critical: 12,
  high: 10,
  medium: 8,
  low: 6,
};

const PRIORITY_GLOW: Record<string, number> = {
  critical: 20,
  high: 14,
  medium: 10,
  low: 6,
};

const HIDDEN_STATUSES = new Set(["Cancelled", "Done"]);

interface Node {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  targetX: number;
  targetY: number;
  radius: number;
  glowSize: number;
  color: string;
  glowColor: string;
  issue: IssueWithStatus;
  statusColor: string;
  label: string;
  opacity: number;
}

interface Cluster {
  id: string;
  label: string;
  x: number;
  y: number;
  color: string;
  issueCount: number;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? { r: parseInt(result[1], 16), g: parseInt(result[2], 16), b: parseInt(result[3], 16) }
    : { r: 120, g: 120, b: 120 };
}

function colorWithAlpha(hex: string, alpha: number): string {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}

export function ConstellationView({ columns, onIssueClick, searchQuery: _searchQuery }: ConstellationViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const nodesRef = useRef<Node[]>([]);
  const clustersRef = useRef<Cluster[]>([]);
  const animFrameRef = useRef<number>(0);
  const hoveredIdRef = useRef<string | null>(null);
  const [hoveredIssue, setHoveredIssue] = useState<IssueWithStatus | null>(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
  const [showDone, setShowDone] = useState(false);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });
  const starsRef = useRef<Array<{ x: number; y: number; r: number; a: number }>>([]);

  const activeColumns = columns.filter((c) => showDone || !HIDDEN_STATUSES.has(c.name));

  const buildLayout = useCallback(
    (width: number, height: number) => {
      const cx = width / 2;
      const cy = height / 2;
      const clusterCount = activeColumns.length;

      // Arrange clusters in a circle
      const clusterRadius = Math.min(width, height) * 0.3;
      const newClusters: Cluster[] = activeColumns.map((col, i) => {
        const angle = (i / clusterCount) * Math.PI * 2 - Math.PI / 2;
        return {
          id: col.id,
          label: col.name,
          x: cx + Math.cos(angle) * clusterRadius,
          y: cy + Math.sin(angle) * clusterRadius,
          color: STATUS_COLORS[col.name] ?? "#8a8175",
          issueCount: col.issues.length,
        };
      });

      const newNodes: Node[] = [];
      for (const col of activeColumns) {
        const cluster = newClusters.find((c) => c.id === col.id)!;
        const orbitRadius = 60 + col.issues.length * 8;
        col.issues.forEach((issue, j) => {
          const existing = nodesRef.current.find((n) => n.id === issue.id);
          const angle = (j / Math.max(col.issues.length, 1)) * Math.PI * 2 + Math.random() * 0.3;
          const dist = orbitRadius * (0.5 + Math.random() * 0.5);
          const tx = cluster.x + Math.cos(angle) * dist;
          const ty = cluster.y + Math.sin(angle) * dist;
          const typeColor = TYPE_COLORS[issue.issueType ?? "task"] ?? "#5b7a8c";
          const statusColor = STATUS_COLORS[col.name] ?? "#8a8175";
          const priority = issue.priority ?? "low";
          newNodes.push({
            id: issue.id,
            x: existing ? existing.x : tx + (Math.random() - 0.5) * 40,
            y: existing ? existing.y : ty + (Math.random() - 0.5) * 40,
            vx: existing ? existing.vx : 0,
            vy: existing ? existing.vy : 0,
            targetX: tx,
            targetY: ty,
            radius: PRIORITY_RADIUS[priority] ?? 8,
            glowSize: PRIORITY_GLOW[priority] ?? 10,
            color: typeColor,
            glowColor: typeColor,
            statusColor,
            issue,
            label: `#${issue.issueNumber} ${issue.title}`,
            opacity: 1,
          });
        });
      }

      // Generate stars once per layout
      const newStars = Array.from({ length: 120 }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        r: Math.random() * 1.2 + 0.2,
        a: Math.random() * 0.5 + 0.1,
      }));

      starsRef.current = newStars;
      clustersRef.current = newClusters;
      nodesRef.current = newNodes;
    },
    [activeColumns]
  );

  // Rebuild layout when data or size changes
  useEffect(() => {
    buildLayout(dimensions.width, dimensions.height);
  }, [buildLayout, dimensions]);

  // Resize observer
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setDimensions({ width: entry.contentRect.width, height: entry.contentRect.height });
      }
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // Animation loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let tick = 0;

    function draw() {
      tick++;
      const { width, height } = canvas!;
      ctx!.clearRect(0, 0, width, height);

      // Deep space background gradient
      const bg = ctx!.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, Math.max(width, height) * 0.7);
      bg.addColorStop(0, "#0d1117");
      bg.addColorStop(1, "#070a0e");
      ctx!.fillStyle = bg;
      ctx!.fillRect(0, 0, width, height);

      // Stars
      for (const star of starsRef.current) {
        const twinkle = star.a * (0.6 + 0.4 * Math.sin(tick * 0.02 + star.x));
        ctx!.beginPath();
        ctx!.arc(star.x, star.y, star.r, 0, Math.PI * 2);
        ctx!.fillStyle = `rgba(255,245,230,${twinkle})`;
        ctx!.fill();
      }

      // Draw cluster halos
      for (const cluster of clustersRef.current) {
        const pulse = 1 + 0.04 * Math.sin(tick * 0.015 + cluster.x);
        const grad = ctx!.createRadialGradient(cluster.x, cluster.y, 0, cluster.x, cluster.y, 55 * pulse);
        grad.addColorStop(0, colorWithAlpha(cluster.color, 0.12));
        grad.addColorStop(1, colorWithAlpha(cluster.color, 0));
        ctx!.fillStyle = grad;
        ctx!.beginPath();
        ctx!.arc(cluster.x, cluster.y, 55 * pulse, 0, Math.PI * 2);
        ctx!.fill();

        // Cluster center dot
        ctx!.beginPath();
        ctx!.arc(cluster.x, cluster.y, 4, 0, Math.PI * 2);
        ctx!.fillStyle = colorWithAlpha(cluster.color, 0.7);
        ctx!.fill();

        // Cluster label
        ctx!.font = "bold 11px system-ui, sans-serif";
        ctx!.textAlign = "center";
        ctx!.fillStyle = colorWithAlpha(cluster.color, 0.9);
        ctx!.fillText(cluster.label, cluster.x, cluster.y - 12);

        if (cluster.issueCount > 0) {
          ctx!.font = "10px system-ui, sans-serif";
          ctx!.fillStyle = colorWithAlpha(cluster.color, 0.5);
          ctx!.fillText(`${cluster.issueCount} issue${cluster.issueCount !== 1 ? "s" : ""}`, cluster.x, cluster.y + 17);
        }
      }

      // Draw connector lines from nodes to their cluster
      for (const node of nodesRef.current) {
        const cluster = clustersRef.current.find(
          (c) => c.id === node.issue.statusId
        );
        if (!cluster) continue;
        const dist = Math.hypot(node.x - cluster.x, node.y - cluster.y);
        const alpha = Math.max(0, 0.12 - dist / 1200);
        if (alpha <= 0) continue;
        ctx!.beginPath();
        ctx!.moveTo(node.x, node.y);
        ctx!.lineTo(cluster.x, cluster.y);
        ctx!.strokeStyle = colorWithAlpha(node.statusColor, alpha);
        ctx!.lineWidth = 0.5;
        ctx!.stroke();
      }

      // Update node positions (gentle spring toward target)
      const spring = 0.04;
      const damping = 0.88;
      for (const node of nodesRef.current) {
        node.vx += (node.targetX - node.x) * spring;
        node.vy += (node.targetY - node.y) * spring;
        node.vx *= damping;
        node.vy *= damping;
        node.x += node.vx;
        node.y += node.vy;
      }

      // Draw nodes
      const hovered = hoveredIdRef.current;
      for (const node of nodesRef.current) {
        const isHovered = hovered === node.id;
        const wobble = isHovered ? 1 : 0.85 + 0.15 * Math.sin(tick * 0.02 + node.x * 0.1);
        const r = node.radius * wobble;
        const glowR = node.glowSize * wobble * (isHovered ? 1.6 : 1);

        // Glow
        const glow = ctx!.createRadialGradient(node.x, node.y, 0, node.x, node.y, glowR);
        glow.addColorStop(0, colorWithAlpha(node.glowColor, isHovered ? 0.5 : 0.25));
        glow.addColorStop(1, colorWithAlpha(node.glowColor, 0));
        ctx!.fillStyle = glow;
        ctx!.beginPath();
        ctx!.arc(node.x, node.y, glowR, 0, Math.PI * 2);
        ctx!.fill();

        // Core
        ctx!.beginPath();
        ctx!.arc(node.x, node.y, r, 0, Math.PI * 2);
        ctx!.fillStyle = isHovered ? colorWithAlpha(node.color, 1) : colorWithAlpha(node.color, 0.85);
        ctx!.fill();

        // Status ring
        ctx!.beginPath();
        ctx!.arc(node.x, node.y, r + 1.5, 0, Math.PI * 2);
        ctx!.strokeStyle = colorWithAlpha(node.statusColor, isHovered ? 0.9 : 0.4);
        ctx!.lineWidth = isHovered ? 2 : 1;
        ctx!.stroke();

        // Label on hover
        if (isHovered) {
          const maxLen = 28;
          const text = node.issue.issueNumber
            ? `#${node.issue.issueNumber} ${node.issue.title}`.slice(0, maxLen) +
              (node.label.length > maxLen ? "…" : "")
            : node.issue.title.slice(0, maxLen);
          ctx!.font = "bold 11px system-ui, sans-serif";
          ctx!.textAlign = "center";
          const tw = ctx!.measureText(text).width;
          const px = 8, py = 4;
          ctx!.fillStyle = "rgba(10,12,18,0.85)";
          ctx!.beginPath();
          ctx!.roundRect(node.x - tw / 2 - px, node.y - r - 28 - py, tw + px * 2, 22, 4);
          ctx!.fill();
          ctx!.fillStyle = "#f0e8dc";
          ctx!.fillText(text, node.x, node.y - r - 14);
        }
      }

      animFrameRef.current = requestAnimationFrame(draw);
    }

    animFrameRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animFrameRef.current);
  }, [dimensions]);

  // Mouse move for hover detection
  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      let found: Node | null = null;
      for (const node of nodesRef.current) {
        if (Math.hypot(node.x - mx, node.y - my) <= node.radius + 6) {
          found = node;
          break;
        }
      }

      hoveredIdRef.current = found ? found.id : null;
      setHoveredIssue(found ? found.issue : null);
      setTooltipPos({ x: e.clientX, y: e.clientY });
      canvas.style.cursor = found ? "pointer" : "default";
    },
    []
  );

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      for (const node of nodesRef.current) {
        if (Math.hypot(node.x - mx, node.y - my) <= node.radius + 6) {
          onIssueClick(node.issue);
          return;
        }
      }
    },
    [onIssueClick]
  );

  const handleMouseLeave = useCallback(() => {
    hoveredIdRef.current = null;
    setHoveredIssue(null);
  }, []);

  const totalIssues = activeColumns.reduce((n, c) => n + c.issues.length, 0);

  return (
    <div ref={containerRef} className="relative w-full h-full min-h-[500px] bg-[#070a0e] overflow-hidden select-none">
      <canvas
        ref={canvasRef}
        width={dimensions.width}
        height={dimensions.height}
        className="absolute inset-0"
        onMouseMove={handleMouseMove}
        onClick={handleClick}
        onMouseLeave={handleMouseLeave}
      />

      {/* HUD overlay */}
      <div className="absolute top-3 left-4 flex items-center gap-3">
        <span className="text-[10px] font-mono tracking-widest text-[#8a8175] uppercase opacity-70">
          Constellation
        </span>
        <span className="text-[10px] font-mono text-[#547446] opacity-70">
          {totalIssues} issues · {activeColumns.length} clusters
        </span>
      </div>

      {/* Legend */}
      <div className="absolute top-3 right-4 flex flex-col gap-1">
        {PRIORITY_META.map((p) => (
          <div key={p.key} className="flex items-center gap-1.5">
            <div
              className="rounded-full flex-shrink-0"
              style={{
                width: PRIORITY_RADIUS[p.key] * 2,
                height: PRIORITY_RADIUS[p.key] * 2,
                background: p.color,
                opacity: 0.7,
              }}
            />
            <span className="text-[9px] font-mono text-[#8a8175] capitalize">{p.key}</span>
          </div>
        ))}
      </div>

      {/* Type legend */}
      <div className="absolute bottom-10 right-4 flex flex-col gap-1">
        {Object.entries(TYPE_COLORS).map(([type, color]) => (
          <div key={type} className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: color, opacity: 0.8 }} />
            <span className="text-[9px] font-mono text-[#8a8175] capitalize">{type}</span>
          </div>
        ))}
      </div>

      {/* Show done toggle */}
      <div className="absolute bottom-4 left-4">
        <button
          onClick={() => setShowDone((v) => !v)}
          className="text-[10px] font-mono px-2 py-1 rounded border border-[#2a2e36] text-[#8a8175] hover:text-[#c0b8b0] hover:border-[#3a3e46] transition-colors"
        >
          {showDone ? "Hide Done/Cancelled" : "Show Done/Cancelled"}
        </button>
      </div>

      {/* Hover tooltip */}
      {hoveredIssue && (
        <div
          className="fixed z-50 pointer-events-none"
          style={{ left: tooltipPos.x + 14, top: tooltipPos.y - 10 }}
        >
          <div className="bg-[#0d1117] border border-[#2a2e36] rounded px-2.5 py-1.5 text-[11px] font-mono text-[#c0b8b0] max-w-[260px] shadow-xl">
            <div className="font-bold text-[#f0e8dc] truncate">
              {hoveredIssue.issueNumber ? `#${hoveredIssue.issueNumber} ` : ""}
              {hoveredIssue.title}
            </div>
            <div className="mt-0.5 flex gap-2 text-[10px] text-[#8a8175]">
              <span>{hoveredIssue.issueType ?? "task"}</span>
              <span>·</span>
              <span>{hoveredIssue.priority ?? "low"}</span>
              {hoveredIssue.tags && hoveredIssue.tags.length > 0 && (
                <>
                  <span>·</span>
                  <span>{hoveredIssue.tags.map((t) => t.name).join(", ")}</span>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

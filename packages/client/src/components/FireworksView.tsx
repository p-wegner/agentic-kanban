import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";
import { PRIORITY_META, STATUS_COLORS, TYPE_COLORS } from "../lib/chartColors.js";

interface FireworksViewProps {
  columns: StatusWithIssues[];
  onIssueClick: (issue: IssueWithStatus) => void;
  searchQuery?: string;
}

interface Spark {
  angle: number;
  speed: number;
  radius: number;
  alpha: number;
}

interface FireworkNode {
  id: string;
  x: number;
  y: number;
  baseX: number;
  baseY: number;
  color: string;
  statusColor: string;
  issue: IssueWithStatus;
  sparks: Spark[];
}

interface StatusRail {
  id: string;
  label: string;
  color: string;
  x: number;
  count: number;
}

const HIDDEN_STATUSES = new Set(["Done", "Cancelled"]);
const PRIORITY_SIZE: Record<string, number> = {
  critical: 18,
  high: 15,
  medium: 12,
  low: 9,
};

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return match
    ? { r: parseInt(match[1], 16), g: parseInt(match[2], 16), b: parseInt(match[3], 16) }
    : { r: 128, g: 128, b: 128 };
}

function rgba(hex: string, alpha: number): string {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function seededUnit(seed: string): number {
  let value = 0;
  for (let i = 0; i < seed.length; i++) {
    value = (value * 31 + seed.charCodeAt(i)) % 9973;
  }
  return value / 9973;
}

function makeSparks(id: string, count: number): Spark[] {
  return Array.from({ length: count }, (_, index) => {
    const unit = seededUnit(`${id}:${index}`);
    return {
      angle: unit * Math.PI * 2,
      speed: 0.65 + seededUnit(`${index}:${id}`) * 1.2,
      radius: 1.5 + seededUnit(`${id}:r:${index}`) * 2.2,
      alpha: 0.34 + seededUnit(`${id}:a:${index}`) * 0.54,
    };
  });
}

export function FireworksView({ columns, onIssueClick, searchQuery = "" }: FireworksViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<number>(0);
  const nodesRef = useRef<FireworkNode[]>([]);
  const railsRef = useRef<StatusRail[]>([]);
  const hoveredNodeRef = useRef<FireworkNode | null>(null);
  const [hoveredNode, setHoveredNode] = useState<FireworkNode | null>(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
  const [showDone, setShowDone] = useState(false);
  const [dimensions, setDimensions] = useState({ width: 900, height: 560 });

  const visibleColumns = useMemo(
    () => columns.filter((column) => showDone || !HIDDEN_STATUSES.has(column.name)),
    [columns, showDone],
  );

  const filteredColumns = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return visibleColumns;
    return visibleColumns.map((column) => ({
      ...column,
      issues: column.issues.filter((issue) => {
        return (
          issue.title.toLowerCase().includes(q) ||
          String(issue.issueNumber).includes(q) ||
          (issue.tags?.some((tag) => tag.name.toLowerCase().includes(q)) ?? false)
        );
      }),
    }));
  }, [searchQuery, visibleColumns]);

  const totals = useMemo(() => {
    const issues = filteredColumns.flatMap((column) => column.issues);
    return {
      issueCount: issues.length,
      criticalCount: issues.filter((issue) => issue.priority === "critical").length,
      activeCount: issues.filter((issue) => (issue.workspaceSummary?.active ?? 0) > 0).length,
    };
  }, [filteredColumns]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      setDimensions({
        width: Math.max(360, Math.floor(entry.contentRect.width)),
        height: Math.max(420, Math.floor(entry.contentRect.height)),
      });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const width = dimensions.width;
    const height = dimensions.height;
    const leftPad = 72;
    const rightPad = 72;
    const topPad = 120;
    const bottomPad = 100;
    const usableHeight = Math.max(180, height - topPad - bottomPad);
    const railCount = Math.max(1, filteredColumns.length);

    const rails = filteredColumns.map((column, index) => {
      const x = leftPad + ((width - leftPad - rightPad) * (index + 0.5)) / railCount;
      return {
        id: column.id,
        label: column.name,
        color: STATUS_COLORS[column.name] ?? "#8a8175",
        x,
        count: column.issues.length,
      };
    });

    const nodes = filteredColumns.flatMap((column, columnIndex) => {
      const rail = rails[columnIndex];
      const count = Math.max(1, column.issues.length);
      return column.issues.map((issue, issueIndex) => {
        const priority = issue.priority ?? "low";
        const type = issue.issueType ?? "task";
        const drift = (seededUnit(issue.id) - 0.5) * Math.min(76, (width - leftPad - rightPad) / Math.max(railCount, 1) * 0.45);
        const y = topPad + (usableHeight * (issueIndex + 0.5)) / count;
        return {
          id: issue.id,
          x: rail.x + drift,
          y,
          baseX: rail.x + drift,
          baseY: y,
          color: TYPE_COLORS[type] ?? TYPE_COLORS.task,
          statusColor: rail.color,
          issue,
          sparks: makeSparks(issue.id, Math.max(10, Math.round((PRIORITY_SIZE[priority] ?? 9) * 1.4))),
        };
      });
    });

    railsRef.current = rails;
    nodesRef.current = nodes;
  }, [dimensions, filteredColumns]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let tick = 0;
    const draw = () => {
      tick += 1;
      const width = canvas.width;
      const height = canvas.height;
      ctx.clearRect(0, 0, width, height);

      const background = ctx.createLinearGradient(0, 0, width, height);
      background.addColorStop(0, "#10141b");
      background.addColorStop(0.48, "#16110f");
      background.addColorStop(1, "#07110e");
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, width, height);

      ctx.save();
      ctx.globalAlpha = 0.22;
      for (let i = 0; i < 80; i++) {
        const x = (seededUnit(`sky-x-${i}`) * width + tick * (0.05 + seededUnit(`speed-${i}`) * 0.09)) % width;
        const y = seededUnit(`sky-y-${i}`) * height;
        const size = 0.7 + seededUnit(`sky-r-${i}`) * 1.6;
        ctx.beginPath();
        ctx.arc(x, y, size, 0, Math.PI * 2);
        ctx.fillStyle = i % 3 === 0 ? "#f1dfbd" : "#b9c7b1";
        ctx.fill();
      }
      ctx.restore();

      for (const rail of railsRef.current) {
        ctx.beginPath();
        ctx.moveTo(rail.x, 94);
        ctx.lineTo(rail.x, height - 68);
        ctx.strokeStyle = rgba(rail.color, 0.22);
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 9]);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.font = "600 11px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillStyle = rgba(rail.color, 0.9);
        ctx.fillText(rail.label, rail.x, 72);
        ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
        ctx.fillStyle = rgba(rail.color, 0.56);
        ctx.fillText(`${rail.count}`, rail.x, 89);
      }

      for (const node of nodesRef.current) {
        const priority = node.issue.priority ?? "low";
        const baseSize = PRIORITY_SIZE[priority] ?? PRIORITY_SIZE.low;
        const hover = hoveredNodeRef.current?.id === node.id;
        const pulse = 0.78 + Math.sin(tick * 0.035 + seededUnit(node.id) * 12) * 0.22;
        const burst = baseSize * (hover ? 1.45 : pulse);

        ctx.beginPath();
        ctx.moveTo(node.x, Math.min(dimensions.height - 80, node.y + 34));
        ctx.lineTo(node.x, node.y + 8);
        ctx.strokeStyle = rgba(node.statusColor, hover ? 0.7 : 0.34);
        ctx.lineWidth = hover ? 2 : 1;
        ctx.stroke();

        for (const spark of node.sparks) {
          const distance = burst + spark.speed * (8 + (tick % 90) * 0.12);
          const x = node.x + Math.cos(spark.angle + tick * 0.002) * distance;
          const y = node.y + Math.sin(spark.angle + tick * 0.002) * distance;
          ctx.beginPath();
          ctx.arc(x, y, spark.radius, 0, Math.PI * 2);
          ctx.fillStyle = rgba(node.color, spark.alpha * (hover ? 1 : 0.72));
          ctx.fill();
        }

        const glow = ctx.createRadialGradient(node.x, node.y, 0, node.x, node.y, burst * 2.6);
        glow.addColorStop(0, rgba(node.color, hover ? 0.54 : 0.28));
        glow.addColorStop(1, rgba(node.color, 0));
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(node.x, node.y, burst * 2.6, 0, Math.PI * 2);
        ctx.fill();

        ctx.beginPath();
        ctx.arc(node.x, node.y, baseSize * (hover ? 0.54 : 0.42), 0, Math.PI * 2);
        ctx.fillStyle = rgba(node.color, 0.95);
        ctx.fill();
        ctx.strokeStyle = rgba(node.statusColor, hover ? 0.95 : 0.48);
        ctx.lineWidth = hover ? 2.5 : 1.5;
        ctx.stroke();
      }

      frameRef.current = requestAnimationFrame(draw);
    };

    frameRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frameRef.current);
  }, [dimensions]);

  const findNodeAt = useCallback((event: MouseEvent<HTMLCanvasElement>): FireworkNode | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    for (const node of nodesRef.current) {
      const size = (PRIORITY_SIZE[node.issue.priority ?? "low"] ?? PRIORITY_SIZE.low) + 10;
      if (Math.hypot(node.x - x, node.y - y) <= size) return node;
    }
    return null;
  }, []);

  const handleMouseMove = useCallback((event: MouseEvent<HTMLCanvasElement>) => {
    const node = findNodeAt(event);
    hoveredNodeRef.current = node;
    setHoveredNode(node);
    setTooltipPos({ x: event.clientX, y: event.clientY });
    if (canvasRef.current) canvasRef.current.style.cursor = node ? "pointer" : "default";
  }, [findNodeAt]);

  const handleClick = useCallback((event: MouseEvent<HTMLCanvasElement>) => {
    const node = findNodeAt(event);
    if (node) onIssueClick(node.issue);
  }, [findNodeAt, onIssueClick]);

  const priorityCounts = useMemo(() => {
    const issues = filteredColumns.flatMap((column) => column.issues);
    return Object.fromEntries(
      PRIORITY_META.map((priority) => [
        priority.key,
        issues.filter((issue) => (issue.priority ?? "low") === priority.key).length,
      ]),
    );
  }, [filteredColumns]);

  return (
    <div ref={containerRef} className="relative flex-1 min-h-[520px] overflow-hidden bg-[#10141b] text-[#f0e8dc]">
      <canvas
        ref={canvasRef}
        width={dimensions.width}
        height={dimensions.height}
        className="absolute inset-0 h-full w-full"
        onMouseMove={handleMouseMove}
        onMouseLeave={() => {
          hoveredNodeRef.current = null;
          setHoveredNode(null);
        }}
        onClick={handleClick}
      />

      <div className="pointer-events-none absolute left-5 top-4 right-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#c0d0b5]">Fireworks</div>
          <div className="mt-1 text-2xl font-semibold leading-none text-[#f4ead2]">Board launch sky</div>
          <div className="mt-2 max-w-[520px] text-xs leading-5 text-[#d8cbb7]/75">
            Issues burst by priority, grouped on status rails and colored by type.
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2 text-right">
          <div className="rounded border border-white/10 bg-black/20 px-3 py-2">
            <div className="text-lg font-semibold text-[#f4ead2]">{totals.issueCount}</div>
            <div className="text-[10px] uppercase tracking-wide text-[#d8cbb7]/55">visible</div>
          </div>
          <div className="rounded border border-white/10 bg-black/20 px-3 py-2">
            <div className="text-lg font-semibold text-[#f6e3df]">{totals.criticalCount}</div>
            <div className="text-[10px] uppercase tracking-wide text-[#d8cbb7]/55">critical</div>
          </div>
          <div className="rounded border border-white/10 bg-black/20 px-3 py-2">
            <div className="text-lg font-semibold text-[#c0d0b5]">{totals.activeCount}</div>
            <div className="text-[10px] uppercase tracking-wide text-[#d8cbb7]/55">running</div>
          </div>
        </div>
      </div>

      <div className="absolute bottom-4 left-5 right-5 flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {PRIORITY_META.map((priority) => (
            <div key={priority.key} className="flex items-center gap-1.5 rounded border border-white/10 bg-black/25 px-2 py-1">
              <span className="h-2 w-2 rounded-full" style={{ background: priority.color }} />
              <span className="text-[10px] capitalize text-[#d8cbb7]/70">{priority.key}</span>
              <span className="font-mono text-[10px] text-[#f4ead2]">{priorityCounts[priority.key] ?? 0}</span>
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setShowDone((value) => !value)}
          className="rounded border border-white/15 bg-black/35 px-3 py-1.5 text-[11px] font-medium text-[#f4ead2] transition hover:border-[#c0d0b5]/70 hover:bg-[#547446]/25"
        >
          {showDone ? "Hide Done/Cancelled" : "Show Done/Cancelled"}
        </button>
      </div>

      {hoveredNode && (
        <div
          className="fixed z-50 max-w-[280px] rounded border border-white/15 bg-[#10141b]/95 px-3 py-2 text-xs shadow-2xl"
          style={{ left: tooltipPos.x + 14, top: tooltipPos.y - 12 }}
        >
          <div className="font-semibold text-[#f4ead2]">
            #{hoveredNode.issue.issueNumber} {hoveredNode.issue.title}
          </div>
          <div className="mt-1 flex flex-wrap gap-2 text-[10px] uppercase tracking-wide text-[#d8cbb7]/60">
            <span>{hoveredNode.issue.statusName}</span>
            <span>{hoveredNode.issue.priority ?? "low"}</span>
            <span>{hoveredNode.issue.issueType ?? "task"}</span>
          </div>
        </div>
      )}
    </div>
  );
}

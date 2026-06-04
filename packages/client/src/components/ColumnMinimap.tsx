import { useCallback, useEffect, useRef, useState } from "react";
import type { IssueWithStatus } from "@agentic-kanban/shared";

const MAX_TICKS = 60;

interface ColumnMinimapProps {
  issues: IssueWithStatus[];
  totalScrollHeight: number;
  scrollContainerRef: React.RefObject<HTMLDivElement>;
}

export function ColumnMinimap({ issues, totalScrollHeight, scrollContainerRef }: ColumnMinimapProps) {
  const railRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [clientHeight, setClientHeight] = useState(0);
  const [railHeight, setRailHeight] = useState(0);
  const [hoveredTick, setHoveredTick] = useState<number | null>(null);
  const isDragging = useRef(false);

  const tickCount = Math.min(issues.length, MAX_TICKS);
  const tickGroupSize = tickCount > 0 ? Math.ceil(issues.length / tickCount) : 1;

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    function update() {
      const container = scrollContainerRef.current;
      if (!container) return;
      setScrollTop(container.scrollTop);
      setClientHeight(container.clientHeight);
    }
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [scrollContainerRef]);

  useEffect(() => {
    const el = railRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (railRef.current) setRailHeight(railRef.current.clientHeight);
    });
    ro.observe(el);
    setRailHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const scrollToY = useCallback(
    (clientY: number) => {
      const rail = railRef.current;
      const container = scrollContainerRef.current;
      if (!rail || !container) return;
      const rect = rail.getBoundingClientRect();
      const y = Math.max(0, Math.min(clientY - rect.top, rect.height));
      container.scrollTop = (y / rect.height) * totalScrollHeight;
    },
    [totalScrollHeight, scrollContainerRef],
  );

  function handleMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    isDragging.current = true;
    scrollToY(e.clientY);
    function onMove(ev: MouseEvent) {
      if (isDragging.current) scrollToY(ev.clientY);
    }
    function onUp() {
      isDragging.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function handleMouseMove(e: React.MouseEvent) {
    if (tickCount === 0 || !railRef.current) return;
    const rect = railRef.current.getBoundingClientRect();
    const y = e.clientY - rect.top;
    setHoveredTick(Math.max(0, Math.min(Math.floor((y / rect.height) * tickCount), tickCount - 1)));
  }

  const indicatorTop =
    totalScrollHeight > 0 && railHeight > 0
      ? (scrollTop / totalScrollHeight) * railHeight
      : 0;
  const indicatorHeight =
    totalScrollHeight > 0 && railHeight > 0
      ? Math.max(12, (clientHeight / totalScrollHeight) * railHeight)
      : 0;

  const hoveredIssue =
    hoveredTick !== null
      ? issues[Math.min(hoveredTick * tickGroupSize, issues.length - 1)]
      : null;

  const tooltipTop =
    hoveredTick !== null && railHeight > 0 && tickCount > 0
      ? Math.max(0, ((hoveredTick + 0.5) / tickCount) * railHeight - 12)
      : 0;

  return (
    <div
      ref={railRef}
      className="relative ml-1 w-2 flex-shrink-0 cursor-pointer select-none overflow-visible"
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseLeave={() => setHoveredTick(null)}
      aria-label="Column minimap"
      role="scrollbar"
      aria-controls="completed-grid-scroll"
      aria-valuenow={totalScrollHeight > 0 ? Math.round((scrollTop / totalScrollHeight) * 100) : 0}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      {/* Tick segments */}
      <div className="absolute inset-0 flex flex-col gap-px overflow-hidden rounded-sm">
        {Array.from({ length: tickCount }, (_, i) => (
          <div
            key={i}
            className={`flex-1 transition-colors ${
              hoveredTick === i
                ? "bg-brand-400 dark:bg-brand-500"
                : "bg-gray-200 dark:bg-gray-700"
            }`}
          />
        ))}
      </div>

      {/* Viewport indicator */}
      {indicatorHeight > 0 && (
        <div
          className="pointer-events-none absolute left-0 right-0 z-10 rounded-sm border border-brand-500 bg-brand-400/40 dark:border-brand-400 dark:bg-brand-500/40"
          style={{ top: indicatorTop, height: indicatorHeight }}
        />
      )}

      {/* Hover tooltip */}
      {hoveredIssue && (
        <div
          className="pointer-events-none absolute z-50 max-w-[180px] overflow-hidden text-ellipsis whitespace-nowrap rounded bg-gray-900 px-1.5 py-0.5 text-xs text-white shadow-lg dark:bg-gray-100 dark:text-gray-900"
          style={{ top: tooltipTop, right: "calc(100% + 8px)" }}
        >
          {hoveredIssue.issueNumber != null && (
            <span className="mr-1 font-mono opacity-70">#{hoveredIssue.issueNumber}</span>
          )}
          {hoveredIssue.title}
        </div>
      )}
    </div>
  );
}

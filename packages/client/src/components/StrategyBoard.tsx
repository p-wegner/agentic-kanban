import { useRef } from "react";
import { BRAND } from "../lib/chartColors";
import { clampWeight, matchesSegment } from "../lib/strategy-targets.js";
import type { StrategySegment } from "../lib/strategy-targets.js";
import type { IssueWithStatus } from "@agentic-kanban/shared";

export function StrategyBoard({
  segments,
  issues,
  selectedId,
  onSelect,
  onPlace,
}: {
  segments: StrategySegment[];
  issues: IssueWithStatus[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onPlace: (id: string, weight: number) => void;
}) {
  const size = 420;
  const center = size / 2;
  const maxRadius = 188;
  const minRadius = 36;
  const svgRef = useRef<SVGSVGElement | null>(null);

  function radiusForWeight(weight: number) {
    return minRadius + ((5 - clampWeight(weight)) / 4) * (maxRadius - minRadius);
  }

  function pointerToPlacement(event: React.PointerEvent<SVGSVGElement>) {
    const svg = svgRef.current;
    if (!svg || segments.length === 0) return null;
    const rect = svg.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * size - center;
    const y = ((event.clientY - rect.top) / rect.height) * size - center;
    const angle = (Math.atan2(y, x) + Math.PI / 2 + Math.PI * 2) % (Math.PI * 2);
    const segmentIndex = Math.min(segments.length - 1, Math.floor(angle / ((Math.PI * 2) / segments.length)));
    const distance = Math.max(0, Math.min(maxRadius, Math.hypot(x, y)));
    const normalized = Math.max(0, Math.min(1, (distance - minRadius) / (maxRadius - minRadius)));
    return { id: segments[segmentIndex].id, weight: clampWeight(5 - normalized * 4) };
  }

  function handlePointer(event: React.PointerEvent<SVGSVGElement>) {
    const placement = pointerToPlacement(event);
    if (!placement) return;
    onSelect(placement.id);
    onPlace(placement.id, placement.weight);
  }

  const plotted = segments.map((segment, index) => {
    const angle = ((index + 0.5) / Math.max(segments.length, 1)) * Math.PI * 2 - Math.PI / 2;
    const radius = radiusForWeight(segment.weight);
    const count = issues.filter((issue) => matchesSegment(issue, segment)).length;
    return { segment, count, angle, x: center + Math.cos(angle) * radius, y: center + Math.sin(angle) * radius };
  });

  return (
    <div className="relative mx-auto w-full max-w-[460px] aspect-square">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${size} ${size}`}
        className="h-full w-full touch-none"
        role="img"
        aria-label={`Strategy bullseye: ${segments.length} segment${segments.length === 1 ? "" : "s"}, drag a marker toward the centre to raise its priority. A keyboard-accessible list of the same segments is below.`}
        onPointerDown={handlePointer}
        onPointerMove={(event) => {
          if (event.buttons === 1) handlePointer(event);
        }}
      >
        <defs>
          <radialGradient id="strategy-board-fill" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#fff7ed" />
            <stop offset="58%" stopColor="#f6efe7" />
            <stop offset="100%" stopColor="#e7dfd4" />
          </radialGradient>
        </defs>
        <circle cx={center} cy={center} r="196" fill="url(#strategy-board-fill)" stroke="#d7cfc3" strokeWidth="1.5" />
        {[188, 150, 112, 74, 36].map((radius, index) => (
          <circle
            key={radius}
            cx={center}
            cy={center}
            r={radius}
            fill={index % 2 === 0 ? "rgba(194,95,54,0.05)" : "rgba(84,116,70,0.06)"}
            stroke="#d7cfc3"
            strokeWidth="1"
          />
        ))}
        {segments.map((segment, index) => {
          const angle = (index / Math.max(segments.length, 1)) * Math.PI * 2 - Math.PI / 2;
          const x = center + Math.cos(angle) * 194;
          const y = center + Math.sin(angle) * 194;
          return <line key={segment.id} x1={center} y1={center} x2={x} y2={y} stroke="#d7cfc3" strokeWidth="1" strokeDasharray="5 7" />;
        })}
        <circle cx={center} cy={center} r="9" fill={BRAND} />
        <text x={center} y={center + 30} textAnchor="middle" fontSize="10" fontWeight="700" fill="#8a8175">
          highest
        </text>
        <text x={center} y="34" textAnchor="middle" fontSize="10" fill="#8a8175">lower priority</text>
        {plotted.map(({ segment, count, x, y, angle }) => {
          const selected = segment.id === selectedId;
          const labelRadius = maxRadius - 10;
          const cos = Math.cos(angle);
          const sin = Math.sin(angle);
          let labelX = center + cos * labelRadius;
          let labelY = center + sin * labelRadius;
          let labelAnchor: "start" | "middle" | "end" = "middle";
          if (cos < -0.75) {
            labelX = 24;
            labelY -= 24;
            labelAnchor = "start";
          } else if (cos > 0.75) {
            labelX = size - 24;
            labelY -= 24;
            labelAnchor = "end";
          }
          const markerRadius = 13 + segment.weight * 2;
          return (
            <g key={segment.id} onPointerDown={() => onSelect(segment.id)} className="cursor-grab active:cursor-grabbing">
              <text x={labelX} y={labelY} textAnchor={labelAnchor} fontSize="10" fontWeight="700" fill="#4b5563">
                {segment.label.slice(0, 16)}
              </text>
              <line x1={center} y1={center} x2={x} y2={y} stroke={segment.color} strokeWidth="1.5" opacity="0.42" />
              <circle
                cx={x}
                cy={y}
                r={markerRadius}
                fill={segment.color}
                opacity={selected ? 0.96 : 0.82}
                stroke={selected ? "#111827" : "white"}
                strokeWidth={selected ? 2.5 : 2}
              />
              <text x={x} y={y + 4} textAnchor="middle" fontSize="12" fontWeight="800" fill="white">
                {segment.weight}
              </text>
              <text x={x} y={y + markerRadius + 14} textAnchor="middle" fontSize="10" fontWeight="700" fill="#4b5563">
                {count}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

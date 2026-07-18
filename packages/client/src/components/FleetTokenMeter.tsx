import { useEffect, useRef, useState } from "react";
import type { StatusWithIssues } from "@agentic-kanban/shared";
import type { LiveSessionStats } from "../lib/useBoardEvents.js";
import { useFleetLiveStats } from "../hooks/useFleetLiveStats.js";
import type { FleetProvider } from "../lib/fleetLiveStats.js";

interface FleetTokenMeterProps {
  liveStats: Record<string, LiveSessionStats>;
  columns: StatusWithIssues[];
  sessionActivity: Record<string, string>;
}

const PROVIDER_LABEL: Record<FleetProvider, string> = {
  claude: "Claude",
  codex: "Codex",
  copilot: "Copilot",
  pi: "Pi",
  unknown: "Other",
};

/** Compact token count: 1234 → "1.2k", 1_200_000 → "1.2M". */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toLocaleString("en-US", { maximumFractionDigits: 1 })}M`;
  if (n >= 1_000) return `${(n / 1_000).toLocaleString("en-US", { maximumFractionDigits: 1 })}k`;
  return n.toLocaleString("en-US");
}

/** USD estimate: sub-cent shows "<$0.01", otherwise 2–4 sig places. */
function formatCost(usd: number): string {
  if (usd <= 0) return "$0.00";
  if (usd < 0.01) return "<$0.01";
  const digits = usd < 1 ? 3 : 2;
  return `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: digits })}`;
}

export function FleetTokenMeter({ liveStats, columns, sessionActivity }: FleetTokenMeterProps) {
  const fleet = useFleetLiveStats({ liveStats, columns, sessionActivity });
  const [expanded, setExpanded] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!expanded) return;
    function handleClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setExpanded(false);
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setExpanded(false);
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [expanded]);

  const idle = fleet.activeAgentCount === 0;

  // Idle: a quiet, non-interactive chip so the meter is always visible without
  // erroring when nothing is running.
  if (idle) {
    return (
      <div
        data-testid="fleet-token-meter"
        data-idle="true"
        title="No active agents — fleet token meter idle"
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-gray-400 shrink-0" />
        <span className="text-xs font-medium text-gray-500 dark:text-gray-400">fleet idle</span>
      </div>
    );
  }

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        data-testid="fleet-token-meter"
        data-idle="false"
        onClick={() => setExpanded((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={expanded}
        title={`${fleet.activeAgentCount} active agent${fleet.activeAgentCount === 1 ? "" : "s"} · ${formatTokens(fleet.totalContextTokens)} context tokens · ~${formatCost(fleet.estimatedCostUsd)} est. — click for per-agent breakdown`}
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-50 dark:bg-emerald-950 border border-emerald-200 dark:border-emerald-800 hover:bg-emerald-100 dark:hover:bg-emerald-900 transition-colors"
      >
        <span className="relative flex h-2 w-2">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
        </span>
        <span className="text-xs font-semibold text-emerald-700 dark:text-emerald-300" data-testid="fleet-agent-count">
          {fleet.activeAgentCount}
        </span>
        <span className="text-xs text-emerald-600 dark:text-emerald-400">·</span>
        <span className="text-xs font-semibold text-emerald-700 dark:text-emerald-300" data-testid="fleet-context-tokens">
          {formatTokens(fleet.totalContextTokens)}
        </span>
        <span className="text-xs text-emerald-600 dark:text-emerald-400">tok</span>
        <span className="text-xs text-emerald-600 dark:text-emerald-400">·</span>
        <span className="text-xs font-semibold text-emerald-700 dark:text-emerald-300" data-testid="fleet-cost">
          ~{formatCost(fleet.estimatedCostUsd)}
        </span>
        <svg className={`w-2.5 h-2.5 text-emerald-500 transition-transform ${expanded ? "rotate-180" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
        </svg>
      </button>

      {expanded && (
        <div
          role="dialog"
          aria-label="Fleet token &amp; cost breakdown"
          data-testid="fleet-token-meter-popover"
          className="absolute top-full left-0 mt-1 z-30 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-3 shadow-lg flex flex-col gap-3"
        >
          {/* Fleet headline */}
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold text-gray-800 dark:text-gray-100">
              {fleet.activeAgentCount} active agent{fleet.activeAgentCount === 1 ? "" : "s"}
            </span>
            <span className="text-gray-500 dark:text-gray-400">
              {formatTokens(fleet.totalContextTokens)} tok · ~{formatCost(fleet.estimatedCostUsd)}
            </span>
          </div>

          {/* Per-provider split */}
          <div className="flex items-center gap-1.5 flex-wrap">
            {fleet.byProvider.map((p) => (
              <div
                key={p.key}
                className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium text-brand-700 dark:text-brand-300 bg-brand-50 dark:bg-brand-900/40 border border-brand-200 dark:border-brand-700"
                title={`${p.agentCount} agent${p.agentCount === 1 ? "" : "s"} · ${formatTokens(p.contextTokens)} tok · ~${formatCost(p.estimatedCostUsd)}`}
              >
                <span className="w-1.5 h-1.5 rounded-full bg-brand-500 shrink-0" />
                <span>{PROVIDER_LABEL[p.key as FleetProvider] ?? p.key}</span>
                <span className="font-bold">{p.agentCount}</span>
              </div>
            ))}
          </div>

          {/* Per-agent breakdown */}
          <div className="flex flex-col gap-1.5 max-h-64 overflow-y-auto">
            {fleet.agents.map((a) => (
              <div
                key={a.issueId}
                data-testid="fleet-agent-row"
                className="flex flex-col gap-0.5 rounded border border-gray-100 dark:border-gray-800 px-2 py-1.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-gray-800 dark:text-gray-100 truncate">
                    {a.issueNumber !== null && (
                      <span className="text-gray-400 dark:text-gray-500">#{a.issueNumber} </span>
                    )}
                    {a.title}
                  </span>
                  <span className="text-[11px] text-gray-500 dark:text-gray-400 shrink-0">
                    {formatTokens(a.contextTokens)} · ~{formatCost(a.estimatedCostUsd)}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-[10px] text-gray-500 dark:text-gray-400">
                  <span className="truncate">{a.model || "unknown"}</span>
                  {a.subagentCount > 0 && <span className="shrink-0">+{a.subagentCount} sub</span>}
                  {a.lastTool && <span className="truncate italic">{a.lastTool}</span>}
                </div>
              </div>
            ))}
          </div>

          <p className="text-[10px] text-gray-400 dark:text-gray-500 leading-snug">
            Cost is a live estimate from each agent's context tokens × published input-token
            list price — not billing-grade.
          </p>
        </div>
      )}
    </div>
  );
}

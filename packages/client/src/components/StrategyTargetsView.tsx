import { useEffect, useMemo, useRef, useState } from "react";
import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";
import { ACCENT, BRAND, PRIORITY_META, TYPE_COLORS } from "../lib/chartColors";
import { apiFetch } from "../lib/api.js";
import { showToast } from "./Toast.js";

type SegmentKind = "work-type" | "provider" | "area" | "custom";
type Provider = "" | "claude" | "codex" | "copilot";
type ProviderPolicyMode = "fill" | "throttle" | "fallback-only";

interface StrategySegment {
  id: string;
  label: string;
  description: string;
  kind: SegmentKind;
  weight: number;
  color: string;
  keywords: string;
  provider: Provider;
}

interface ProviderProfilePolicy {
  id: string;
  provider: "claude" | "codex" | "copilot";
  profileName: string;
  label: string;
  mode: ProviderPolicyMode;
  headroomPct: number;
  notes: string;
}

interface StrategyConfig {
  version: number;
  activeAgentsTarget: number;
  backlogFloor: number;
  maxNewStartsPerCycle: number;
  segments: StrategySegment[];
  providerPolicies: ProviderProfilePolicy[];
}

interface StrategyTargetsViewProps {
  columns: StatusWithIssues[];
  projectId: string;
  onIssueClick: (issue: IssueWithStatus) => void;
  searchQuery?: string;
}

const DEFAULT_CONFIG: StrategyConfig = {
  version: 1,
  activeAgentsTarget: 4,
  backlogFloor: 10,
  maxNewStartsPerCycle: 2,
  segments: [
    { id: "work-bugfix", label: "Bugfix", description: "Real, reproducible defects and regressions.", kind: "work-type", weight: 5, color: BRAND, keywords: "bug bugfix fix defect regression", provider: "" },
    { id: "work-feature", label: "Feature", description: "New product capability and workflow improvements.", kind: "work-type", weight: 3, color: "#5b7a8c", keywords: "feature enhancement product workflow", provider: "" },
    { id: "work-quality", label: "Quality", description: "Reliability, safeguards, and review improvements.", kind: "work-type", weight: 3, color: ACCENT, keywords: "quality reliability guardrail review", provider: "" },
    { id: "work-ux", label: "UX", description: "Interface polish, usability, and interaction design.", kind: "work-type", weight: 2, color: "#8b6f9f", keywords: "ux ui design usability", provider: "" },
    { id: "area-backend", label: "Backend", description: "Server, database, and orchestration areas.", kind: "area", weight: 2, color: "#547446", keywords: "server backend database api", provider: "codex" },
    { id: "area-frontend", label: "Frontend", description: "Client-side views and interaction flows.", kind: "area", weight: 2, color: "#c79a3e", keywords: "frontend client view ui", provider: "claude" },
  ],
  providerPolicies: [],
};

const POLICY_MODE_LABELS: Record<ProviderPolicyMode, string> = {
  "fill": "Fill",
  "throttle": "Throttle",
  "fallback-only": "Fallback only",
};

const POLICY_MODE_DESCRIPTIONS: Record<ProviderPolicyMode, string> = {
  "fill": "Keep busy at all times. Ideal for time-windowed plans that reset frequently (e.g. hourly/daily).",
  "throttle": "Use for main work but preserve headroom. Set a headroom % to avoid exhausting the window.",
  "fallback-only": "Use only when no better option is available, or on explicit user request. Ideal for token-based / cost-per-request gateways.",
};

const KIND_LABELS: Record<SegmentKind, string> = {
  "work-type": "Work type",
  provider: "Provider",
  area: "Area",
  custom: "Custom",
};

function settingsKey(projectId: string) {
  return `board_strategy_${projectId}`;
}

function clampWeight(value: number) {
  return Math.max(1, Math.min(5, Math.round(value || 1)));
}

function clampPolicy(value: number, fallback: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.round(Number.isFinite(value) ? value : fallback)));
}

function normalizeSegment(segment: Partial<StrategySegment>, index: number): StrategySegment {
  const fallback = DEFAULT_CONFIG.segments[index % DEFAULT_CONFIG.segments.length] ?? DEFAULT_CONFIG.segments[0];
  return {
    id: segment.id || `segment-${Date.now()}-${index}`,
    label: segment.label || fallback.label,
    description: segment.description ?? fallback.description,
    kind: segment.kind ?? fallback.kind,
    weight: clampWeight(segment.weight ?? fallback.weight),
    color: segment.color || fallback.color || BRAND,
    keywords: segment.keywords ?? fallback.keywords,
    provider: segment.provider ?? "",
  };
}

function normalizeProviderPolicy(p: Partial<ProviderProfilePolicy>, index: number): ProviderProfilePolicy {
  const provider = (["claude", "codex", "copilot"].includes(p.provider ?? "") ? p.provider : "claude") as "claude" | "codex" | "copilot";
  const profileName = typeof p.profileName === "string" ? p.profileName : "";
  const id = p.id || `policy-${provider}-${profileName || index}`;
  const validModes: ProviderPolicyMode[] = ["fill", "throttle", "fallback-only"];
  return {
    id,
    provider,
    profileName,
    label: typeof p.label === "string" && p.label.trim() ? p.label : `${provider}${profileName ? `:${profileName}` : ""}`,
    mode: (validModes.includes(p.mode as ProviderPolicyMode) ? p.mode : "throttle") as ProviderPolicyMode,
    headroomPct: clampPolicy(Number(p.headroomPct ?? 20), 20, 0, 100),
    notes: typeof p.notes === "string" ? p.notes : "",
  };
}

function normalizeConfig(raw: unknown): StrategyConfig {
  const parsed = raw && typeof raw === "object" ? raw as Partial<StrategyConfig> : {};
  const segments = Array.isArray(parsed.segments)
    ? parsed.segments.map((segment, index) => normalizeSegment(segment, index)).filter((segment) => segment.label.trim())
    : DEFAULT_CONFIG.segments;
  const providerPolicies = Array.isArray(parsed.providerPolicies)
    ? parsed.providerPolicies.map((p, i) => normalizeProviderPolicy(p, i))
    : [];
  return {
    version: 1,
    activeAgentsTarget: clampPolicy(Number(parsed.activeAgentsTarget), DEFAULT_CONFIG.activeAgentsTarget, 1, 12),
    backlogFloor: clampPolicy(Number(parsed.backlogFloor), DEFAULT_CONFIG.backlogFloor, 0, 100),
    maxNewStartsPerCycle: clampPolicy(Number(parsed.maxNewStartsPerCycle), DEFAULT_CONFIG.maxNewStartsPerCycle, 1, 12),
    segments: segments.length > 0 ? segments : DEFAULT_CONFIG.segments,
    providerPolicies,
  };
}

function normalizeToken(value: string) {
  return value.trim().toLowerCase();
}

function segmentTokens(segment: StrategySegment) {
  return `${segment.label} ${segment.description} ${segment.keywords}`
    .split(/[\s,;#]+/)
    .map(normalizeToken)
    .filter((token) => token.length >= 3);
}

function issueSearchText(issue: IssueWithStatus) {
  const tags = issue.tags?.map((tag) => tag.name).join(" ") ?? "";
  return `${issue.title} ${issue.description ?? ""} ${issue.issueType} ${issue.priority} ${issue.statusName} ${tags}`.toLowerCase();
}

function matchesSegment(issue: IssueWithStatus, segment: StrategySegment) {
  const text = issueSearchText(issue);
  return segmentTokens(segment).some((token) => text.includes(token));
}

function deriveRefillFocus(segments: StrategySegment[]) {
  const workSegments = segments.filter((segment) => segment.kind === "work-type");
  const bugfix = workSegments.filter((segment) => /bug|fix|defect|regression/i.test(`${segment.label} ${segment.keywords}`)).reduce((sum, segment) => sum + segment.weight, 0);
  const other = workSegments.filter((segment) => !/bug|fix|defect|regression/i.test(`${segment.label} ${segment.keywords}`)).reduce((sum, segment) => sum + segment.weight, 0);
  return bugfix > 0 && bugfix >= other ? "bugfix-only" : "balanced";
}

function makeAgentBrief(config: StrategyConfig, issues: IssueWithStatus[]) {
  const top = [...config.segments].sort((a, b) => b.weight - a.weight).slice(0, 4);
  const policyLines = config.providerPolicies.length > 0
    ? [
        "",
        "Provider policies:",
        ...config.providerPolicies.map((p) => {
          const headroom = p.mode === "throttle" ? ` (headroom ${p.headroomPct}%)` : "";
          return `- ${p.label} [${p.provider}:${p.profileName}]: ${POLICY_MODE_LABELS[p.mode]}${headroom}${p.notes ? ` — ${p.notes}` : ""}`;
        }),
      ]
    : [];
  return [
    "Strategy Bullseye monitor policy:",
    `ACTIVE_AGENTS_TARGET=${config.activeAgentsTarget}, BACKLOG_FLOOR=${config.backlogFloor}, MAX_NEW_STARTS_PER_CYCLE=${config.maxNewStartsPerCycle}, REFILL_FOCUS=${deriveRefillFocus(config.segments)}.`,
    ...top.map((segment, index) => {
      const matches = issues.filter((issue) => matchesSegment(issue, segment)).length;
      const provider = segment.provider ? `, provider ${segment.provider}` : "";
      return `${index + 1}. ${segment.label} (${KIND_LABELS[segment.kind]}, weight ${segment.weight}/5${provider}): ${segment.description} Current matching tickets: ${matches}.`;
    }),
    ...policyLines,
  ].join("\n");
}

function StrategyBoard({
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

export function StrategyTargetsView({ columns, projectId, onIssueClick, searchQuery }: StrategyTargetsViewProps) {
  const allIssues = useMemo(() => columns.flatMap((column) => column.issues), [columns]);
  const [config, setConfig] = useState<StrategyConfig>(DEFAULT_CONFIG);
  const [selectedId, setSelectedId] = useState<string | null>(DEFAULT_CONFIG.segments[0]?.id ?? null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [copied, setCopied] = useState(false);
  const key = useMemo(() => settingsKey(projectId), [projectId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiFetch<Record<string, string>>("/api/preferences/settings")
      .then((settings) => {
        if (cancelled) return;
        const raw = settings[key];
        const next = raw ? normalizeConfig(JSON.parse(raw)) : DEFAULT_CONFIG;
        setConfig(next);
        setSelectedId(next.segments[0]?.id ?? null);
        setDirty(false);
      })
      .catch(() => {
        if (cancelled) return;
        setConfig(DEFAULT_CONFIG);
        setSelectedId(DEFAULT_CONFIG.segments[0]?.id ?? null);
        showToast("Failed to load Strategy Bullseye", "error");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [key]);

  const selectedSegment = config.segments.find((segment) => segment.id === selectedId) ?? config.segments[0] ?? null;
  const visibleIssues = useMemo(() => {
    if (!selectedSegment) return [];
    const matches = allIssues.filter((issue) => matchesSegment(issue, selectedSegment));
    if (!searchQuery) return matches;
    const query = searchQuery.toLowerCase();
    return matches.filter((issue) => issueSearchText(issue).includes(query));
  }, [allIssues, searchQuery, selectedSegment]);

  const segmentStats = useMemo(() => {
    return config.segments.map((segment) => {
      const matches = allIssues.filter((issue) => matchesSegment(issue, segment));
      const active = matches.filter((issue) => !["Done", "Cancelled"].includes(issue.statusName)).length;
      return { segment, matches: matches.length, active };
    });
  }, [allIssues, config.segments]);

  const agentBrief = useMemo(() => makeAgentBrief(config, allIssues), [config, allIssues]);
  const refillFocus = useMemo(() => deriveRefillFocus(config.segments), [config.segments]);

  function setConfigDirty(updater: (prev: StrategyConfig) => StrategyConfig) {
    setConfig((prev) => updater(prev));
    setDirty(true);
  }

  function updateSegment(id: string, patch: Partial<StrategySegment>) {
    setConfigDirty((prev) => ({
      ...prev,
      segments: prev.segments.map((segment) =>
        segment.id === id
          ? { ...segment, ...patch, weight: patch.weight !== undefined ? clampWeight(patch.weight) : segment.weight }
          : segment,
      ),
    }));
  }

  function addSegment() {
    const color = PRIORITY_META[config.segments.length % PRIORITY_META.length]?.color ?? BRAND;
    const id = `segment-${Date.now()}`;
    setConfigDirty((prev) => ({
      ...prev,
      segments: [
        ...prev.segments,
        {
          id,
          label: "New segment",
          description: "Describe the kind of work this wedge represents.",
          kind: "custom",
          weight: 3,
          color,
          keywords: "strategy",
          provider: "",
        },
      ],
    }));
    setSelectedId(id);
  }

  function removeSegment(id: string) {
    setConfigDirty((prev) => {
      const next = prev.segments.filter((segment) => segment.id !== id);
      setSelectedId(next[0]?.id ?? null);
      return { ...prev, segments: next };
    });
  }

  function resetBullseye() {
    setConfigDirty(() => DEFAULT_CONFIG);
    setSelectedId(DEFAULT_CONFIG.segments[0]?.id ?? null);
  }

  async function saveBullseye() {
    setSaving(true);
    try {
      const payload = normalizeConfig(config);
      await apiFetch("/api/preferences/settings", {
        method: "PUT",
        body: JSON.stringify({ [key]: JSON.stringify(payload) }),
      });
      setConfig(payload);
      setDirty(false);
      showToast("Strategy Bullseye saved", "success");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to save Strategy Bullseye", "error");
    } finally {
      setSaving(false);
    }
  }

  function copyBrief() {
    navigator.clipboard.writeText(agentBrief).then(() => {
      setCopied(true);
      showToast("Strategy brief copied", "success");
      setTimeout(() => setCopied(false), 1500);
    });
  }

  function addProviderPolicy() {
    const id = `policy-${Date.now()}`;
    setConfigDirty((prev) => ({
      ...prev,
      providerPolicies: [
        ...prev.providerPolicies,
        { id, provider: "claude", profileName: "", label: "Claude: Default", mode: "throttle", headroomPct: 20, notes: "" },
      ],
    }));
  }

  function updateProviderPolicy(id: string, patch: Partial<ProviderProfilePolicy>) {
    setConfigDirty((prev) => ({
      ...prev,
      providerPolicies: prev.providerPolicies.map((p) =>
        p.id === id ? { ...p, ...patch } : p,
      ),
    }));
  }

  function removeProviderPolicy(id: string) {
    setConfigDirty((prev) => ({
      ...prev,
      providerPolicies: prev.providerPolicies.filter((p) => p.id !== id),
    }));
  }

  return (
    <div className="flex-1 min-h-0 overflow-auto px-4 pb-6">
      <div className="mx-auto grid max-w-7xl grid-cols-1 gap-4 pt-3 xl:grid-cols-[minmax(360px,1fr)_minmax(520px,1.35fr)_minmax(320px,0.9fr)]">
        <section className="space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100">Strategy Bullseye</h2>
              <p className="text-xs text-gray-500 dark:text-gray-400">Place markers by wedge and ring to steer monitor priorities.</p>
            </div>
            <div className="flex items-center gap-1">
              <button type="button" onClick={addSegment} className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-gray-200 bg-white text-gray-600 shadow-sm transition-colors hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800" title="Add segment">
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.3}><path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14M5 12h14" /></svg>
              </button>
              <button type="button" onClick={resetBullseye} className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-gray-200 bg-white text-gray-600 shadow-sm transition-colors hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800" title="Reset bullseye">
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path strokeLinecap="round" strokeLinejoin="round" d="M3 3v5h5" /></svg>
              </button>
            </div>
          </div>

          <div className="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900">
            <div className="mb-2 flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100">Monitor policy</h3>
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${refillFocus === "bugfix-only" ? "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300" : "bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-300"}`}>
                REFILL_FOCUS {refillFocus}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {[
                ["activeAgentsTarget", "Agents", 1, 12],
                ["backlogFloor", "Backlog", 0, 100],
                ["maxNewStartsPerCycle", "Starts", 1, 12],
              ].map(([keyName, label, min, max]) => (
                <label key={keyName} className="block">
                  <span className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">{label}</span>
                  <input
                    type="number"
                    min={min as number}
                    max={max as number}
                    value={config[keyName as keyof Pick<StrategyConfig, "activeAgentsTarget" | "backlogFloor" | "maxNewStartsPerCycle">] as number}
                    onChange={(event) => {
                      const value = clampPolicy(Number(event.target.value), DEFAULT_CONFIG[keyName as keyof Pick<StrategyConfig, "activeAgentsTarget" | "backlogFloor" | "maxNewStartsPerCycle">] as number, min as number, max as number);
                      setConfigDirty((prev) => ({ ...prev, [keyName]: value }));
                    }}
                    className="w-full rounded-md border border-gray-200 bg-white px-2 py-1.5 text-sm text-gray-800 outline-none focus:border-brand-400 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                  />
                </label>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            {config.segments.map((segment) => {
              const selected = segment.id === selectedSegment?.id;
              const stats = segmentStats.find((entry) => entry.segment.id === segment.id);
              return (
                <button key={segment.id} type="button" onClick={() => setSelectedId(segment.id)} className={`w-full rounded-lg border p-3 text-left transition-colors ${selected ? "border-brand-400 bg-brand-50 dark:border-brand-700 dark:bg-brand-950/40" : "border-gray-200 bg-white hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:hover:bg-gray-800"}`}>
                  <div className="flex items-start gap-3">
                    <span className="mt-1 h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: segment.color }} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-gray-800 dark:text-gray-100">{segment.label}</span>
                      <span className="mt-1 line-clamp-2 block text-xs text-gray-500 dark:text-gray-400">{segment.description}</span>
                    </span>
                    <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-600 dark:bg-gray-800 dark:text-gray-300">{segment.weight}/5</span>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-gray-500 dark:text-gray-400">
                    <span>{KIND_LABELS[segment.kind]}</span>
                    {segment.provider && <span>{segment.provider}</span>}
                    <span>{stats?.matches ?? 0} tickets</span>
                    <span>{stats?.active ?? 0} active</span>
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        <section className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100">Bullseye</h2>
              <p className="text-xs text-gray-500 dark:text-gray-400">Center rings are strongest. Click or drag a marker's wedge to change its weight.</p>
            </div>
            <button type="button" onClick={saveBullseye} disabled={loading || saving || !dirty} className="rounded-md bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50">
              {saving ? "Saving..." : dirty ? "Save" : "Saved"}
            </button>
          </div>
          <StrategyBoard
            segments={config.segments}
            issues={allIssues}
            selectedId={selectedSegment?.id ?? null}
            onSelect={setSelectedId}
            onPlace={(id, weight) => updateSegment(id, { weight })}
          />
        </section>

        <section className="space-y-3">
          {selectedSegment && (
            <div className="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900">
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">Edit segment</h2>
                {config.segments.length > 1 && (
                  <button type="button" onClick={() => removeSegment(selectedSegment.id)} className="inline-flex h-7 w-7 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950" title="Remove segment">
                    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 7h12M9 7V5h6v2m-7 3v8m4-8v8m4-8v8M8 7l1 13h6l1-13" /></svg>
                  </button>
                )}
              </div>
              <div className="space-y-3">
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">Name</span>
                  <input value={selectedSegment.label} onChange={(event) => updateSegment(selectedSegment.id, { label: event.target.value })} className="w-full rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-sm text-gray-800 outline-none focus:border-brand-400 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100" />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">Description</span>
                  <textarea value={selectedSegment.description} onChange={(event) => updateSegment(selectedSegment.id, { description: event.target.value })} rows={3} className="w-full resize-none rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-sm text-gray-800 outline-none focus:border-brand-400 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100" />
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">Segment kind</span>
                    <select value={selectedSegment.kind} onChange={(event) => updateSegment(selectedSegment.id, { kind: event.target.value as SegmentKind })} className="w-full rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-sm text-gray-800 outline-none focus:border-brand-400 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100">
                      <option value="work-type">Work type</option>
                      <option value="provider">Provider</option>
                      <option value="area">Area</option>
                      <option value="custom">Custom</option>
                    </select>
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">Provider</span>
                    <select value={selectedSegment.provider} onChange={(event) => updateSegment(selectedSegment.id, { provider: event.target.value as Provider })} className="w-full rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-sm text-gray-800 outline-none focus:border-brand-400 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100">
                      <option value="">None</option>
                      <option value="claude">Claude</option>
                      <option value="codex">Codex</option>
                      <option value="copilot">Copilot</option>
                    </select>
                  </label>
                </div>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">Weight ring</span>
                  <input type="range" min="1" max="5" value={selectedSegment.weight} onChange={(event) => updateSegment(selectedSegment.id, { weight: Number(event.target.value) })} className="w-full accent-brand-600" />
                  <span className="text-xs font-semibold text-gray-600 dark:text-gray-300">{selectedSegment.weight}/5</span>
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">Keywords</span>
                  <input value={selectedSegment.keywords} onChange={(event) => updateSegment(selectedSegment.id, { keywords: event.target.value })} className="w-full rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-sm text-gray-800 outline-none focus:border-brand-400 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100" />
                </label>
              </div>
            </div>
          )}

          <div className="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">Provider policies</h2>
                <p className="text-xs text-gray-500 dark:text-gray-400">Define rate-limit strategy per provider profile. Steers which harness the orchestrator uses for new workspaces.</p>
              </div>
              <button type="button" onClick={addProviderPolicy} className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-gray-200 bg-white text-gray-600 shadow-sm transition-colors hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800" title="Add provider policy">
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.3}><path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14M5 12h14" /></svg>
              </button>
            </div>
            {config.providerPolicies.length === 0 ? (
              <p className="text-xs text-gray-400 dark:text-gray-500 italic">No policies — the globally-selected provider is always used.</p>
            ) : (
              <div className="space-y-3">
                {config.providerPolicies.map((policy) => (
                  <div key={policy.id} className="rounded-md border border-gray-100 bg-gray-50 p-3 dark:border-gray-800 dark:bg-gray-950">
                    <div className="mb-2 flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1 space-y-2">
                        <div className="grid grid-cols-2 gap-2">
                          <label className="block">
                            <span className="mb-1 block text-[11px] font-medium text-gray-500 dark:text-gray-400">Provider</span>
                            <select
                              value={policy.provider}
                              onChange={(event) => updateProviderPolicy(policy.id, { provider: event.target.value as "claude" | "codex" | "copilot" })}
                              className="w-full rounded-md border border-gray-200 bg-white px-2 py-1 text-xs text-gray-800 outline-none focus:border-brand-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                            >
                              <option value="claude">Claude</option>
                              <option value="codex">Codex</option>
                              <option value="copilot">Copilot</option>
                            </select>
                          </label>
                          <label className="block">
                            <span className="mb-1 block text-[11px] font-medium text-gray-500 dark:text-gray-400">Profile name</span>
                            <input
                              value={policy.profileName}
                              onChange={(event) => updateProviderPolicy(policy.id, { profileName: event.target.value })}
                              placeholder="default"
                              className="w-full rounded-md border border-gray-200 bg-white px-2 py-1 text-xs text-gray-800 outline-none focus:border-brand-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                            />
                          </label>
                        </div>
                        <label className="block">
                          <span className="mb-1 block text-[11px] font-medium text-gray-500 dark:text-gray-400">Display label</span>
                          <input
                            value={policy.label}
                            onChange={(event) => updateProviderPolicy(policy.id, { label: event.target.value })}
                            placeholder="e.g. Claude (andrena gateway)"
                            className="w-full rounded-md border border-gray-200 bg-white px-2 py-1 text-xs text-gray-800 outline-none focus:border-brand-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                          />
                        </label>
                        <label className="block">
                          <span className="mb-1 block text-[11px] font-medium text-gray-500 dark:text-gray-400">Mode</span>
                          <select
                            value={policy.mode}
                            onChange={(event) => updateProviderPolicy(policy.id, { mode: event.target.value as ProviderPolicyMode })}
                            className="w-full rounded-md border border-gray-200 bg-white px-2 py-1 text-xs text-gray-800 outline-none focus:border-brand-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                          >
                            <option value="fill">Fill — keep busy at all times</option>
                            <option value="throttle">Throttle — main work, preserve headroom</option>
                            <option value="fallback-only">Fallback only — last resort / explicit</option>
                          </select>
                          <span className="mt-1 block text-[10px] text-gray-400 dark:text-gray-500">{POLICY_MODE_DESCRIPTIONS[policy.mode]}</span>
                        </label>
                        {policy.mode === "throttle" && (
                          <label className="block">
                            <span className="mb-1 block text-[11px] font-medium text-gray-500 dark:text-gray-400">Headroom {policy.headroomPct}%</span>
                            <input
                              type="range" min="0" max="80" step="5"
                              value={policy.headroomPct}
                              onChange={(event) => updateProviderPolicy(policy.id, { headroomPct: Number(event.target.value) })}
                              className="w-full accent-brand-600"
                            />
                            <span className="text-[10px] text-gray-400 dark:text-gray-500">Leave {policy.headroomPct}% of the rate-limit window unused (e.g. for other projects).</span>
                          </label>
                        )}
                        <label className="block">
                          <span className="mb-1 block text-[11px] font-medium text-gray-500 dark:text-gray-400">Notes (optional)</span>
                          <input
                            value={policy.notes}
                            onChange={(event) => updateProviderPolicy(policy.id, { notes: event.target.value })}
                            placeholder="e.g. 5h/week plan, resets Monday"
                            className="w-full rounded-md border border-gray-200 bg-white px-2 py-1 text-xs text-gray-800 outline-none focus:border-brand-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                          />
                        </label>
                      </div>
                      <button type="button" onClick={() => removeProviderPolicy(policy.id)} className="mt-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-gray-400 transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950" title="Remove policy">
                        <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                      </button>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold ${policy.mode === "fill" ? "bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-300" : policy.mode === "throttle" ? "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300" : "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"}`}>
                        {POLICY_MODE_LABELS[policy.mode]}
                      </span>
                      <span className="text-[11px] text-gray-500 dark:text-gray-400">{policy.provider}{policy.profileName ? `:${policy.profileName}` : ""}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900">
            <div className="mb-2 flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">Monitor brief</h2>
              <button type="button" onClick={copyBrief} className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-gray-200 text-gray-500 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800" title={copied ? "Copied" : "Copy brief"}>
                {copied ? <svg className="h-4 w-4 text-accent-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg> : <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M8 8h10v12H8zM6 16H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>}
              </button>
            </div>
            <pre className="max-h-44 overflow-auto whitespace-pre-wrap rounded-md bg-gray-50 p-3 text-xs leading-relaxed text-gray-600 dark:bg-gray-950 dark:text-gray-300">{agentBrief}</pre>
          </div>

          <div className="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900">
            <h2 className="mb-2 text-sm font-semibold text-gray-800 dark:text-gray-100">Matching tickets</h2>
            {visibleIssues.length === 0 ? (
              <p className="text-xs text-gray-500 dark:text-gray-400">No current tickets match this segment.</p>
            ) : (
              <div className="max-h-64 space-y-1 overflow-auto pr-1">
                {visibleIssues.slice(0, 12).map((issue) => (
                  <button key={issue.id} type="button" onClick={() => onIssueClick(issue)} className="grid w-full grid-cols-[minmax(0,1fr)_auto] gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-gray-50 dark:hover:bg-gray-800">
                    <span className="min-w-0">
                      <span className="block truncate text-xs font-medium text-gray-700 dark:text-gray-200">#{issue.issueNumber} {issue.title}</span>
                      <span className="block text-[11px] text-gray-400 dark:text-gray-500">{issue.statusName} / {issue.priority}</span>
                    </span>
                    <span className="mt-0.5 h-2.5 w-2.5 rounded-full" style={{ backgroundColor: TYPE_COLORS[issue.issueType] ?? "#a8a195" }} />
                  </button>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

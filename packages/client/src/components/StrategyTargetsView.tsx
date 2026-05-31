import { useEffect, useMemo, useState } from "react";
import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";
import { ACCENT, BRAND, PRIORITY_META, TYPE_COLORS } from "../lib/chartColors";
import { showToast } from "./Toast.js";

interface StrategyTarget {
  id: string;
  label: string;
  description: string;
  weight: number;
  horizon: "now" | "next" | "later";
  color: string;
  keywords: string;
}

interface StrategyTargetsViewProps {
  columns: StatusWithIssues[];
  projectId: string;
  onIssueClick: (issue: IssueWithStatus) => void;
  searchQuery?: string;
}

const DEFAULT_TARGETS: StrategyTarget[] = [
  {
    id: "target-product-leverage",
    label: "Product leverage",
    description: "Features that unlock more useful workflows for the user.",
    weight: 5,
    horizon: "now",
    color: BRAND,
    keywords: "feature workflow view create automation",
  },
  {
    id: "target-agent-feedback",
    label: "Agent feedback",
    description: "Signals that tell agents what to prioritize when shaping new work.",
    weight: 4,
    horizon: "now",
    color: "#5b7a8c",
    keywords: "agent feedback focus priority butler monitor",
  },
  {
    id: "target-quality",
    label: "Quality guardrails",
    description: "Reliability, tests, review, and safeguards that keep changes shippable.",
    weight: 3,
    horizon: "next",
    color: ACCENT,
    keywords: "test review quality flaky guardrail reliability",
  },
  {
    id: "target-maintenance",
    label: "Maintenance drag",
    description: "Cleanup, simplification, and operational chores that reduce future friction.",
    weight: 2,
    horizon: "later",
    color: "#c79a3e",
    keywords: "cleanup chore refactor docs migration",
  },
];

const HORIZON_LABELS: Record<StrategyTarget["horizon"], string> = {
  now: "Now",
  next: "Next",
  later: "Later",
};

const HORIZON_RADIUS: Record<StrategyTarget["horizon"], number> = {
  now: 64,
  next: 112,
  later: 156,
};

function storageKey(projectId: string) {
  return `strategy-targets:${projectId}`;
}

function clampWeight(value: number) {
  return Math.max(1, Math.min(5, Math.round(value || 1)));
}

function normalizeToken(value: string) {
  return value.trim().toLowerCase();
}

function targetTokens(target: StrategyTarget) {
  const raw = `${target.label} ${target.description} ${target.keywords}`;
  return raw
    .split(/[\s,;#]+/)
    .map(normalizeToken)
    .filter((token) => token.length >= 3);
}

function issueSearchText(issue: IssueWithStatus) {
  const tags = issue.tags?.map((tag) => tag.name).join(" ") ?? "";
  return `${issue.title} ${issue.description ?? ""} ${issue.issueType} ${issue.priority} ${issue.statusName} ${tags}`.toLowerCase();
}

function matchesTarget(issue: IssueWithStatus, target: StrategyTarget) {
  const text = issueSearchText(issue);
  return targetTokens(target).some((token) => text.includes(token));
}

function makeAgentBrief(targets: StrategyTarget[], issues: IssueWithStatus[]) {
  const sorted = [...targets].sort((a, b) => b.weight - a.weight);
  const top = sorted.slice(0, 3);
  const lines = [
    "Strategic focus for new feature work:",
    ...top.map((target, index) => {
      const matches = issues.filter((issue) => matchesTarget(issue, target)).length;
      return `${index + 1}. ${target.label} (weight ${target.weight}/5, ${HORIZON_LABELS[target.horizon]}): ${target.description} Current matching tickets: ${matches}.`;
    }),
    "When proposing or creating new tickets, prefer ideas that move the highest-weight targets inward and call out which target each ticket supports.",
  ];
  return lines.join("\n");
}

function StrategyBoard({
  targets,
  issues,
  selectedId,
  onSelect,
}: {
  targets: StrategyTarget[];
  issues: IssueWithStatus[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const size = 420;
  const center = size / 2;
  const plotted = targets.map((target, index) => {
    const angle = (index / Math.max(targets.length, 1)) * Math.PI * 2 - Math.PI / 2;
    const radius = Math.max(38, HORIZON_RADIUS[target.horizon] - target.weight * 9);
    const count = issues.filter((issue) => matchesTarget(issue, target)).length;
    return {
      target,
      count,
      x: center + Math.cos(angle) * radius,
      y: center + Math.sin(angle) * radius,
    };
  });

  return (
    <div className="relative mx-auto w-full max-w-[460px] aspect-square">
      <svg viewBox={`0 0 ${size} ${size}`} className="h-full w-full">
        <defs>
          <radialGradient id="strategy-board-fill" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#fff7ed" />
            <stop offset="58%" stopColor="#f6efe7" />
            <stop offset="100%" stopColor="#e7dfd4" />
          </radialGradient>
        </defs>
        <circle cx={center} cy={center} r="196" fill="url(#strategy-board-fill)" stroke="#d7cfc3" strokeWidth="1.5" />
        {[164, 120, 78, 34].map((radius, index) => (
          <circle
            key={radius}
            cx={center}
            cy={center}
            r={radius}
            fill={index % 2 === 0 ? "rgba(194,95,54,0.06)" : "rgba(84,116,70,0.07)"}
            stroke="#d7cfc3"
            strokeWidth="1"
          />
        ))}
        <line x1={center} y1="20" x2={center} y2="400" stroke="#d7cfc3" strokeWidth="1" strokeDasharray="5 7" />
        <line x1="20" y1={center} x2="400" y2={center} stroke="#d7cfc3" strokeWidth="1" strokeDasharray="5 7" />
        <circle cx={center} cy={center} r="8" fill={BRAND} />
        <text x={center} y={center + 32} textAnchor="middle" fontSize="11" fontWeight="700" fill="#8a8175">
          agent focus
        </text>
        <text x={center} y="44" textAnchor="middle" fontSize="10" fill="#8a8175">Now</text>
        <text x={center} y="84" textAnchor="middle" fontSize="10" fill="#8a8175">Next</text>
        <text x={center} y="132" textAnchor="middle" fontSize="10" fill="#8a8175">Later</text>
        {plotted.map(({ target, count, x, y }) => {
          const selected = target.id === selectedId;
          const markerRadius = 13 + target.weight * 2;
          return (
            <g key={target.id} onClick={() => onSelect(target.id)} className="cursor-pointer">
              <line x1={center} y1={center} x2={x} y2={y} stroke={target.color} strokeWidth="1.5" opacity="0.45" />
              <circle
                cx={x}
                cy={y}
                r={markerRadius}
                fill={target.color}
                opacity={selected ? 0.96 : 0.82}
                stroke={selected ? "#111827" : "white"}
                strokeWidth={selected ? 2.5 : 2}
              />
              <text x={x} y={y + 4} textAnchor="middle" fontSize="12" fontWeight="800" fill="white">
                {target.weight}
              </text>
              <text
                x={x}
                y={y + markerRadius + 14}
                textAnchor="middle"
                fontSize="10"
                fontWeight="700"
                fill="#4b5563"
              >
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
  const [targets, setTargets] = useState<StrategyTarget[]>(DEFAULT_TARGETS);
  const [selectedId, setSelectedId] = useState<string | null>(DEFAULT_TARGETS[0]?.id ?? null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(storageKey(projectId));
      if (!stored) {
        setTargets(DEFAULT_TARGETS);
        setSelectedId(DEFAULT_TARGETS[0]?.id ?? null);
        return;
      }
      const parsed = JSON.parse(stored) as StrategyTarget[];
      const valid = parsed.filter((target) => target.id && target.label);
      setTargets(valid.length > 0 ? valid : DEFAULT_TARGETS);
      setSelectedId((valid[0] ?? DEFAULT_TARGETS[0])?.id ?? null);
    } catch {
      setTargets(DEFAULT_TARGETS);
      setSelectedId(DEFAULT_TARGETS[0]?.id ?? null);
    }
  }, [projectId]);

  useEffect(() => {
    localStorage.setItem(storageKey(projectId), JSON.stringify(targets));
  }, [projectId, targets]);

  const selectedTarget = targets.find((target) => target.id === selectedId) ?? targets[0] ?? null;
  const visibleIssues = useMemo(() => {
    if (!selectedTarget) return [];
    const matches = allIssues.filter((issue) => matchesTarget(issue, selectedTarget));
    if (!searchQuery) return matches;
    const query = searchQuery.toLowerCase();
    return matches.filter((issue) => issueSearchText(issue).includes(query));
  }, [allIssues, searchQuery, selectedTarget]);

  const targetStats = useMemo(() => {
    return targets.map((target) => {
      const matches = allIssues.filter((issue) => matchesTarget(issue, target));
      const active = matches.filter((issue) => !["Done", "Cancelled"].includes(issue.statusName)).length;
      return { target, matches: matches.length, active };
    });
  }, [allIssues, targets]);

  const agentBrief = useMemo(() => makeAgentBrief(targets, allIssues), [targets, allIssues]);

  function updateTarget(id: string, patch: Partial<StrategyTarget>) {
    setTargets((prev) =>
      prev.map((target) =>
        target.id === id
          ? {
              ...target,
              ...patch,
              weight: patch.weight !== undefined ? clampWeight(patch.weight) : target.weight,
            }
          : target,
      ),
    );
  }

  function addTarget() {
    const color = PRIORITY_META[targets.length % PRIORITY_META.length]?.color ?? BRAND;
    const id = `target-${Date.now()}`;
    setTargets((prev) => [
      ...prev,
      {
        id,
        label: "New direction",
        description: "Describe the strategic outcome this work should create.",
        weight: 3,
        horizon: "next",
        color,
        keywords: "feature outcome",
      },
    ]);
    setSelectedId(id);
  }

  function removeTarget(id: string) {
    setTargets((prev) => {
      const next = prev.filter((target) => target.id !== id);
      setSelectedId(next[0]?.id ?? null);
      return next;
    });
  }

  function resetTargets() {
    setTargets(DEFAULT_TARGETS);
    setSelectedId(DEFAULT_TARGETS[0]?.id ?? null);
  }

  function copyBrief() {
    navigator.clipboard.writeText(agentBrief).then(() => {
      setCopied(true);
      showToast("Strategy brief copied", "success");
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="flex-1 min-h-0 overflow-auto px-4 pb-6">
      <div className="mx-auto grid max-w-7xl grid-cols-1 gap-4 pt-3 xl:grid-cols-[minmax(360px,1fr)_minmax(520px,1.35fr)_minmax(320px,0.9fr)]">
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100">Strategic targets</h2>
              <p className="text-xs text-gray-500 dark:text-gray-400">Rubrics, epics, and directions for future feature work.</p>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={addTarget}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-gray-200 bg-white text-gray-600 shadow-sm transition-colors hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
                title="Add target"
              >
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.3}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14M5 12h14" />
                </svg>
              </button>
              <button
                type="button"
                onClick={resetTargets}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-gray-200 bg-white text-gray-600 shadow-sm transition-colors hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
                title="Reset targets"
              >
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 12a9 9 0 1 0 3-6.7L3 8" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 3v5h5" />
                </svg>
              </button>
            </div>
          </div>

          <div className="space-y-2">
            {targets.map((target) => {
              const selected = target.id === selectedTarget?.id;
              const stats = targetStats.find((entry) => entry.target.id === target.id);
              return (
                <button
                  key={target.id}
                  type="button"
                  onClick={() => setSelectedId(target.id)}
                  className={`w-full rounded-lg border p-3 text-left transition-colors ${
                    selected
                      ? "border-brand-400 bg-brand-50 dark:border-brand-700 dark:bg-brand-950/40"
                      : "border-gray-200 bg-white hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:hover:bg-gray-800"
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <span className="mt-1 h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: target.color }} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-gray-800 dark:text-gray-100">{target.label}</span>
                      <span className="mt-1 line-clamp-2 block text-xs text-gray-500 dark:text-gray-400">{target.description}</span>
                    </span>
                    <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                      {target.weight}/5
                    </span>
                  </div>
                  <div className="mt-2 flex items-center gap-2 text-[11px] text-gray-500 dark:text-gray-400">
                    <span>{HORIZON_LABELS[target.horizon]}</span>
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
              <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100">Target view</h2>
              <p className="text-xs text-gray-500 dark:text-gray-400">Higher weight and nearer horizon pull a direction toward the center.</p>
            </div>
            <div className="hidden items-center gap-2 text-[11px] text-gray-500 dark:text-gray-400 sm:flex">
              <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-brand-500" /> weight</span>
              <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-accent-500" /> ticket count</span>
            </div>
          </div>
          <StrategyBoard targets={targets} issues={allIssues} selectedId={selectedTarget?.id ?? null} onSelect={setSelectedId} />
        </section>

        <section className="space-y-3">
          {selectedTarget && (
            <div className="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900">
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">Edit target</h2>
                {targets.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeTarget(selectedTarget.id)}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950"
                    title="Remove target"
                  >
                    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 7h12M9 7V5h6v2m-7 3v8m4-8v8m4-8v8M8 7l1 13h6l1-13" />
                    </svg>
                  </button>
                )}
              </div>
              <div className="space-y-3">
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">Name</span>
                  <input
                    value={selectedTarget.label}
                    onChange={(event) => updateTarget(selectedTarget.id, { label: event.target.value })}
                    className="w-full rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-sm text-gray-800 outline-none focus:border-brand-400 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">Description</span>
                  <textarea
                    value={selectedTarget.description}
                    onChange={(event) => updateTarget(selectedTarget.id, { description: event.target.value })}
                    rows={3}
                    className="w-full resize-none rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-sm text-gray-800 outline-none focus:border-brand-400 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                  />
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">Weight</span>
                    <input
                      type="range"
                      min="1"
                      max="5"
                      value={selectedTarget.weight}
                      onChange={(event) => updateTarget(selectedTarget.id, { weight: Number(event.target.value) })}
                      className="w-full accent-brand-600"
                    />
                    <span className="text-xs font-semibold text-gray-600 dark:text-gray-300">{selectedTarget.weight}/5</span>
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">Horizon</span>
                    <select
                      value={selectedTarget.horizon}
                      onChange={(event) => updateTarget(selectedTarget.id, { horizon: event.target.value as StrategyTarget["horizon"] })}
                      className="w-full rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-sm text-gray-800 outline-none focus:border-brand-400 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                    >
                      <option value="now">Now</option>
                      <option value="next">Next</option>
                      <option value="later">Later</option>
                    </select>
                  </label>
                </div>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">Keywords</span>
                  <input
                    value={selectedTarget.keywords}
                    onChange={(event) => updateTarget(selectedTarget.id, { keywords: event.target.value })}
                    className="w-full rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-sm text-gray-800 outline-none focus:border-brand-400 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                  />
                </label>
              </div>
            </div>
          )}

          <div className="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900">
            <div className="mb-2 flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">Agent focus brief</h2>
              <button
                type="button"
                onClick={copyBrief}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-gray-200 text-gray-500 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                title={copied ? "Copied" : "Copy brief"}
              >
                {copied ? (
                  <svg className="h-4 w-4 text-accent-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8 8h10v12H8zM6 16H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                )}
              </button>
            </div>
            <pre className="max-h-44 overflow-auto whitespace-pre-wrap rounded-md bg-gray-50 p-3 text-xs leading-relaxed text-gray-600 dark:bg-gray-950 dark:text-gray-300">
              {agentBrief}
            </pre>
          </div>

          <div className="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900">
            <h2 className="mb-2 text-sm font-semibold text-gray-800 dark:text-gray-100">Matching tickets</h2>
            {visibleIssues.length === 0 ? (
              <p className="text-xs text-gray-500 dark:text-gray-400">No current tickets match this target.</p>
            ) : (
              <div className="max-h-64 space-y-1 overflow-auto pr-1">
                {visibleIssues.slice(0, 12).map((issue) => (
                  <button
                    key={issue.id}
                    type="button"
                    onClick={() => onIssueClick(issue)}
                    className="grid w-full grid-cols-[minmax(0,1fr)_auto] gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-gray-50 dark:hover:bg-gray-800"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-xs font-medium text-gray-700 dark:text-gray-200">
                        #{issue.issueNumber} {issue.title}
                      </span>
                      <span className="block text-[11px] text-gray-400 dark:text-gray-500">
                        {issue.statusName} / {issue.priority}
                      </span>
                    </span>
                    <span
                      className="mt-0.5 h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: TYPE_COLORS[issue.issueType] ?? "#a8a195" }}
                    />
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

import { useEffect, useMemo, useState } from "react";
import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";
import { BRAND, PRIORITY_META, TYPE_COLORS } from "../lib/chartColors";
import { apiFetch } from "../lib/api.js";
import { setSettings } from "../lib/settingsStore.js";
import { showToast } from "./Toast.js";

import { DEFAULT_CONFIG, POLICY_MODE_LABELS, POLICY_MODE_DESCRIPTIONS, KIND_LABELS, settingsKey, clampWeight, clampPolicy, normalizeConfig, issueSearchText, matchesSegment, deriveRefillFocus, makeAgentBrief } from "../lib/strategy-targets.js";
import type { SegmentKind, Provider, ProviderPolicyMode, StrategySegment, ProviderProfilePolicy, StrategyConfig, MonitorPolicyPreset } from "../lib/strategy-targets.js";
import { MonitorPolicyPresets } from "./MonitorPolicyPresets.js";
import { ProviderPolicyProfileField } from "./ProviderPolicyProfileField.js";
import { StrategyBoard } from "./StrategyBoard.js";

interface StrategyTargetsViewProps {
  columns: StatusWithIssues[];
  projectId: string;
  onIssueClick: (issue: IssueWithStatus) => void;
  searchQuery?: string;
}

/** Available profile names per provider, populated from the preferences profile endpoints. */
type ProfilesByProvider = Record<"claude" | "codex" | "copilot" | "pi", string[]>;

const EMPTY_PROFILES: ProfilesByProvider = { claude: [], codex: [], copilot: [], pi: [] };

export function StrategyTargetsView({ columns, projectId, onIssueClick, searchQuery }: StrategyTargetsViewProps) {
  const allIssues = useMemo(() => columns.flatMap((column) => column.issues), [columns]);
  const [profilesByProvider, setProfilesByProvider] = useState<ProfilesByProvider>(EMPTY_PROFILES);
  const [config, setConfig] = useState<StrategyConfig>(DEFAULT_CONFIG);
  const [savedConfig, setSavedConfig] = useState<StrategyConfig>(DEFAULT_CONFIG);
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
        setSavedConfig(next);
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

  // Load the available profile names per provider so provider policies can
  // select a real profile instead of typing one by hand (AK-836).
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      apiFetch<{ profiles: string[] }>("/api/preferences/claude-profiles").catch(() => ({ profiles: [] as string[] })),
      apiFetch<{ profiles: string[] }>("/api/preferences/codex-profiles").catch(() => ({ profiles: [] as string[] })),
      apiFetch<{ profiles: string[] }>("/api/preferences/copilot-profiles").catch(() => ({ profiles: [] as string[] })),
      apiFetch<{ profiles: string[] }>("/api/preferences/pi-profiles").catch(() => ({ profiles: [] as string[] })),
    ]).then(([claude, codex, copilot, pi]) => {
      if (cancelled) return;
      setProfilesByProvider({
        claude: claude.profiles ?? [],
        codex: codex.profiles ?? [],
        copilot: copilot.profiles ?? [],
        pi: pi.profiles ?? [],
      });
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

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
      await setSettings({ [key]: JSON.stringify(payload) });
      setConfig(payload);
      setSavedConfig(payload);
      setDirty(false);
      showToast("Strategy Bullseye saved", "success");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to save Strategy Bullseye", "error");
    } finally {
      setSaving(false);
    }
  }

  function discardChanges() {
    setConfig(savedConfig);
    setSelectedId((prev) => (savedConfig.segments.some((s) => s.id === prev) ? prev : savedConfig.segments[0]?.id ?? null));
    setDirty(false);
    showToast("Unsaved changes discarded", "success");
  }

  async function applyPreset(preset: MonitorPolicyPreset) {
    const next = normalizeConfig({
      ...config,
      activeAgentsTarget: preset.activeAgentsTarget,
      backlogFloor: preset.backlogFloor,
      maxNewStartsPerCycle: preset.maxNewStartsPerCycle,
      segments: config.segments.map((segment) => {
        if (segment.kind !== "work-type") return segment;
        const isBugfix = /bug|fix|defect|regression/i.test(`${segment.label} ${segment.keywords}`);
        if (preset.refillFocus === "bugfix-only") {
          return { ...segment, weight: isBugfix ? Math.max(segment.weight, 4) : Math.min(segment.weight, 2) };
        }
        return segment;
      }),
    });
    setSaving(true);
    try {
      await setSettings({ [key]: JSON.stringify(next) });
      setConfig(next);
      setSavedConfig(next);
      setDirty(false);
      showToast(`Preset "${preset.name}" applied`, "success");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to apply preset", "error");
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
        { id, provider: "claude", profileName: "", label: "Claude: Default", mode: "throttle", headroomPct: 20, notes: "", quotaProviderId: "" },
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
                      <option value="pi">Pi</option>
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
                              onChange={(event) => updateProviderPolicy(policy.id, { provider: event.target.value as "claude" | "codex" | "copilot" | "pi" })}
                              className="w-full rounded-md border border-gray-200 bg-white px-2 py-1 text-xs text-gray-800 outline-none focus:border-brand-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                            >
                              <option value="claude">Claude</option>
                              <option value="codex">Codex</option>
                              <option value="copilot">Copilot</option>
                              <option value="pi">Pi</option>
                            </select>
                          </label>
                          <ProviderPolicyProfileField
                            provider={policy.provider}
                            profileName={policy.profileName}
                            availableProfiles={profilesByProvider[policy.provider] ?? []}
                            onChange={(name) => updateProviderPolicy(policy.id, { profileName: name })}
                          />
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
                          <span className="mb-1 block text-[11px] font-medium text-gray-500 dark:text-gray-400">Quota provider ID (optional)</span>
                          <input
                            value={policy.quotaProviderId}
                            onChange={(event) => updateProviderPolicy(policy.id, { quotaProviderId: event.target.value })}
                            placeholder="e.g. claude-pro, codex-default"
                            className="w-full rounded-md border border-gray-200 bg-white px-2 py-1 text-xs text-gray-800 outline-none focus:border-brand-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                          />
                          <span className="mt-0.5 block text-[10px] text-gray-400 dark:text-gray-500">ID from the quota usage panel (tampermonkey). When set, live usage gates this policy.</span>
                        </label>
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

          <MonitorPolicyPresets projectId={projectId} config={config} onApply={applyPreset} />

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

      {dirty && (
        <div className="sticky bottom-0 z-20 -mx-4 mt-4 border-t border-amber-200 bg-amber-50/95 px-4 py-3 backdrop-blur dark:border-amber-900 dark:bg-amber-950/90">
          <div className="mx-auto flex max-w-7xl items-center justify-between gap-3">
            <span className="flex items-center gap-2 text-sm font-medium text-amber-800 dark:text-amber-200">
              <span className="h-2 w-2 shrink-0 rounded-full bg-amber-500" />
              Unsaved changes
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={discardChanges}
                disabled={saving}
                className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-semibold text-gray-600 transition-colors hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
              >
                Discard
              </button>
              <button
                type="button"
                onClick={saveBullseye}
                disabled={loading || saving}
                className="rounded-md bg-brand-600 px-4 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {saving ? "Saving..." : "Save changes"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

import { useCallback, useEffect, useState } from "react";
import { apiFetch, apiPost } from "../lib/api.js";
import { getSettings, setSettings } from "../lib/settingsStore.js";
import { getWipLimit, wipLimitKey } from "../lib/wipLimits.js";
import { startStaggeredPoll, type PollHandle } from "../lib/pollScheduler.js";
import { showToast } from "../lib/toast.js";
import type { MonitorStatus } from "../components/MonitorPopover.js";

export type CardDensity = "comfortable" | "compact";

export interface BoardPreferences {
  autoReview: boolean;
  setAutoReview: (v: boolean) => void;
  autoMerge: boolean;
  setAutoMerge: (v: boolean) => void;
  autoMonitor: boolean;
  autoMonitorInterval: string;
  nudgeAutoStart: boolean;
  nudgeWipLimit: string;
  monitorStatus: MonitorStatus | null;
  monitorRunning: boolean;
  wipLimits: Record<string, number | null>;
  dynamicColumnScaling: boolean;
  cardDensity: CardDensity;
  hiddenColumns: Set<string>;
  showPriorityLegend: boolean;
  showCardAgingHeatmap: boolean;
  agingWarmDays: number;
  agingHotDays: number;
  recentMergesCollapsed: boolean;
  handleRecentMergesCollapsedChange: (v: boolean) => Promise<void>;
  handleCardDensityChange: (v: CardDensity) => Promise<void>;
  handleHiddenColumnsChange: (statusName: string, hidden: boolean) => Promise<void>;
  handleShowPriorityLegendChange: (v: boolean) => Promise<void>;
  handleShowCardAgingHeatmapChange: (v: boolean) => Promise<void>;
  handleAgingThresholdsChange: (warm: number, hot: number) => Promise<void>;
  toggleAutoMonitor: () => Promise<void>;
  handleMonitorRunNow: () => Promise<void>;
  handleIntervalChange: (v: string) => Promise<void>;
  handleNudgeAutoStartChange: (v: boolean) => Promise<void>;
  handleNudgeWipLimitChange: (v: string) => Promise<void>;
  handleSetWipLimit: (statusId: string, limit: number | null) => Promise<void>;
}

export function useBoardPreferences(projectId: string | null): BoardPreferences & { prefsLoaded: boolean } {
  const [autoReview, setAutoReview] = useState(true);
  const [autoMerge, setAutoMerge] = useState(true);
  const [autoMonitor, setAutoMonitor] = useState(false);
  const [autoMonitorInterval, setAutoMonitorInterval] = useState("4");
  const [nudgeAutoStart, setNudgeAutoStart] = useState(false);
  const [nudgeWipLimit, setNudgeWipLimit] = useState("5");
  const [monitorStatus, setMonitorStatus] = useState<MonitorStatus | null>(null);
  const [monitorRunning, setMonitorRunning] = useState(false);
  const [wipLimits, setWipLimits] = useState<Record<string, number | null>>({});
  const [dynamicColumnScaling, setDynamicColumnScaling] = useState(false);
  const [cardDensity, setCardDensity] = useState<CardDensity>("comfortable");
  const [hiddenColumns, setHiddenColumns] = useState<Set<string>>(new Set());
  const [showPriorityLegend, setShowPriorityLegend] = useState(false);
  const [showCardAgingHeatmap, setShowCardAgingHeatmap] = useState(false);
  const [agingWarmDays, setAgingWarmDays] = useState(3);
  const [agingHotDays, setAgingHotDays] = useState(7);
  const [recentMergesCollapsed, setRecentMergesCollapsed] = useState(false);
  const [prefsLoaded, setPrefsLoaded] = useState(false);

  const loadPreferences = useCallback(async () => {
    try {
      // Shared, deduped settings read: the null-projectId and resolved-projectId
      // runs (plus StrictMode double-mounts) all resolve from one request/cache.
      const s = await getSettings();
      setDynamicColumnScaling(s.dynamic_column_scaling === "true");
      setCardDensity(s.card_density === "compact" ? "compact" : "comfortable");
      if (projectId) {
        const raw = s[`board_hidden_columns_${projectId}`];
        setHiddenColumns(raw ? new Set(raw.split(",").filter(Boolean)) : new Set());
        setShowPriorityLegend(s[`board_show_priority_legend_${projectId}`] === "true");
        setShowCardAgingHeatmap(s[`board_card_aging_heatmap_${projectId}`] === "true");
        const warm = parseInt(s[`board_aging_warm_days_${projectId}`] ?? "3", 10);
        const hot = parseInt(s[`board_aging_hot_days_${projectId}`] ?? "7", 10);
        setAgingWarmDays(isNaN(warm) ? 3 : warm);
        setAgingHotDays(isNaN(hot) ? 7 : hot);
        setRecentMergesCollapsed(s[`board_recent_merges_collapsed_${projectId}`] === "true");
      }
      setAutoReview(s.auto_review !== "false");
      setAutoMerge(s.auto_merge !== "false");
      setAutoMonitor(s.auto_monitor === "true");
      setAutoMonitorInterval(s.auto_monitor_interval ?? "4");
      setNudgeAutoStart(s.nudge_auto_start === "true");
      setNudgeWipLimit(s.nudge_wip_limit ?? "5");
      const loadedWipLimits: Record<string, number | null> = {};
      for (const key of Object.keys(s)) {
        if (key.startsWith("wip_limit_")) {
          const statusId = key.slice("wip_limit_".length);
          const limit = getWipLimit(s, statusId);
          if (limit !== null) loadedWipLimits[statusId] = limit;
        }
      }
      setWipLimits(loadedWipLimits);
    } catch {
      // ignore
    }
    setPrefsLoaded(true);
  }, [projectId]);

  useEffect(() => {
    void loadPreferences();
  }, [loadPreferences]);

  // Monitor-status is global (not project-scoped), so it lives in its own
  // []-dep effect instead of loadPreferences — previously it was re-fetched
  // on every projectId change and twice on load (null -> resolved id). The
  // initial ~60KB fetch is deferred past first paint so it doesn't compete
  // with the board fetch; the recurring poll is staggered + visibility-gated.
  useEffect(() => {
    let stopped = false;
    let poll: PollHandle | null = null;
    const fetchStatus = () => {
      apiFetch<MonitorStatus>("/api/internal/monitor-status")
        .then((r) => {
          if (!stopped) setMonitorStatus(r);
        })
        .catch(() => {});
    };
    const startPolling = () => {
      if (stopped) return;
      fetchStatus();
      poll = startStaggeredPoll(fetchStatus, 30_000);
    };
    let idleId: number | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    if (typeof requestIdleCallback === "function") {
      idleId = requestIdleCallback(() => startPolling(), { timeout: 3000 });
    } else {
      timeoutId = setTimeout(startPolling, 1500);
    }
    return () => {
      stopped = true;
      if (idleId !== null && typeof cancelIdleCallback === "function") cancelIdleCallback(idleId);
      if (timeoutId !== null) clearTimeout(timeoutId);
      poll?.stop();
    };
  }, []);

  const toggleAutoMonitor = useCallback(async () => {
    const next = !autoMonitor;
    setAutoMonitor(next);
    try {
      await setSettings({ auto_monitor: String(next) });
      const status = await apiFetch<MonitorStatus>("/api/internal/monitor-status");
      setMonitorStatus(status);
    } catch {
      setAutoMonitor(!next);
    }
  }, [autoMonitor]);

  const handleMonitorRunNow = useCallback(async () => {
    setMonitorRunning(true);
    try {
      await apiPost("/api/internal/monitor-run");
      const s = await apiFetch<MonitorStatus>("/api/internal/monitor-status");
      setMonitorStatus(s);
    } finally {
      setMonitorRunning(false);
    }
  }, []);

  const handleIntervalChange = useCallback(async (v: string) => {
    setAutoMonitorInterval(v);
    await setSettings({ auto_monitor_interval: v }).catch(() => {});
  }, []);

  const handleNudgeAutoStartChange = useCallback(async (v: boolean) => {
    setNudgeAutoStart(v);
    await setSettings({ nudge_auto_start: String(v) }).catch(() => {});
  }, []);

  const handleNudgeWipLimitChange = useCallback(async (v: string) => {
    setNudgeWipLimit(v);
    await setSettings({ nudge_wip_limit: v }).catch(() => {});
  }, []);

  const handleCardDensityChange = useCallback(async (v: CardDensity) => {
    setCardDensity(v);
    await setSettings({ card_density: v }).catch(() => {});
  }, []);

  const handleShowPriorityLegendChange = useCallback(async (v: boolean) => {
    if (!projectId) return;
    setShowPriorityLegend(v);
    await setSettings({ [`board_show_priority_legend_${projectId}`]: String(v) }).catch(() => {});
  }, [projectId]);

  const handleShowCardAgingHeatmapChange = useCallback(async (v: boolean) => {
    if (!projectId) return;
    const prev = showCardAgingHeatmap;
    setShowCardAgingHeatmap(v);
    // Surface the write failure instead of swallowing it (#904): an
    // un-whitelisted key 422s and the preference would silently never persist.
    // Revert the optimistic state so the UI reflects what actually stuck.
    try {
      await setSettings({ [`board_card_aging_heatmap_${projectId}`]: String(v) });
    } catch (err) {
      setShowCardAgingHeatmap(prev);
      showToast(`Failed to save card-aging heatmap setting: ${(err as Error).message}`);
    }
  }, [projectId, showCardAgingHeatmap]);

  const handleAgingThresholdsChange = useCallback(async (warm: number, hot: number) => {
    if (!projectId) return;
    const prevWarm = agingWarmDays;
    const prevHot = agingHotDays;
    setAgingWarmDays(warm);
    setAgingHotDays(hot);
    try {
      await setSettings({
        [`board_aging_warm_days_${projectId}`]: String(warm),
        [`board_aging_hot_days_${projectId}`]: String(hot),
      });
    } catch (err) {
      setAgingWarmDays(prevWarm);
      setAgingHotDays(prevHot);
      showToast(`Failed to save card-aging thresholds: ${(err as Error).message}`);
    }
  }, [projectId, agingWarmDays, agingHotDays]);

  const handleRecentMergesCollapsedChange = useCallback(async (v: boolean) => {
    if (!projectId) return;
    setRecentMergesCollapsed(v);
    await setSettings({ [`board_recent_merges_collapsed_${projectId}`]: String(v) }).catch(() => {});
  }, [projectId]);

  const handleHiddenColumnsChange = useCallback(async (statusName: string, hidden: boolean) => {
    if (!projectId) return;
    const next = new Set(hiddenColumns);
    if (hidden) {
      next.add(statusName);
    } else {
      next.delete(statusName);
    }
    setHiddenColumns(next);
    await setSettings({ [`board_hidden_columns_${projectId}`]: [...next].join(",") }).catch(() => {});
  }, [projectId, hiddenColumns]);

  const handleSetWipLimit = useCallback(async (statusId: string, limit: number | null) => {
    setWipLimits((prev) => {
      const next = { ...prev };
      if (limit === null) {
        delete next[statusId];
      } else {
        next[statusId] = limit;
      }
      return next;
    });
    await setSettings({ [wipLimitKey(statusId)]: limit != null ? String(limit) : "" }).catch(() => {});
  }, []);

  return {
    autoReview,
    setAutoReview,
    autoMerge,
    setAutoMerge,
    autoMonitor,
    autoMonitorInterval,
    nudgeAutoStart,
    nudgeWipLimit,
    monitorStatus,
    monitorRunning,
    wipLimits,
    dynamicColumnScaling,
    cardDensity,
    hiddenColumns,
    showPriorityLegend,
    showCardAgingHeatmap,
    agingWarmDays,
    agingHotDays,
    recentMergesCollapsed,
    handleRecentMergesCollapsedChange,
    handleCardDensityChange,
    handleHiddenColumnsChange,
    handleShowPriorityLegendChange,
    handleShowCardAgingHeatmapChange,
    handleAgingThresholdsChange,
    prefsLoaded,
    toggleAutoMonitor,
    handleMonitorRunNow,
    handleIntervalChange,
    handleNudgeAutoStartChange,
    handleNudgeWipLimitChange,
    handleSetWipLimit,
  };
}

export type { MonitorStatus };

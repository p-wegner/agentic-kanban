import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../lib/api.js";
import { getWipLimit, wipLimitKey } from "../lib/wipLimits.js";
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
  handleCardDensityChange: (v: CardDensity) => Promise<void>;
  toggleAutoMonitor: () => Promise<void>;
  handleMonitorRunNow: () => Promise<void>;
  handleIntervalChange: (v: string) => Promise<void>;
  handleNudgeAutoStartChange: (v: boolean) => Promise<void>;
  handleNudgeWipLimitChange: (v: string) => Promise<void>;
  handleSetWipLimit: (statusId: string, limit: number | null) => Promise<void>;
}

export function useBoardPreferences(): BoardPreferences & { prefsLoaded: boolean } {
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
  const [prefsLoaded, setPrefsLoaded] = useState(false);

  const loadPreferences = useCallback(async () => {
    try {
      const s = await apiFetch<Record<string, string>>("/api/preferences/settings");
      setDynamicColumnScaling(s.dynamic_column_scaling === "true");
      setCardDensity(s.card_density === "compact" ? "compact" : "comfortable");
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
      apiFetch<MonitorStatus>("/api/internal/monitor-status")
        .then((r) => setMonitorStatus(r))
        .catch(() => {});
    } catch {
      // ignore
    }
    setPrefsLoaded(true);
  }, []);

  useEffect(() => {
    loadPreferences();
  }, [loadPreferences]);

  useEffect(() => {
    const t = setInterval(() => {
      apiFetch<MonitorStatus>("/api/internal/monitor-status")
        .then((r) => setMonitorStatus(r))
        .catch(() => {});
    }, 30_000);
    return () => clearInterval(t);
  }, []);

  const toggleAutoMonitor = useCallback(async () => {
    const next = !autoMonitor;
    setAutoMonitor(next);
    try {
      await apiFetch("/api/preferences/settings", {
        method: "PUT",
        body: JSON.stringify({ auto_monitor: String(next) }),
      });
      const status = await apiFetch<MonitorStatus>("/api/internal/monitor-status");
      setMonitorStatus(status);
    } catch {
      setAutoMonitor(!next);
    }
  }, [autoMonitor]);

  const handleMonitorRunNow = useCallback(async () => {
    setMonitorRunning(true);
    try {
      await apiFetch("/api/internal/monitor-run", { method: "POST" });
      const s = await apiFetch<MonitorStatus>("/api/internal/monitor-status");
      setMonitorStatus(s);
    } finally {
      setMonitorRunning(false);
    }
  }, []);

  const handleIntervalChange = useCallback(async (v: string) => {
    setAutoMonitorInterval(v);
    await apiFetch("/api/preferences/settings", { method: "PUT", body: JSON.stringify({ auto_monitor_interval: v }) }).catch(() => {});
  }, []);

  const handleNudgeAutoStartChange = useCallback(async (v: boolean) => {
    setNudgeAutoStart(v);
    await apiFetch("/api/preferences/settings", { method: "PUT", body: JSON.stringify({ nudge_auto_start: String(v) }) }).catch(() => {});
  }, []);

  const handleNudgeWipLimitChange = useCallback(async (v: string) => {
    setNudgeWipLimit(v);
    await apiFetch("/api/preferences/settings", { method: "PUT", body: JSON.stringify({ nudge_wip_limit: v }) }).catch(() => {});
  }, []);

  const handleCardDensityChange = useCallback(async (v: CardDensity) => {
    setCardDensity(v);
    await apiFetch("/api/preferences/settings", { method: "PUT", body: JSON.stringify({ card_density: v }) }).catch(() => {});
  }, []);

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
    await apiFetch("/api/preferences/settings", {
      method: "PUT",
      body: JSON.stringify({ [wipLimitKey(statusId)]: limit != null ? String(limit) : "" }),
    }).catch(() => {});
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
    handleCardDensityChange,
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

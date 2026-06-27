import { useState } from "react";
import { apiFetch, apiPost } from "../lib/api.js";
import { setSettings as savePreferences } from "../lib/settingsStore.js";
import { showToast } from "../components/Toast.js";
import { buildMigrationConfig } from "../lib/strategy-targets.js";
import type { MonitorTunables } from "../components/SettingsPanel.shared.js";
import type { MonitorAction } from "../components/MonitorPopover.js";

export type MonitorStatus = {
  enabled: boolean;
  intervalMin: number;
  active: boolean;
  lastRun: string | null;
  nextRunAt: string | null;
  recentActions: MonitorAction[];
  maintenanceActive?: boolean;
  maintenanceEnd?: string | null;
};

export interface MonitorControls {
  monitorRunning: boolean;
  monitorStatus: MonitorStatus | null;
  monitorTunables: { tunables: MonitorTunables; source: "strategy" | "prefs" } | null;
  migratingToStrategy: boolean;
  fetchMonitorStatus: () => Promise<void>;
  fetchMonitorTunables: () => Promise<void>;
  handleMigrateToStrategy: () => Promise<void>;
  handleMonitorRunNow: () => Promise<void>;
}

/** Owns the Settings → Workflow tab's scheduled-monitor controls: live status,
 *  resolved tunables, the "run now" trigger and the migrate-to-Strategy-Bullseye
 *  action. Extracted verbatim from SettingsPanel — the only external inputs are
 *  the active project id and the current WIP-limit pref (for the migration
 *  config seed). */
export function useMonitorControls(
  activeProjectId: string | null | undefined,
  wipLimit: string | undefined,
): MonitorControls {
  const [monitorRunning, setMonitorRunning] = useState(false);
  const [monitorStatus, setMonitorStatus] = useState<MonitorStatus | null>(null);
  const [monitorTunables, setMonitorTunables] = useState<{ tunables: MonitorTunables; source: "strategy" | "prefs" } | null>(null);
  const [migratingToStrategy, setMigratingToStrategy] = useState(false);

  async function fetchMonitorStatus() {
    try {
      const s = await apiFetch<MonitorStatus>("/api/internal/monitor-status");
      setMonitorStatus(s);
    } catch { /* non-fatal */ }
  }

  async function fetchMonitorTunables() {
    if (!activeProjectId) return;
    try {
      const result = await apiFetch<{ tunables: MonitorTunables; source: "strategy" | "prefs" }>(
        `/api/projects/${activeProjectId}/monitor-tunables`,
      );
      setMonitorTunables(result);
    } catch { /* non-fatal */ }
  }

  async function handleMigrateToStrategy() {
    if (!activeProjectId || migratingToStrategy) return;
    setMigratingToStrategy(true);
    try {
      const strategyConfig = buildMigrationConfig(wipLimit);
      await savePreferences({ [`board_strategy_${activeProjectId}`]: JSON.stringify(strategyConfig) });
      showToast("Migrated to Strategy Bullseye", "success");
      await fetchMonitorTunables();
    } catch {
      showToast("Migration failed", "error");
    } finally {
      setMigratingToStrategy(false);
    }
  }

  async function handleMonitorRunNow() {
    setMonitorRunning(true);
    try {
      await apiPost("/api/internal/monitor-run");
      showToast("Monitor cycle triggered", "success");
      setTimeout(fetchMonitorStatus, 1500);
    } catch {
      showToast("Failed to trigger monitor", "error");
    } finally {
      setMonitorRunning(false);
    }
  }

  return {
    monitorRunning,
    monitorStatus,
    monitorTunables,
    migratingToStrategy,
    fetchMonitorStatus,
    fetchMonitorTunables,
    handleMigrateToStrategy,
    handleMonitorRunNow,
  };
}

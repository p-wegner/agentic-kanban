import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { StatusWithIssues } from "@agentic-kanban/shared";
import { apiFetch, apiPost } from "../lib/api.js";
import { setSettings, setProjectPref } from "../lib/settingsStore.js";
import type { OrchestratorStatus } from "../hooks/useOrchestrator.js";
import { MonitorActionReplayDrawer, type ReplayTarget } from "./MonitorActionReplayDrawer.js";
export * from "../lib/monitor-popover.js";
import {
  MonitorButlerSection, OrchestratorSection, RecentBoardHealthEventsSection,
  MonitorHeader, AutoMonitorToggleRow, StartModeSection, ActiveAgentsSection,
  LastRunSection, MonitorWarningsSection, ResourceAuditSection, RecentActionsSection,
  EffectiveTargetsSection, MonitorSettingsSection,
} from "./MonitorSections.js";
export { MonitorButlerSection, OrchestratorSection, RecentBoardHealthEventsSection } from "./MonitorSections.js";
import type { StartMode, ResolvedTunables, MonitorStatus, BoardHealthEvent } from "../lib/monitor-popover.js";

interface MonitorPopoverProps {
  status: MonitorStatus | null;
  onClose: () => void;
  onOpenWorkspace: (workspaceId: string, issueId: string) => void;
  columns: StatusWithIssues[];
  onRunNow: () => Promise<void>;
  autoMonitor: boolean;
  onToggle: () => void;
  interval: string;
  onIntervalChange: (v: string) => void;
  nudgeAutoStart: boolean;
  onNudgeAutoStartChange: (v: boolean) => void;
  nudgeWipLimit: string;
  onNudgeWipLimitChange: (v: string) => void;
  projectId: string | null;
  orchestrator?: OrchestratorStatus | null;
  orchestratorNotify?: boolean;
  onOrchestratorNotifyChange?: (v: boolean) => void;
  monitorButlerEnabled?: boolean;
  monitorButlerInterval?: number;
  onViewAllHealthEvents?: () => void;
}

export function MonitorPopover({
  status,
  onClose,
  onOpenWorkspace,
  columns,
  onRunNow,
  autoMonitor,
  onToggle,
  interval,
  onIntervalChange,
  nudgeAutoStart,
  onNudgeAutoStartChange,
  nudgeWipLimit,
  onNudgeWipLimitChange,
  projectId,
  orchestrator,
  orchestratorNotify = false,
  onOrchestratorNotifyChange,
  monitorButlerEnabled = false,
  monitorButlerInterval = 15,
  onViewAllHealthEvents,
}: MonitorPopoverProps) {
  const [now, setNow] = useState(Date.now());
  const [running, setRunning] = useState(false);
  const [healthEvents, setHealthEvents] = useState<BoardHealthEvent[]>([]);
  const [healthEventsLoading, setHealthEventsLoading] = useState(false);
  const [healthEventsError, setHealthEventsError] = useState<string | null>(null);
  const [replayTarget, setReplayTarget] = useState<ReplayTarget | null>(null);
  const [resolvedTunables, setResolvedTunables] = useState<ResolvedTunables | null>(null);
  const [tunablesError, setTunablesError] = useState<string | null>(null);
  const [startModeSaving, setStartModeSaving] = useState(false);

  async function loadHealthEvents() {
    if (!projectId) {
      setHealthEvents([]);
      setHealthEventsLoading(false);
      setHealthEventsError(null);
      return;
    }
    setHealthEventsLoading(true);
    setHealthEventsError(null);
    try {
      const events = await apiFetch<BoardHealthEvent[]>(`/api/projects/${projectId}/board-health-events?limit=15`);
      setHealthEvents(events);
    } catch (err) {
      setHealthEventsError(err instanceof Error ? err.message : "Failed to load events");
    } finally {
      setHealthEventsLoading(false);
    }
  }

  async function handleRunNow() {
    setRunning(true);
    try {
      await onRunNow();
      await loadHealthEvents();
    } finally {
      setRunning(false);
    }
  }

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    void loadHealthEvents();
  }, [projectId]);

  useEffect(() => {
    if (!projectId) { setResolvedTunables(null); return; }
    loadTunables();
  }, [projectId]);

  function loadTunables() {
    if (!projectId) { setResolvedTunables(null); setTunablesError(null); return; }
    apiFetch<ResolvedTunables>(`/api/projects/${projectId}/monitor-tunables`)
      .then((data) => { setResolvedTunables(data); setTunablesError(null); })
      .catch((err) => { setResolvedTunables(null); setTunablesError(err instanceof Error ? err.message : "Failed to load start policy"); });
  }

  // Start Mode + its sub-toggles write straight to preferences, then refetch the resolved
  // policy so the read-out reflects the new live decision.
  async function putSettings(patch: Record<string, string>) {
    setStartModeSaving(true);
    try {
      await setSettings(patch);
      loadTunables();
    } catch { /* surfaced by the unchanged read-out */ }
    finally { setStartModeSaving(false); }
  }

  // Selecting a Start Mode also drives the out-of-process Conductor loop: picking
  // "conductor" starts it; switching to manual/monitor stops it. (Only the dogfood board
  // has a loop — orchestrator.available — elsewhere this is a no-op write.)
  async function selectStartMode(m: StartMode) {
    if (!projectId) return;
    setStartModeSaving(true);
    try {
      await setProjectPref(projectId, "start_mode", m);
      if (orchestrator?.available) {
        await apiPost(`/api/projects/${projectId}/conductor`, { action: m === "conductor" ? "start" : "stop" }).catch(() => {});
      }
      loadTunables();
    } catch { /* surfaced by the read-out */ }
    finally { setStartModeSaving(false); }
  }

  useEffect(() => {
    function handler(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  function formatCountdown(isoStr: string) {
    const ms = new Date(isoStr).getTime() - now;
    if (ms <= 0) return "now";
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return m > 0 ? `${m}m ${rem}s` : `${rem}s`;
  }

  function formatAge(isoStr: string) {
    const s = Math.floor((now - new Date(isoStr).getTime()) / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    return `${Math.floor(m / 60)}h ago`;
  }

  const activeWs = columns.flatMap(c => c.issues).filter(iss =>
    iss.workspaceSummary?.main &&
    (iss.workspaceSummary.main.status === "active" || iss.workspaceSummary.main.status === "reviewing" || iss.workspaceSummary.main.status === "fixing") &&
    iss.workspaceSummary.main.lastAssistantMessage
  );
  const warnings = status?.warnings ?? [];

  return createPortal(
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        id="monitor-popover"
        className="fixed z-50 left-0 top-0 bottom-0 w-72 bg-surface-raised dark:bg-surface-raised-dark border-r border-gray-200 dark:border-gray-700 shadow-xl text-xs flex flex-col"
      >
        <MonitorHeader
          autoMonitor={autoMonitor}
          butlerEnabled={monitorButlerEnabled}
          nextRunAt={status?.nextRunAt}
          running={running}
          onRunNow={handleRunNow}
          onClose={onClose}
          formatCountdown={formatCountdown}
        />

        {/* Scrollable body */}
        <div className="overflow-y-auto flex-1 min-h-0">

          {/* Orchestrator loop (dogfooding board only — hidden when no loop on disk) */}
          {orchestrator?.available && (
            <OrchestratorSection
              orchestrator={orchestrator}
              notify={orchestratorNotify}
              onNotifyChange={onOrchestratorNotifyChange}
              formatAge={formatAge}
            />
          )}

          <MonitorButlerSection
            enabled={monitorButlerEnabled}
            intervalMin={monitorButlerInterval}
          />

          <AutoMonitorToggleRow autoMonitor={autoMonitor} active={status?.active} onToggle={onToggle} />

          {/* Start Mode — the single per-project decision for how new tickets get started */}
          {projectId && (
            <StartModeSection
              projectId={projectId}
              resolvedTunables={resolvedTunables}
              tunablesError={tunablesError}
              orchestrator={orchestrator}
              startModeSaving={startModeSaving}
              onSelectStartMode={selectStartMode}
              onRetryTunables={loadTunables}
              onPutSettings={putSettings}
              formatAge={formatAge}
              formatCountdown={formatCountdown}
            />
          )}

          <ActiveAgentsSection
            activeWs={activeWs}
            onOpenAgent={(iss) => { onOpenWorkspace(iss.workspaceSummary!.main!.id, iss.id); onClose(); }}
          />

          <LastRunSection lastRun={status?.lastRun ?? null} formatAge={formatAge} />

          {warnings.length > 0 && (
            <MonitorWarningsSection
              warnings={warnings}
              lastHealthCheckAt={status?.lastHealthCheckAt}
              formatAge={formatAge}
            />
          )}

          {status && <ResourceAuditSection status={status} />}

          {status?.recentActions && (
            <RecentActionsSection
              recentActions={status.recentActions}
              columns={columns}
              formatAge={formatAge}
              onSelectAction={(action, issueNumber) => setReplayTarget({ kind: "action", action, issueNumber })}
            />
          )}

          <RecentBoardHealthEventsSection
            events={healthEvents}
            loading={healthEventsLoading}
            error={healthEventsError}
            formatAge={formatAge}
            onViewAll={onViewAllHealthEvents}
            projectId={projectId}
            onOpenReplay={(event) => setReplayTarget({ kind: "event", event, projectId: projectId! })}
          />

          {resolvedTunables && <EffectiveTargetsSection resolvedTunables={resolvedTunables} />}

          <MonitorSettingsSection
            interval={interval}
            onIntervalChange={onIntervalChange}
            autoMonitor={autoMonitor}
            nudgeAutoStart={nudgeAutoStart}
            onNudgeAutoStartChange={onNudgeAutoStartChange}
            nudgeWipLimit={nudgeWipLimit}
            onNudgeWipLimitChange={onNudgeWipLimitChange}
            resolvedTunables={resolvedTunables}
          />
        </div>
      </div>
    {replayTarget && (
      <MonitorActionReplayDrawer
        target={replayTarget}
        onClose={() => setReplayTarget(null)}
        onOpenWorkspace={onOpenWorkspace}
      />
    )}
    </>,
    document.body
  );
}

import { useState, type ReactNode } from "react";
import { apiPost } from "../lib/api.js";
import { showToast } from "./Toast.js";

export interface SettingsPanelProps {
  onClose: () => void;
  activeProjectId?: string | null;
  /**
   * Board-level tools (filters + export/import) lifted off the main toolbar and
   * surfaced here. Built and wired by BoardPage (which owns the live filter
   * state), passed through as a ready-to-render node so SettingsPanel doesn't
   * have to thread ~16 filter props.
   */
  boardToolsSlot?: ReactNode;
}

export * from "../lib/settings-shared.js";
export * from "./SettingsPrimitives.js";
export * from "./WorkflowSections.js";
import { Field, Toggle } from "./SettingsPrimitives.js";
import { CAPABILITY_DEFS, getProviderCapabilities } from "../lib/settings-shared.js";
import type { Settings, MonitorTunables, AgentProvider } from "../lib/settings-shared.js";

const ARCHIVE_THRESHOLDS = [
  { label: "14 days", value: 14 },
  { label: "30 days", value: 30 },
  { label: "60 days", value: 60 },
  { label: "90 days", value: 90 },
];

export function ArchiveDoneSection({ projectId }: { projectId: string | null | undefined }) {
  const [threshold, setThreshold] = useState(30);
  const [running, setRunning] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [lastResult, setLastResult] = useState<{ archived: number } | null>(null);

  if (!projectId) return null;

  async function doArchive() {
    setRunning(true);
    setConfirming(false);
    setLastResult(null);
    try {
      const result = await apiPost<{ archived: number }>("/api/issues/archive-done", { projectId, olderThanDays: threshold });
      setLastResult(result);
      if (result.archived > 0) {
        showToast(`Archived ${result.archived} Done issue${result.archived === 1 ? "" : "s"}`, "success");
      } else {
        showToast("No Done issues older than threshold", "success");
      }
    } catch {
      showToast("Archive failed", "error");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-2">
      <div>
        <p className="text-sm font-medium text-gray-700 dark:text-gray-300">Archive Done Issues</p>
        <p className="text-xs text-gray-500 mt-0.5">
          Move Done issues older than a threshold to Archived (hidden from the board by default). Status-change only — no rows are deleted.
        </p>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <select
          value={threshold}
          onChange={(e) => { setThreshold(Number(e.target.value)); setConfirming(false); setLastResult(null); }}
          className="text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:bg-gray-800 dark:text-gray-200"
        >
          {ARCHIVE_THRESHOLDS.map((t) => (
            <option key={t.value} value={t.value}>{t.label}</option>
          ))}
        </select>
        {confirming ? (
          <>
            <button
              onClick={doArchive}
              disabled={running}
              className="text-sm px-3 py-1.5 rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Confirm archive
            </button>
            <button
              onClick={() => setConfirming(false)}
              className="text-sm px-3 py-1.5 rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            onClick={() => setConfirming(true)}
            disabled={running}
            className="text-sm px-3 py-1.5 rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Archive old Done issues
          </button>
        )}
      </div>
      {lastResult && (
        <p className="text-xs text-gray-500">
          {lastResult.archived > 0
            ? `${lastResult.archived} issue${lastResult.archived === 1 ? "" : "s"} archived.`
            : "No Done issues matched the threshold."}
        </p>
      )}
    </div>
  );
}
export function CapabilityMatrixTable({ provider, profileName, flags }: {
  provider: AgentProvider;
  profileName: string;
  flags: string[];
}) {
  const caps = getProviderCapabilities(provider, profileName, flags);
  return (
    <div className="mt-1 border border-gray-100 dark:border-gray-800 rounded overflow-hidden" data-testid="capability-matrix">
      <div className="grid grid-cols-5 divide-x divide-gray-100 dark:divide-gray-800 bg-gray-50 dark:bg-gray-900">
        {CAPABILITY_DEFS.map((def) => (
          <div key={def.key} title={def.tooltip} className="px-1.5 py-1 text-center">
            <div className="text-[10px] text-gray-500 dark:text-gray-400 leading-tight mb-0.5">{def.label}</div>
            {caps[def.key] ? (
              <span className="text-[11px] text-green-600 dark:text-green-400">&#10003;</span>
            ) : (
              <span className="text-[11px] text-gray-400 dark:text-gray-600">&#8211;</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export function EditSkillForm({ skill, isNew, onSave, onCancel }: {
  skill: { id?: string; name: string; description: string; prompt: string; model: string | null; projectId?: string | null };
  isNew?: boolean;
  onSave: (data: { name: string; description: string; prompt: string; model: string; projectId?: string | null }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(skill.name);
  const [description, setDescription] = useState(skill.description);
  const [prompt, setPrompt] = useState(skill.prompt);
  const [model, setModel] = useState(skill.model || "");
  const [enhancing, setEnhancing] = useState(false);
  const [preEnhanceSnapshot, setPreEnhanceSnapshot] = useState<{ name: string; description: string; prompt: string } | null>(null);

  async function handleEnhance() {
    if (!name.trim() || enhancing) return;
    setEnhancing(true);
    try {
      setPreEnhanceSnapshot({ name, description, prompt });
      const result = await apiPost<{ name: string; description: string; prompt: string }>("/api/agent-skills/enhance", { name, description, prompt });
      setName(result.name);
      setDescription(result.description);
      setPrompt(result.prompt);
    } catch (err) {
      setPreEnhanceSnapshot(null);
      showToast(err instanceof Error ? err.message : "Enhancement failed", "error");
    } finally {
      setEnhancing(false);
    }
  }

  function handleUndoEnhance() {
    if (!preEnhanceSnapshot) return;
    setName(preEnhanceSnapshot.name);
    setDescription(preEnhanceSnapshot.description);
    setPrompt(preEnhanceSnapshot.prompt);
    setPreEnhanceSnapshot(null);
  }

  return (
    <div className="space-y-2">
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Skill name (e.g. dependency-analyzer)"
        className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500"
        disabled={!isNew}
      />
      <input
        type="text"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Short description"
        className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500"
      />
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="Skill prompt — injected into the agent's context before the issue description"
        rows={6}
        className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500 font-mono"
      />
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="Model override (optional, e.g. haiku)"
          className="flex-1 text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500"
        />
      </div>
      <div className="flex gap-2 flex-wrap">
        <button
          onClick={() => onSave({ name, description, prompt, model })}
          disabled={!name || !prompt}
          className="text-xs px-3 py-1.5 bg-brand-600 text-white rounded hover:bg-brand-700 disabled:opacity-50"
        >
          {isNew ? "Create" : "Save"}
        </button>
        <button onClick={onCancel} className="text-xs px-3 py-1.5 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded">
          Cancel
        </button>
        <button
          onClick={handleEnhance}
          disabled={!name.trim() || enhancing}
          className="text-xs px-3 py-1.5 text-brand-700 border border-brand-300 rounded hover:bg-brand-50 disabled:opacity-50 flex items-center gap-1"
        >
          {enhancing ? (
            <>
              <span className="inline-block w-3 h-3 border-2 border-brand-400 border-t-transparent rounded-full animate-spin" />
              Enhancing…
            </>
          ) : (
            "Enhance with AI"
          )}
        </button>
        {preEnhanceSnapshot && (
          <button
            onClick={handleUndoEnhance}
            className="text-xs px-3 py-1.5 text-gray-600 dark:text-gray-400 border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-50 dark:hover:bg-gray-800"
          >
            Undo enhance
          </button>
        )}
      </div>
    </div>
  );
}

export function formatScheduledRunTime(value: string | null | undefined): string {
  if (!value) return "None";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("en-US");
}

export function formatNextFire(value: string | null | undefined): string {
  if (!value) return "pending";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const diffMin = Math.round((date.getTime() - Date.now()) / 60000);
  if (diffMin <= 0) return "overdue";
  if (diffMin < 60) return `in ${diffMin}m`;
  return `at ${date.toLocaleTimeString("en-US")}`;
}


export type SettingsTextSetter = (key: keyof Settings) => (value: string) => void;
export type SettingsBoolSetter = (key: keyof Settings) => (checked: boolean) => void;
export type SkillSetting = { id: string; name: string; description: string; prompt: string; model: string | null; projectId: string | null; isBuiltin: boolean };
export type TagSetting = { id: string; name: string; color: string | null; isBuiltin: boolean };
export type ProjectSettingsState = { defaultBranch: string; setupScript: string; setupBlocking: boolean; setupEnabled: boolean; teardownScript: string; verifyScript: string; color: string | null; symlinkEnabled: boolean; symlinkDirs: string; defaultSkillId: string | null };

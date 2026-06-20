import { useState, type ReactNode } from "react";

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">{label}</label>
      {children}
      {hint && <p className="text-xs text-gray-500 dark:text-gray-400">{hint}</p>}
    </div>
  );
}

export function Toggle({ checked, onChange, label, hint, disabled }: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <div className={`space-y-0.5 ${disabled ? "opacity-50" : ""}`}>
      <label className="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-300 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          disabled={disabled}
          className="rounded border-gray-300 dark:border-gray-600"
        />
        {label}
      </label>
      {hint && <p className="text-xs text-gray-500 dark:text-gray-400 pl-5">{hint}</p>}
    </div>
  );
}

export function CollapsibleSection({ title, configured, defaultOpen, children }: {
  title: string;
  configured?: boolean;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-md">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 rounded-md"
      >
        <span className="flex items-center gap-2">
          {title}
          {configured && !open && (
            <span className="text-[10px] px-1.5 py-0.5 bg-brand-50 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300 rounded">configured</span>
          )}
        </span>
        <svg
          className={`w-4 h-4 text-gray-400 dark:text-gray-500 transition-transform ${open ? "rotate-90" : ""}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </button>
      {open && (
        <div className="px-3 pb-3 pt-2 space-y-2 border-t border-gray-100 dark:border-gray-800">
          {children}
        </div>
      )}
    </div>
  );
}

export function ToolToggle({ name, description, disabled, onToggle }: {
  name: string;
  description: string;
  disabled: boolean;
  onToggle: (disabled: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-2">
      <label className="flex items-center gap-2 cursor-pointer select-none pt-0.5">
        <input
          type="checkbox"
          checked={!disabled}
          onChange={(e) => onToggle(!e.target.checked)}
          className="rounded border-gray-300 dark:border-gray-600"
        />
        <span className="text-sm font-mono text-gray-800 dark:text-gray-200">{name}</span>
      </label>
      <p className="text-xs text-gray-500 dark:text-gray-400 flex-1">{description}</p>
    </div>
  );
}

export type ScheduledRun = {
  id: string; name: string; description: string | null; projectId: string;
  prompt: string | null; skillId: string | null; intervalMinutes: number;
  cronExpression: string | null;
  enabled: boolean; lastRunAt: string | null; lastRunStatus: string | null;
  lastRunWorkspaceId: string | null;
  systemIssueId?: string | null;
  nextFireAt?: string | null;
  systemIssue?: { id: string; issueNumber: number; title: string } | null;
  lastRunWorkspace?: { id: string; branch: string; status: string } | null;
  latestHistory?: ScheduledRunHistory | null;
  history?: ScheduledRunHistory[];
};

export type ScheduledRunHistory = {
  id: string;
  status: string;
  reason: string | null;
  triggeredBy: string;
  issueId: string | null;
  workspaceId: string | null;
  startedAt: string;
  completedAt: string | null;
};

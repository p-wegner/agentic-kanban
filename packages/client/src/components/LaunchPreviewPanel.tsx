import { useEffect, useState, useRef } from "react";
import { apiFetch } from "../lib/api.js";

export type BudgetRisk = "low" | "medium" | "high";

export interface BudgetEstimate {
  risk: BudgetRisk;
  estimatedTokens: number | null;
  avgTokensFromHistory: number | null;
  sessionCount: number;
  descriptionTokens: number;
  reason: string;
}

export interface LaunchPreviewData {
  branch: string | null;
  baseBranch: string | null;
  isDirect: boolean;
  planMode: boolean;
  tddMode: boolean;
  requiresReview: boolean;
  setupScript: { enabled: boolean; command: string | null; blocking: boolean; willRun: boolean } | null;
  skill: { id: string; name: string } | null;
  provider: string;
  profile: string | null;
  model: string | null;
  warnings: string[];
  budgetEstimate?: BudgetEstimate;
}

interface LaunchPreviewPanelProps {
  issueId: string;
  branch: string;
  baseBranch: string;
  isDirect: boolean;
  requiresReview: boolean;
  planMode: boolean | undefined;
  tddMode: boolean;
  skipSetup: boolean;
  skillId: string;
  selectedProfile: string;
  selectedModel: string;
  /** Whether the form is in a valid state to launch */
  disabled: boolean;
}

function providerLabel(provider: string): string {
  switch (provider) {
    case "claude": return "Claude Code";
    case "codex": return "Codex";
    case "copilot": return "Copilot";
    default: return provider;
  }
}

function modelLabel(model: string | null): string {
  if (!model) return "Default";
  return model.charAt(0).toUpperCase() + model.slice(1);
}

const RISK_CONFIG: Record<BudgetRisk, { label: string; color: string; dot: string }> = {
  low: {
    label: "Low",
    color: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
    dot: "bg-green-500",
  },
  medium: {
    label: "Medium",
    color: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
    dot: "bg-amber-500",
  },
  high: {
    label: "High",
    color: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
    dot: "bg-red-500",
  },
};

function BudgetRiskBadge({ estimate }: { estimate: BudgetEstimate }) {
  const cfg = RISK_CONFIG[estimate.risk];
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex justify-between items-center gap-2 text-xs">
        <span className="text-gray-500 dark:text-gray-400 shrink-0">Budget risk</span>
        <span
          className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${cfg.color}`}
          title={estimate.reason}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${cfg.dot}`} />
          {cfg.label}
          {estimate.estimatedTokens !== null && (
            <span className="opacity-70">
              {" "}~{formatTokenCount(estimate.estimatedTokens)}
            </span>
          )}
        </span>
      </div>
      <p className="text-[10px] text-gray-400 dark:text-gray-500 text-right leading-tight">
        {estimate.reason}
      </p>
    </div>
  );
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M tok`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k tok`;
  return `${n} tok`;
}

function PreviewRow({ label, value, muted }: { label: string; value: React.ReactNode; muted?: boolean }) {
  return (
    <div className="flex justify-between items-start gap-2 text-xs">
      <span className="text-gray-500 dark:text-gray-400 shrink-0">{label}</span>
      <span className={`text-right font-mono truncate max-w-[65%] ${muted ? "text-gray-400 dark:text-gray-500" : "text-gray-700 dark:text-gray-200"}`}>
        {value}
      </span>
    </div>
  );
}

export function LaunchPreviewPanel({
  issueId,
  branch,
  baseBranch,
  isDirect,
  requiresReview,
  planMode,
  tddMode,
  skipSetup,
  skillId,
  selectedProfile,
  selectedModel,
  disabled,
}: LaunchPreviewPanelProps) {
  const [preview, setPreview] = useState<LaunchPreviewData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (disabled || !issueId) {
      setPreview(null);
      return;
    }

    // Debounce: cancel in-flight request before starting a new one
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const timer = setTimeout(() => {
      setLoading(true);
      setError(null);

      // Parse provider profile from selectedProfile ("claude:name" format)
      let profileObj: { provider?: string; name?: string } | undefined;
      if (selectedProfile) {
        const colonIdx = selectedProfile.indexOf(":");
        if (colonIdx !== -1) {
          const provider = selectedProfile.slice(0, colonIdx);
          const name = selectedProfile.slice(colonIdx + 1);
          if ((provider === "claude" || provider === "codex" || provider === "copilot") && name) {
            profileObj = { provider, name };
          }
        }
      }

      const body: Record<string, unknown> = {
        issueId,
        branch,
        isDirect,
        baseBranch: baseBranch || undefined,
        requiresReview,
        planMode,
        tddMode,
        skipSetup,
        skillId: skillId || undefined,
        profile: profileObj,
        model: selectedModel || undefined,
      };

      apiFetch<LaunchPreviewData>("/api/workspaces/preview", {
        method: "POST",
        body: JSON.stringify(body),
        signal: controller.signal,
      })
        .then((data) => {
          if (!controller.signal.aborted) {
            setPreview(data);
            setLoading(false);
          }
        })
        .catch((err) => {
          if (!controller.signal.aborted) {
            setError(err instanceof Error ? err.message : "Preview unavailable");
            setPreview(null);
            setLoading(false);
          }
        });
    }, 300); // 300ms debounce

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [issueId, branch, baseBranch, isDirect, requiresReview, planMode, tddMode, skipSetup, skillId, selectedProfile, selectedModel, disabled]);

  if (disabled || !issueId) return null;

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded p-2 space-y-1.5 bg-gray-50 dark:bg-gray-800/50">
      <div className="flex items-center gap-1.5 text-xs font-medium text-gray-500 dark:text-gray-400">
        <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7Z" />
        </svg>
        <span>Launch Preview</span>
        {loading && (
          <span className="text-gray-400 dark:text-gray-500 animate-pulse">computing…</span>
        )}
      </div>

      {error && (
        <p className="text-xs text-amber-600 dark:text-amber-400">{error}</p>
      )}

      {preview && (
        <>
          {preview.isDirect ? (
            <PreviewRow label="Mode" value="Direct (main checkout)" />
          ) : (
            <>
              <PreviewRow label="Branch" value={preview.branch || "—"} muted={!preview.branch} />
              <PreviewRow
                label="Base"
                value={preview.baseBranch || "none"}
                muted={!preview.baseBranch}
              />
            </>
          )}
          <PreviewRow label="Provider" value={providerLabel(preview.provider)} />
          {preview.profile && (
            <PreviewRow label="Profile" value={preview.profile} />
          )}
          {preview.model && (
            <PreviewRow label="Model" value={modelLabel(preview.model)} />
          )}
          {preview.skill && (
            <PreviewRow label="Skill" value={preview.skill.name} />
          )}
          <div className="flex flex-wrap gap-1.5 pt-0.5">
            {preview.planMode && (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">
                Plan
              </span>
            )}
            {preview.tddMode && (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300">
                TDD
              </span>
            )}
            {preview.requiresReview && (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300">
                Review
              </span>
            )}
            {preview.setupScript && !preview.setupScript.willRun && (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400">
                Skip setup
              </span>
            )}
            {preview.setupScript?.willRun && (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                Setup{preview.setupScript.blocking ? " (blocking)" : " (parallel)"}
              </span>
            )}
          </div>

          {preview.budgetEstimate && (
            <BudgetRiskBadge estimate={preview.budgetEstimate} />
          )}

          {preview.warnings.length > 0 && (
            <div className="space-y-1 pt-1">
              {preview.warnings.map((w, i) => (
                <div key={i} className="flex gap-1.5 items-start text-xs text-amber-600 dark:text-amber-400">
                  <svg className="h-3.5 w-3.5 shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
                  </svg>
                  <span>{w}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

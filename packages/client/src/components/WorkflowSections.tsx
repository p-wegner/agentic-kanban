import { Field, Toggle } from "./SettingsPrimitives.js";
import { SlowRequestsPanel } from "./SlowRequestsPanel.js";
import type { Settings, MonitorTunables } from "../lib/settings-shared.js";
import type { MonitorAction } from "./MonitorPopover.js";

export type WorkflowSectionProps = {
  settings: Settings;
  set: (key: keyof Settings) => (value: string) => void;
  setBool: (key: keyof Settings) => (checked: boolean) => void;
};

export function WorkflowProcessPipelineSection({ settings }: { settings: Settings }) {
  return (
    <div className="bg-gray-50 dark:bg-gray-950 border border-gray-200 dark:border-gray-700 rounded-lg p-3 mb-2">
      <div className="text-xs font-medium text-gray-600 dark:text-gray-400 mb-2">Process pipeline</div>
      <div className="flex items-center gap-1 flex-wrap">
        {[
          { label: "Agent runs", always: true },
          { label: "Manual approval", key: "require_manual_approval", enabled: settings.require_manual_approval === "true" },
          { label: "Learn (after agent)", key: "learning_step_after_agent", enabled: settings.learning_step_after_agent === "true" },
          { label: "AI Review", key: "auto_review", enabled: settings.auto_review !== "false" },
          { label: "Auto-fix", key: "review_auto_fix", enabled: settings.auto_review !== "false" && settings.review_auto_fix !== "false", indent: true },
          { label: "Learn (after review)", key: "learning_step_after_review", enabled: settings.learning_step_after_review === "true" },
          { label: "Auto-merge", key: "auto_merge", enabled: settings.auto_review !== "false" && settings.auto_merge !== "false", indent: true },
          { label: "Learn (before merge)", key: "learning_step_before_merge", enabled: settings.learning_step_before_merge === "true" },
          { label: "Merge", always: true },
          { label: "Visual verify", key: "visual_verification_mode", enabled: settings.visual_verification_mode === "after_merge" },
        ].filter((s) => s.always || s.enabled).map((step, i) => (
          <div key={step.label} className="flex items-center gap-1">
            {i > 0 && <span className="text-gray-400 dark:text-gray-500 text-xs">→</span>}
            <span className={`px-2 py-0.5 rounded text-xs font-medium ${step.always ? "bg-brand-100 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300" : "bg-green-100 text-green-700"}`}>
              {step.label}
            </span>
          </div>
        ))}
      </div>
      <div className="text-xs text-gray-400 dark:text-gray-500 mt-1.5">Green steps are optional — toggle them below to add/remove from pipeline.</div>
    </div>
  );
}

export function WorkflowAgentBehaviourSection({ settings, setBool }: WorkflowSectionProps) {
  return (
    <div className="pt-2">
      <div className="text-[11px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-3">Agent behaviour</div>
      <div className="space-y-3">
        <Toggle
          checked={(settings["harness.codex.plan_auto_continue"] ?? settings.plan_auto_continue) !== "false"}
          onChange={setBool("harness.codex.plan_auto_continue")}
          label="Auto-continue after plan (Codex)"
          hint="When a Codex plan-mode run finishes, the plan is saved to PLAN.md. If on, an implementation turn starts automatically. If off, the workspace waits for you to review the plan and click Accept & Implement."
        />
        <Toggle
          checked={(settings["harness.copilot.plan_auto_continue"] ?? settings.plan_auto_continue) !== "false"}
          onChange={setBool("harness.copilot.plan_auto_continue")}
          label="Auto-continue after plan (Copilot)"
          hint="Same as the Codex setting, but for Copilot plan-mode runs."
        />
        <Toggle
          checked={settings.resume_with_new_model === "true"}
          onChange={setBool("resume_with_new_model")}
          label="Use new profile on resume"
          hint="When continuing a chat, start a fresh session using the current profile instead of resuming the previous one. Use this when switching providers via a different Claude profile."
        />
        <Toggle
          checked={settings.persistent_agent === "true"}
          onChange={setBool("persistent_agent")}
          label="Persistent agent (warm pool)"
          hint="Keep a warm agent process alive between sessions to reduce startup latency. Experimental."
        />
      </div>
    </div>
  );
}

export function WorkflowReviewMergeSection({ settings, set, setBool, autoReviewOn }: WorkflowSectionProps & { autoReviewOn: boolean }) {
  return (
    <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
      <div className="text-[11px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-3">Code review &amp; merge pipeline</div>
      <div className="space-y-3">
        <Toggle
          checked={autoReviewOn}
          onChange={setBool("auto_review")}
          label="Auto Code Review"
          hint="When an agent commits and exits successfully, automatically launch a review agent that checks the diff for issues."
        />
        <div className={`pl-5 space-y-3 border-l-2 ${autoReviewOn ? "border-brand-200 dark:border-brand-700" : "border-gray-100 dark:border-gray-800"}`}>
          <Toggle
            checked={settings.review_auto_fix !== "false"}
            onChange={setBool("review_auto_fix")}
            label="Auto-fix issues found in review"
            hint="When the review agent finds CRITICAL or MAJOR issues, it edits the code and commits fixes directly. Requires 'Skip permission prompts' to be enabled so the agent can write files. When disabled, the agent reports issues but makes no changes."
            disabled={!autoReviewOn}
          />
          <Toggle
            checked={settings.auto_merge !== "false"}
            onChange={setBool("auto_merge")}
            label="Auto-merge after review"
            hint="Merge the branch and close the workspace automatically once the review agent passes. When disabled, the issue moves to AI Reviewed and waits for manual merge."
            disabled={!autoReviewOn}
          />
          <Field
            label="Merge strategy"
            hint="Choose who owns reviewed branches. Direct leaves merges to manual per-workspace actions. Monitor lets the board monitor merge immediately. Merge queue batches reviewed workspaces into the queue release train."
          >
            <select
              value={settings.merge_strategy || (settings.auto_monitor === "true" ? "monitor" : "merge_queue")}
              onChange={(e) => set("merge_strategy")(e.target.value)}
              disabled={!autoReviewOn || settings.auto_merge === "false"}
              className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:opacity-50"
            >
              <option value="direct">Direct/manual - one workspace at a time</option>
              <option value="monitor">Monitor - merge as soon as ready</option>
              <option value="merge_queue">Merge queue - batch and land in order</option>
            </select>
          </Field>
          <Toggle
            checked={settings.auto_merge_in_review === "true"}
            onChange={setBool("auto_merge_in_review")}
            label="Auto-merge In Review without 'ready' gate"
            hint="When on, the board monitor merges any idle In-Review workspace whose work is committed — even if the agent never marked it 'ready for merge'. This lands In-Review work to master with no human gating. When off (default), not-yet-ready In-Review work is left waiting. Still respects the Auto-merge kill-switch above."
            disabled={!autoReviewOn || settings.auto_merge === "false"}
          />
        </div>
        <Toggle
          checked={settings.require_manual_approval === "true"}
          onChange={setBool("require_manual_approval")}
          label="Require manual approval before review"
          hint="When enabled, issues must be manually approved before the AI review step is triggered. Useful for gating expensive review sessions on deliberate human sign-off."
        />
        <Toggle
          checked={settings.skip_preflight === "true"}
          onChange={setBool("skip_preflight")}
          label="Skip pre-flight check"
          hint="Disable the AI ticket sanity check that runs before 'Start workspace'. When enabled, workspaces are created immediately without checking if the ticket is clear, unambiguous, and not a duplicate."
        />
        <Field
          label="Visual verification timing"
          hint="Controls when UI changes are visually verified via browser snapshot. 'Before merge' blocks the agent until it verifies (default, Claude only). 'After merge' lets the agent stop without verifying — the issue is tagged with 'needs-visual-verification' after merge and verification runs on master."
        >
          <select
            value={settings.visual_verification_mode || "before_merge"}
            onChange={(e) => set("visual_verification_mode")(e.target.value)}
            className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md focus:outline-none focus:ring-1 focus:ring-brand-500"
          >
            <option value="before_merge">Before merge (default) — agent must verify UI before stopping</option>
            <option value="after_merge">After merge — verification runs on master after merge completes</option>
          </select>
        </Field>
        {(settings.visual_verification_mode || "before_merge") === "after_merge" && (
          <Field
            label="After-merge verification agent"
            hint="Who performs visual verification after merge. 'None' just tags the issue. 'Reviewer' instructs the review agent to merge then verify UI. 'Dedicated agent' spawns a separate verification-only session after the merge completes."
          >
            <select
              value={settings.after_merge_verify_agent || "none"}
              onChange={(e) => set("after_merge_verify_agent")(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md focus:outline-none focus:ring-1 focus:ring-brand-500"
            >
              <option value="none">None (default) — tag issue, manual verification</option>
              <option value="reviewer">Reviewer — review agent merges + verifies UI</option>
              <option value="dedicated">Dedicated agent — separate verification session after merge</option>
            </select>
          </Field>
        )}
      </div>
    </div>
  );
}

export function WorkflowLearningSection({ settings, setBool }: WorkflowSectionProps) {
  return (
    <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
      <div className="text-[11px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-3">Learning steps</div>
      <div className="space-y-3">
        <Toggle
          checked={settings.learning_step_after_agent === "true"}
          onChange={setBool("learning_step_after_agent")}
          label="Learning step after agent (parallel)"
          hint="When an agent session completes with committed changes, runs a learning session in parallel with code review. Extracts insights from session transcripts and updates docs and hooks without blocking the review."
        />
        <Toggle
          checked={settings.learning_step_after_review === "true"}
          onChange={setBool("learning_step_after_review")}
          label="Learning step after review (parallel)"
          hint="When a review session completes, runs a learning session in parallel with the auto-merge step. Extracts insights without delaying the merge."
        />
        <Toggle
          checked={settings.learning_step_before_merge === "true"}
          onChange={setBool("learning_step_before_merge")}
          label="Learning step before merge (blocking)"
          hint="When enabled, runs an agent session before merging that reads the worktree's session transcripts and updates docs and Claude hooks with extracted insights. Blocks merge until complete (up to 3 minutes)."
        />
      </div>
    </div>
  );
}

export function WorkflowFollowUpSection({
  settings,
  set,
  setBool,
  activeProjectId,
  onButlerEventFeedOverrideChange,
}: WorkflowSectionProps & {
  onButlerEventFeedOverrideChange: (value: string) => void;
  activeProjectId?: string | null;
}) {
  return (
    <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
      <div className="text-[11px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-3">Follow-up &amp; automation</div>
      <div className="space-y-3">
        <Toggle
          checked={settings.auto_start_followup === "true"}
          onChange={setBool("auto_start_followup")}
          label="Auto-start follow-up tasks after merge"
          hint="When a workspace is merged and the issue has outgoing 'depends_on' or 'child_of' dependencies, automatically create workspaces for unblocked follow-up issues."
        />
        <Toggle
          checked={settings.dependency_auto_chain === "true"}
          onChange={setBool("dependency_auto_chain")}
          label="Auto-chain unblocked dependencies"
          hint="After an upstream issue merges, start newly unblocked dependent or child issues when WIP capacity is available. Add the no-auto-start tag to opt out individual issues."
        />
        <Toggle
          checked={settings.auto_rebase_on_continue === "true"}
          onChange={setBool("auto_rebase_on_continue")}
          label="Auto-rebase on continue"
          hint="Before resuming a workspace agent (via /turn or /launch), automatically rebase the feature branch onto the latest base branch. If rebase conflicts arise, the operation fails with a clear error rather than starting the agent on a stale base."
        />
        <Toggle
          checked={settings.butler_event_feed === "true"}
          onChange={setBool("butler_event_feed")}
          label="Butler event feed"
          hint="Notify the butler about critical board events (merge failures, agent crashes, stuck workspaces, permission requests). The butler receives them as tagged [system event] messages and can react when next addressed. Rate-limited per project."
        />
        <Toggle
          checked={settings.butler_auto_answer === "true"}
          onChange={setBool("butler_auto_answer")}
          label="Butler auto-answer agent questions"
          hint="Butler will reply to agents without asking you first. Review the audit log to catch mistakes. Only applies when the butler has a confident recommendation for every sub-question."
        />
        {settings.butler_event_feed === "true" && (
          <div className="pl-5 flex items-center gap-2">
            <label className="text-xs text-gray-600 dark:text-gray-400">Min interval</label>
            <input
              type="number"
              min="1000"
              step="1000"
              value={settings.butler_event_feed_min_interval_ms || "30000"}
              onChange={(e) => set("butler_event_feed_min_interval_ms")(e.target.value)}
              className="w-24 px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
            <span className="text-xs text-gray-500 dark:text-gray-400">ms (bursts collapse into a summary)</span>
          </div>
        )}
        {activeProjectId && (
          <div className="pl-5">
            <Field
              label="Per-project override"
              hint="Override the global setting for this project. 'Inherit' uses the global toggle above."
            >
              <select
                value={settings[`butler_event_feed_${activeProjectId}` as keyof Settings] ?? ""}
                onChange={(e) => onButlerEventFeedOverrideChange(e.target.value)}
                className="px-3 py-1.5 text-xs border border-gray-300 dark:border-gray-600 rounded-md focus:outline-none focus:ring-1 focus:ring-brand-500"
              >
                <option value="">Inherit (global)</option>
                <option value="true">Force on for this project</option>
                <option value="false">Force off for this project</option>
              </select>
            </Field>
          </div>
        )}
      </div>
    </div>
  );
}

export function AdvancedSettingsSection({ settings, setBool }: WorkflowSectionProps) {
  return (
    <>
      <Toggle
        checked={settings.skip_permissions === "true"}
        onChange={setBool("skip_permissions")}
        label="Skip Permissions (--dangerously-skip-permissions)"
        hint="Bypass all permission checks. Recommended only for sandboxes with no internet access."
      />
      <Toggle
        checked={settings.permission_prompt_tool !== "false"}
        onChange={setBool("permission_prompt_tool")}
        label="Permission Prompt Tool"
        hint="Pass --permission-prompt-tool to Claude Code. Routes tool approval requests through the UI instead of the terminal."
      />
      <div className="pt-4 border-t border-gray-100">
        <SlowRequestsPanel />
      </div>
    </>
  );
}

export type WorkflowBoardMonitorSectionProps = WorkflowSectionProps & {
  activeProjectId?: string | null;
  monitorStatus: {
    enabled: boolean;
    intervalMin: number;
    active: boolean;
    lastRun: string | null;
    nextRunAt: string | null;
    recentActions: MonitorAction[];
    maintenanceActive?: boolean;
    maintenanceEnd?: string | null;
  } | null;
  monitorTunables: { tunables: MonitorTunables; source: "strategy" | "prefs" } | null;
  monitorRunning: boolean;
  migratingToStrategy: boolean;
  skills: { id: string; name: string }[];
  onRunMonitorNow: () => void;
  onMigrateToStrategy: () => void;
};

export function WorkflowBoardMonitorSection({
  settings,
  set,
  setBool,
  activeProjectId,
  monitorStatus,
  monitorTunables,
  monitorRunning,
  migratingToStrategy,
  skills,
  onRunMonitorNow,
  onMigrateToStrategy,
}: WorkflowBoardMonitorSectionProps) {
  return (
    <>
      {activeProjectId && (
        <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
          <div className="text-[11px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">Monitor Policy</div>
          {monitorTunables ? (
            <div className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
              <div className="flex items-center justify-between px-3 py-2 bg-gray-50 dark:bg-gray-950 border-b border-gray-200 dark:border-gray-700">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-600 dark:text-gray-400">Control surface:</span>
                  {monitorTunables.source === "strategy" ? (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-brand-50 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300 border border-brand-200 dark:border-brand-700 font-medium">Strategy Bullseye</span>
                  ) : (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300 border border-amber-200 dark:border-amber-700 font-medium">Legacy prefs (nudge_*)</span>
                  )}
                </div>
                {monitorTunables.source === "prefs" && (
                  <button
                    onClick={onMigrateToStrategy}
                    disabled={migratingToStrategy}
                    className="text-xs px-2.5 py-1 rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed"
                    title="Create a board_strategy pref from current nudge_* values so this project uses the Strategy Bullseye path"
                  >
                    {migratingToStrategy ? "Migrating…" : "Migrate to Strategy"}
                  </button>
                )}
              </div>
              <div className="px-3 py-2 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-gray-500 dark:text-gray-400">Active agents target</span>
                  <span className="font-mono font-medium text-gray-800 dark:text-gray-200">{monitorTunables.tunables.activeAgentsTarget}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-gray-500 dark:text-gray-400">Backlog floor</span>
                  <span className="font-mono font-medium text-gray-800 dark:text-gray-200">{monitorTunables.tunables.backlogFloor}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-gray-500 dark:text-gray-400">Max starts / cycle</span>
                  <span className="font-mono font-medium text-gray-800 dark:text-gray-200">{monitorTunables.tunables.maxNewStartsPerCycle}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-gray-500 dark:text-gray-400">Refill focus</span>
                  <span className="font-mono font-medium text-gray-800 dark:text-gray-200">{monitorTunables.tunables.refillFocus}</span>
                </div>
              </div>
              {monitorTunables.source === "prefs" ? (
                <div className="px-3 pb-2 text-[11px] text-amber-600 dark:text-amber-400 leading-snug">
                  <span className="font-semibold">nudge_wip_limit</span> and <span className="font-semibold">nudge_auto_start</span> are the active tuning prefs. Open the Strategy Bullseye or click Migrate to upgrade to the full target set.
                </div>
              ) : (
                <div className="px-3 pb-2 text-[11px] text-gray-500 dark:text-gray-400 leading-snug">
                  <span className="inline-flex items-center gap-1 mr-1 px-1 py-0 rounded bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 font-mono text-[10px] border border-gray-200 dark:border-gray-700 line-through">nudge_wip_limit</span>
                  and
                  <span className="inline-flex items-center gap-1 mx-1 px-1 py-0 rounded bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 font-mono text-[10px] border border-gray-200 dark:border-gray-700 line-through">nudge_auto_start</span>
                  are superseded — Strategy Bullseye targets are in effect.
                </div>
              )}
            </div>
          ) : (
            <div className="text-xs text-gray-400 dark:text-gray-500 italic">Loading policy…</div>
          )}
        </div>
      )}

      {/* Which monitor decision guide */}
      <details className="pt-4 border-t border-gray-200 dark:border-gray-700 group">
        <summary className="cursor-pointer list-none flex items-center gap-1.5 text-[11px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider select-none">
          <svg className="w-3 h-3 transition-transform group-open:rotate-90 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
          Which monitor to use?
        </summary>
        <div className="mt-2 rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden text-[11px] leading-snug">
          <div className="px-3 py-2 bg-gray-50 dark:bg-gray-950 border-b border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400">
            Three mechanisms can drive the board. They are independent — enable the one that fits your project.
          </div>
          <div className="divide-y divide-gray-100 dark:divide-gray-800">
            <div className="px-3 py-2 space-y-0.5">
              <div className="flex items-center gap-1.5">
                <span className="font-semibold text-gray-700 dark:text-gray-300">In-process monitor</span>
                <span className="text-[10px] px-1 py-0 rounded bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300 border border-green-200 dark:border-green-700">default on</span>
              </div>
              <div className="text-gray-500 dark:text-gray-400">Runs inside the server. Toggle: <span className="font-mono">auto_monitor</span> above. Targets from: Strategy Bullseye when a <span className="font-mono">board_strategy_*</span> pref exists, otherwise <span className="font-mono text-amber-600 dark:text-amber-400">nudge_wip_limit</span> (legacy). Use for any project you develop with agentic-kanban.</div>
            </div>
            <div className="px-3 py-2 space-y-0.5">
              <div className="flex items-center gap-1.5">
                <span className="font-semibold text-gray-700 dark:text-gray-300">Strategy Bullseye</span>
                <span className="text-[10px] px-1 py-0 rounded bg-brand-50 text-brand-700 dark:bg-brand-900/30 dark:text-brand-300 border border-brand-200 dark:border-brand-700">policy surface</span>
              </div>
              <div className="text-gray-500 dark:text-gray-400">Configures all three mechanisms via a single <span className="font-mono">board_strategy_*</span> pref. When saved it supersedes <span className="font-mono line-through text-gray-400 dark:text-gray-500">nudge_wip_limit</span> / <span className="font-mono line-through text-gray-400 dark:text-gray-500">nudge_auto_start</span> for the deterministic monitor. Open via the board toolbar (bullseye icon).</div>
            </div>
            <div className="px-3 py-2 space-y-0.5">
              <div className="flex items-center gap-1.5">
                <span className="font-semibold text-gray-700 dark:text-gray-300">External Conductor loop</span>
                <span className="text-[10px] px-1 py-0 rounded bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400 border border-gray-200 dark:border-gray-700">dogfooding only</span>
              </div>
              <div className="text-gray-500 dark:text-gray-400"><span className="font-mono">scripts/board-monitor/loop.sh</span> — short-lived agent sessions on a fixed cadence. Only needed when you are developing agentic-kanban itself (the server restart blast-radius makes the in-process monitor fragile). Reads <span className="font-mono">objective.md</span> and the Strategy Bullseye targets.</div>
            </div>
          </div>
        </div>
      </details>

      <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <div className="text-xs font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide">Board Monitor</div>
            {monitorStatus && (
              <>
                <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${monitorStatus.active ? "bg-green-100 text-green-700" : "bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400"}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${monitorStatus.active ? "bg-green-500 animate-pulse" : "bg-gray-400"}`} />
                  {monitorStatus.active ? "Active" : "Idle"}
                </span>
                {monitorStatus.maintenanceActive && (
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                    Maintenance
                  </span>
                )}
              </>
            )}
          </div>
          <button
            onClick={onRunMonitorNow}
            disabled={monitorRunning}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            title="Run a monitor cycle now and restart the interval timer"
          >
            {monitorRunning ? (
              <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg>
            ) : (
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 010 1.972l-11.54 6.347a1.125 1.125 0 01-1.667-.986V5.653z"/></svg>
            )}
            {monitorRunning ? "Running…" : "Run now"}
          </button>
        </div>
        <div className="flex items-center gap-4">
          <Toggle
            checked={settings.auto_monitor === "true"}
            onChange={setBool("auto_monitor")}
            label="Auto-monitor"
            hint="Periodically checks workspaces and relaunches idle agents, triggers merges, and auto-starts unblocked issues."
          />
        </div>
        {settings.auto_monitor === "true" && (
          <div className="mt-2 pl-5 flex items-center gap-2">
            <label className="text-xs text-gray-600 dark:text-gray-400">Interval</label>
            <input
              type="number"
              min="1"
              max="60"
              value={settings.auto_monitor_interval || "4"}
              onChange={(e) => set("auto_monitor_interval")(e.target.value)}
              className="w-16 px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
            <span className="text-xs text-gray-500 dark:text-gray-400">min</span>
          </div>
        )}
        <div className="mt-3 pl-5">
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-600 dark:text-gray-400">Stale backlog threshold</label>
            <input
              type="number"
              min="1"
              value={settings.backlog_stale_days || "14"}
              onChange={(e) => set("backlog_stale_days")(e.target.value)}
              className="w-16 px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
            <span className="text-xs text-gray-500 dark:text-gray-400">days</span>
          </div>
          <p className="mt-1 text-[11px] text-gray-400 dark:text-gray-500 leading-snug">
            Backlog issues with no activity for this many days are flagged as Stale on the board.
          </p>
        </div>
        <div className="mt-3 pl-5">
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-600 dark:text-gray-400">In Progress staleness threshold</label>
            <input
              type="number"
              min="1"
              value={settings.inprogress_stale_days || "3"}
              onChange={(e) => set("inprogress_stale_days")(e.target.value)}
              className="w-16 px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
            <span className="text-xs text-gray-500 dark:text-gray-400">days</span>
          </div>
          <p className="mt-1 text-[11px] text-gray-400 dark:text-gray-500 leading-snug">
            In Progress cards older than this threshold get a warning badge. Age badges appear on all cards.
          </p>
        </div>
        {settings.auto_monitor === "true" && (
          <div className="mt-3 pl-5">
            <div className="flex items-center gap-2">
              <label className="text-xs text-gray-600 dark:text-gray-400">When backlog is empty</label>
              <select
                value={settings.backlog_empty_strategy || "skip"}
                onChange={(e) => set("backlog_empty_strategy")(e.target.value)}
                className="px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded focus:outline-none focus:ring-1 focus:ring-brand-500 bg-white dark:bg-gray-900"
              >
                <option value="skip">Do nothing</option>
                <option value="generate_tickets">Generate new tickets (run a skill)</option>
              </select>
            </div>
            <p className="mt-1 text-[11px] text-gray-400 dark:text-gray-500 leading-snug">
              When 0 unstarted Todo issues remain, run a skill that creates new high-value, local-only tickets. Respects the WIP limit and the cooldown below.
            </p>
            {settings.backlog_empty_strategy === "generate_tickets" && (
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
                <div className="flex items-center gap-2">
                  <label className="text-xs text-gray-600 dark:text-gray-400">Skill</label>
                  <select
                    value={settings.backlog_empty_skill || "architecture-improvement"}
                    onChange={(e) => set("backlog_empty_skill")(e.target.value)}
                    className="px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded focus:outline-none focus:ring-1 focus:ring-brand-500 bg-white dark:bg-gray-900"
                  >
                    <option value="architecture-improvement">architecture-improvement</option>
                    <option value="ui-explorer">ui-explorer</option>
                    {skills
                      .filter((s) => s.name !== "architecture-improvement" && s.name !== "ui-explorer")
                      .map((s) => (
                        <option key={s.id} value={s.name}>{s.name}</option>
                      ))}
                  </select>
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-xs text-gray-600 dark:text-gray-400">Cooldown</label>
                  <input
                    type="number"
                    min="1"
                    value={settings.backlog_empty_cooldown_min || "120"}
                    onChange={(e) => set("backlog_empty_cooldown_min")(e.target.value)}
                    className="w-20 px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded focus:outline-none focus:ring-1 focus:ring-brand-500"
                  />
                  <span className="text-xs text-gray-500 dark:text-gray-400">min</span>
                </div>
              </div>
            )}
          </div>
        )}
        <div className="mt-3">
          <Toggle
            checked={settings.monitor_maintenance_window_enabled === "true"}
            onChange={setBool("monitor_maintenance_window_enabled")}
            label="Maintenance window"
            hint="Pause disruptive board actions (merges, relaunches, auto-start) while keeping health checks running. Enable before deployments, migrations, or manual board work."
          />
          {settings.monitor_maintenance_window_enabled === "true" && (
            <div className="mt-2 pl-5 space-y-2">
              <div className="flex items-center gap-2">
                <label className="text-xs text-gray-600 dark:text-gray-400">End time</label>
                <input
                  type="datetime-local"
                  value={settings.monitor_maintenance_window_end
                    ? new Date(new Date(settings.monitor_maintenance_window_end).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16)
                    : ""}
                  onChange={(e) => set("monitor_maintenance_window_end")(e.target.value ? new Date(e.target.value).toISOString() : "")}
                  className="px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded focus:outline-none focus:ring-1 focus:ring-brand-500 bg-white dark:bg-gray-900"
                />
                <span className="text-xs text-gray-500 dark:text-gray-400">(leave blank = indefinite)</span>
              </div>
              {monitorStatus?.maintenanceActive && (
                <p className="text-xs text-amber-600 dark:text-amber-400 font-medium">
                  Maintenance window active{monitorStatus.maintenanceEnd ? ` — ends ${new Date(monitorStatus.maintenanceEnd).toLocaleString("en-US")}` : " (indefinite)"}
                </p>
              )}
              {settings.monitor_maintenance_window_enabled === "true" && !monitorStatus?.maintenanceActive && settings.monitor_maintenance_window_end && new Date(settings.monitor_maintenance_window_end).getTime() <= Date.now() && (
                <p className="text-xs text-gray-500 dark:text-gray-400 italic">Window has expired — disable the toggle to clear it.</p>
              )}
            </div>
          )}
        </div>
        <div className="mt-3">
          <Toggle
            checked={settings.auto_commit_strategy_objective !== "false"}
            onChange={setBool("auto_commit_strategy_objective")}
            label="Auto-commit strategy objective.md"
            hint="When you save the Strategy Bullseye, the board regenerates the git-tracked scripts/board-monitor/objective.md. Commit it automatically (path-scoped) so the main checkout doesn't stay dirty and block the auto-merge queue. Disable to commit it yourself."
          />
        </div>
        {monitorStatus && (
          <div className="mt-3 rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2 bg-gray-50 dark:bg-gray-950 border-b border-gray-200 dark:border-gray-700">
              <span className="text-[11px] font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">Last cycle</span>
              <div className="flex items-center gap-3 text-[11px] text-gray-500 dark:text-gray-400">
                {monitorStatus.lastRun && (
                  <span title={new Date(monitorStatus.lastRun).toLocaleString('en-US')}>{new Date(monitorStatus.lastRun).toLocaleTimeString('en-US')}</span>
                )}
                {monitorStatus.nextRunAt && (
                  <span className="text-blue-500" title="Next scheduled run">→ {new Date(monitorStatus.nextRunAt).toLocaleTimeString('en-US')}</span>
                )}
              </div>
            </div>
            <div className="max-h-32 overflow-y-auto">
              {monitorStatus.recentActions.length > 0 ? (
                <ul className="divide-y divide-gray-100 dark:divide-gray-800">
                  {monitorStatus.recentActions.slice(0, 10).map((action, i) => (
                    <li key={i} className="px-3 py-1.5 text-[11px] text-gray-600 dark:text-gray-400 leading-snug flex items-center gap-2">
                      <span className="font-medium">{action.action}</span>
                      {action.httpStatus != null && <span className="text-gray-400 dark:text-gray-500 font-mono">{action.httpStatus}</span>}
                      {action.verificationResult && <span className="text-gray-400 dark:text-gray-500">{action.verificationResult}</span>}
                      <span className="ml-auto text-gray-400 dark:text-gray-500 font-mono shrink-0">{new Date(action.at).toLocaleTimeString('en-US')}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="px-3 py-2.5 text-[11px] text-gray-400 dark:text-gray-500 italic">No actions taken in last cycle</div>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
}

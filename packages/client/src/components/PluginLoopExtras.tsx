import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import type { DiffComment, CreateDiffCommentRequest } from "@agentic-kanban/shared";
import { apiFetch, apiPost, apiPut } from "../lib/api.js";
import { showToast } from "./Toast.js";
import { formatRelativeTime } from "../lib/formatRelativeTime.js";
import { DiffViewer } from "./DiffViewer.js";

/**
 * The loop pane's structured extras (#286–#294): approval gate card, pipeline
 * stepper, check badges, artifact viewer, and the audit timeline. Split out of
 * PluginActionPanes so that file stays under the god-module ceiling and each
 * concern here is independently testable.
 */

export type PluginGateAction = { id: string; label: string; input?: "text" };
export type PluginGate = {
  id: string;
  question: string;
  artifacts?: string[];
  actions: PluginGateAction[];
};
export type PluginProgressStep = {
  id: string;
  label: string;
  state: "done" | "generating" | "awaiting-approval" | "needs-revision" | "locked" | "failed" | "pending";
  version?: string;
  artifacts?: string[];
};
export type PluginCheck = { name: string; verdict: "pass" | "warn" | "fail"; detail?: string };
export type StartPolicy = { mode: string; autoStartUnblocked: boolean } | null;

// ── State chips (#293) ────────────────────────────────────────────────

/** Why the loop planned nothing — four look-alike states, told apart explicitly. */
export function LoopStateChips({ loop, startPolicy }: {
  loop: {
    paused: boolean; converged: boolean; openTickets: number;
    gate: PluginGate | null; note: string | null; closedTickets: number;
    awaitingMerge?: { workspaceId: string; issueNumber: number | null; issueTitle: string } | null;
  };
  startPolicy: StartPolicy;
}) {
  const chips: Array<{ text: string; tone: "gray" | "amber" | "green" | "blue" | "red" }> = [];
  if (loop.paused) chips.push({ text: "Paused", tone: "amber" });
  if (loop.awaitingMerge) chips.push({ text: "Step done — waiting for merge", tone: "amber" });
  else if (loop.openTickets > 0) chips.push({ text: "Round running", tone: "blue" });
  else if (loop.converged) chips.push({ text: "Converged", tone: "green" });
  else if (loop.gate) chips.push({ text: "Waiting on you", tone: "amber" });
  else if (loop.note && loop.closedTickets + loop.openTickets > 0) chips.push({ text: "Waiting on input", tone: "amber" });
  // The worst trap: under manual start mode the monitor never runs the planner, which is
  // indistinguishable from convergence unless somebody says so.
  if (startPolicy && startPolicy.mode === "manual" && !loop.converged) {
    chips.push({ text: "Start mode is Manual — the monitor will not drive this loop", tone: "red" });
  }
  if (chips.length === 0) return null;
  const toneClass = {
    gray: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
    amber: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
    green: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
    blue: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
    red: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  } as const;
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="plugin-loop-state-chips">
      {chips.map((chip) => (
        <span key={chip.text} className={`text-[11px] px-2 py-0.5 rounded ${toneClass[chip.tone]}`}>
          {chip.text}
        </span>
      ))}
    </div>
  );
}

// ── Check badges (#290) ───────────────────────────────────────────────

export function ChecksBadges({ checks }: { checks: PluginCheck[] | null }) {
  if (!checks || checks.length === 0) return null;
  const tone = {
    pass: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
    warn: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
    fail: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  } as const;
  const mark = { pass: "✓", warn: "⚠", fail: "✕" } as const;
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="plugin-loop-checks">
      {checks.map((check) => (
        <span
          key={check.name}
          title={check.detail ?? check.name}
          className={`text-[11px] px-2 py-0.5 rounded cursor-default ${tone[check.verdict]}`}
        >
          {mark[check.verdict]} {check.name}
        </span>
      ))}
    </div>
  );
}

// ── Pipeline stepper (#289) ───────────────────────────────────────────

const STEP_MARK: Record<PluginProgressStep["state"], string> = {
  "done": "✓",
  "generating": "⟳",
  "awaiting-approval": "👁",
  "needs-revision": "✎",
  "locked": "·",
  "failed": "✕",
  "pending": "·",
};

const STEP_TONE: Record<PluginProgressStep["state"], string> = {
  "done": "border-green-300 dark:border-green-800 text-green-800 dark:text-green-300 bg-green-50 dark:bg-green-900/20",
  "generating": "border-blue-300 dark:border-blue-800 text-blue-800 dark:text-blue-300 bg-blue-50 dark:bg-blue-900/20",
  "awaiting-approval": "border-amber-300 dark:border-amber-700 text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/20",
  "needs-revision": "border-amber-300 dark:border-amber-700 text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/20",
  "locked": "border-gray-200 dark:border-gray-700 text-gray-400 dark:text-gray-500 bg-transparent",
  "failed": "border-red-300 dark:border-red-800 text-red-800 dark:text-red-300 bg-red-50 dark:bg-red-900/20",
  "pending": "border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 bg-transparent",
};

export function ProgressStepper({ steps, onOpenArtifact }: {
  steps: PluginProgressStep[] | undefined;
  onOpenArtifact: (path: string) => void;
}) {
  if (!steps || steps.length === 0) return null;
  return (
    <ol className="flex flex-wrap items-center gap-1" data-testid="plugin-loop-stepper">
      {steps.map((step, i) => {
        const clickable = (step.artifacts?.length ?? 0) > 0;
        return (
          <li key={step.id} className="flex items-center gap-1">
            {i > 0 && <span className="text-gray-300 dark:text-gray-600 text-xs">—</span>}
            <button
              type="button"
              disabled={!clickable}
              onClick={() => clickable && onOpenArtifact(step.artifacts![0])}
              title={`${step.label} — ${step.state}${step.version ? ` (${step.version})` : ""}${clickable ? "\nClick to open the artifact" : ""}`}
              className={`text-[11px] px-2 py-1 rounded border ${STEP_TONE[step.state]} ${clickable ? "hover:underline cursor-pointer" : "cursor-default"}`}
            >
              <span aria-hidden="true">{STEP_MARK[step.state]}</span> {step.label}
              {step.version && <span className="opacity-70"> {step.version}</span>}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

// ── Awaiting-merge card (#299) ───────────────────────────────────────

/**
 * The loop's silent-stall state, made loud: the step's agent finished but the
 * workspace never landed, so the planner (reading the MAIN checkout) is blind
 * and every advance is a dedupe no-op. One click triggers the board merge; the
 * merge-to-advance hook (#298) then surfaces the gate on its own.
 */
export function AwaitingMergeCard({ awaitingMerge, onMergeStarted }: {
  awaitingMerge: { workspaceId: string; issueNumber: number | null; issueTitle: string };
  onMergeStarted: () => void;
}) {
  const [merging, setMerging] = useState(false);
  async function merge() {
    if (merging) return;
    setMerging(true);
    try {
      await apiPost(`/api/workspaces/${awaitingMerge.workspaceId}/merge?async=1`, {});
      showToast("Merge started — the loop advances automatically once it lands", "success");
      // Give the async merge a moment to land before the surface refetch.
      setTimeout(onMergeStarted, 8000);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Merge failed to start", "error");
      setMerging(false);
    }
  }
  return (
    <div
      className="rounded border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-3 max-w-2xl flex items-center gap-3"
      data-testid="plugin-loop-awaiting-merge"
    >
      <div className="flex-1 text-xs text-amber-900 dark:text-amber-200">
        <span className="font-medium">Step finished but not landed:</span>{" "}
        {awaitingMerge.issueNumber != null ? `#${awaitingMerge.issueNumber} ` : ""}{awaitingMerge.issueTitle}.
        {" "}Until the merge lands, the planner cannot see the artifacts.
      </div>
      <button
        onClick={() => void merge()}
        disabled={merging}
        className="text-sm px-3 py-1.5 rounded bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50 shrink-0"
        data-testid="plugin-loop-merge-now"
      >
        {merging ? "Merging…" : "Merge now"}
      </button>
    </div>
  );
}

// ── Approval gate card (#286) ─────────────────────────────────────────

type GateResolveResponse = {
  gateId: string;
  actionId: string;
  resolve: { code: number | null; stdout: string; stderr: string; timedOut: boolean };
  advance: { note: string | null; created: Array<{ issueNumber: number | null; title: string }> } | null;
};

export function GateCard({ pluginId, loopName, projectId, gate, checks, recommendation, lineNotes, onResolved, onOpenArtifact }: {
  pluginId: string;
  loopName: string;
  projectId: string;
  gate: PluginGate;
  /** Verification checks rendered EXPANDED on the card (#303) — the human should read the verdict without opening anything. */
  checks?: PluginCheck[] | null;
  /** The butler's pre-read verdict (#309). */
  recommendation?: { actionId: string; reason: string } | null;
  /** Line-anchored notes collected on the artifact diff (#304); appended to revise feedback. */
  lineNotes?: string[];
  onResolved: () => void;
  onOpenArtifact: (path: string) => void;
}) {
  const [selected, setSelected] = useState<PluginGateAction | null>(null);
  const [input, setInput] = useState("");
  const [resolving, setResolving] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [editing, setEditing] = useState<{ path: string; content: string; loading: boolean; saving: boolean } | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [summarizing, setSummarizing] = useState(false);

  // A fresh gate (new id) must not inherit the previous gate's half-typed feedback.
  useEffect(() => { setSelected(null); setInput(""); setEditing(null); setSummary(null); }, [gate.id]);

  async function act(action: PluginGateAction) {
    if (action.input === "text" && selected?.id !== action.id) {
      setSelected(action); // first click arms the textarea; the confirm button submits
      return;
    }
    const notes = lineNotes ?? [];
    const feedback = [input.trim(), ...notes].filter(Boolean).join("\n");
    if (action.input === "text" && !feedback) {
      showToast("This action needs text (e.g. what should change)", "error");
      return;
    }
    setResolving(true);
    try {
      const res = await apiPost<GateResolveResponse>(
        `/api/plugins/${pluginId}/loops/${encodeURIComponent(loopName)}/gate/resolve`,
        { projectId, gateId: gate.id, actionId: action.id, input: action.input === "text" ? feedback : undefined },
      );
      showToast(
        res.advance?.created.length
          ? `Decision applied — planned: ${res.advance.created.map((t) => `#${t.issueNumber ?? "?"}`).join(", ")}`
          : `Decision applied${res.advance?.note ? ` — ${res.advance.note}` : ""}`,
        "success",
      );
      onResolved();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Gate resolve failed", "error");
    } finally {
      setResolving(false);
    }
  }

  /** Draft-with-butler (#310): rough notes in the textarea → charter-aware feedback. */
  async function draftFeedback() {
    if (drafting) return;
    if (!input.trim()) {
      showToast("Type your rough thoughts first — the butler turns them into submit-ready feedback", "error");
      return;
    }
    setDrafting(true);
    try {
      const res = await apiPost<{ draft: string }>(
        `/api/plugins/${pluginId}/loops/${encodeURIComponent(loopName)}/gate/draft`,
        { projectId, gateId: gate.id, notes: input },
      );
      setInput(res.draft);
      showToast("Butler drafted the feedback — edit and confirm", "success");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Draft failed", "error");
    } finally {
      setDrafting(false);
    }
  }

  /** Summarize-for-me (#330): one click → decision-ready butler digest, rendered on the card. */
  async function summarize() {
    if (summarizing) return;
    setSummarizing(true);
    try {
      const res = await apiPost<{ summary: string }>(
        `/api/plugins/${pluginId}/loops/${encodeURIComponent(loopName)}/gate/summarize`,
        { projectId, gateId: gate.id },
      );
      setSummary(res.summary);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Summary failed", "error");
    } finally {
      setSummarizing(false);
    }
  }

  /** Edit-then-approve (#305): open an artifact editable in place. */
  async function openEditor(path: string) {
    setEditing({ path, content: "", loading: true, saving: false });
    try {
      const res = await apiFetch<{ exists: boolean; content: string | null; truncated: boolean }>(
        `/api/plugins/${pluginId}/loops/${encodeURIComponent(loopName)}/artifact?projectId=${projectId}&path=${encodeURIComponent(path)}`,
      );
      if (!res.exists || res.content === null) throw new Error("Artifact not found");
      if (res.truncated) throw new Error("Artifact too large to edit inline — edit it in the repo");
      setEditing({ path, content: res.content, loading: false, saving: false });
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to load artifact", "error");
      setEditing(null);
    }
  }

  async function saveEdit() {
    if (!editing || editing.saving) return;
    setEditing({ ...editing, saving: true });
    try {
      const res = await apiPut<{ path: string; committed: boolean }>(
        `/api/plugins/${pluginId}/loops/${encodeURIComponent(loopName)}/artifact`,
        { projectId, gateId: gate.id, path: editing.path, content: editing.content },
      );
      showToast(res.committed ? "Edit saved and committed — approve when ready" : "Edit saved (commit pending — index busy)", "success");
      setEditing(null);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Save failed", "error");
      setEditing({ ...editing, saving: false });
    }
  }

  const checkTone = {
    pass: "text-green-800 dark:text-green-300",
    warn: "text-amber-800 dark:text-amber-300",
    fail: "text-red-800 dark:text-red-300",
  } as const;

  return (
    <div
      className="rounded border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-4 space-y-3 max-w-2xl"
      data-testid="plugin-gate-card"
    >
      <div className="text-sm font-medium text-amber-900 dark:text-amber-200">
        ✋ {gate.question}
      </div>
      {/* Verification digest (#303) — verdict + detail readable on the card itself. */}
      {(checks?.length ?? 0) > 0 && (
        <div className="space-y-1" data-testid="plugin-gate-checks-digest">
          {checks!.map((check) => (
            <div key={check.name} className={`text-xs ${checkTone[check.verdict]}`}>
              <span className="font-medium">{check.verdict === "pass" ? "✓" : check.verdict === "warn" ? "⚠" : "✕"} {check.name}:</span>{" "}
              {check.detail ?? check.verdict.toUpperCase()}
            </div>
          ))}
        </div>
      )}
      {/* Butler recommendation chip (#309) — a pre-read, never a decision. */}
      {recommendation && (
        <div
          className="flex items-start gap-2 text-xs rounded border border-amber-200 dark:border-amber-800 bg-white/60 dark:bg-gray-900/40 px-2 py-1.5"
          data-testid="plugin-gate-recommendation"
        >
          <span aria-hidden="true">🤵</span>
          <span className="flex-1 text-amber-900 dark:text-amber-200">
            Butler recommends <span className="font-medium">{recommendation.actionId}</span>
            {recommendation.reason ? ` — ${recommendation.reason}` : ""}
          </span>
          <button
            onClick={() => {
              const action = gate.actions.find((a) => a.id === recommendation.actionId);
              if (action) void act(action);
            }}
            disabled={resolving}
            className="shrink-0 text-[11px] px-2 py-0.5 rounded border border-amber-400 dark:border-amber-600 hover:bg-amber-100 dark:hover:bg-amber-900/40 text-amber-900 dark:text-amber-200"
          >
            Accept
          </button>
        </div>
      )}
      {/* Summarize-for-me (#330) — butler digest rendered in place. */}
      {summary && (
        <div
          className="text-xs whitespace-pre-wrap rounded border border-amber-200 dark:border-amber-800 bg-white/60 dark:bg-gray-900/40 px-2.5 py-2 text-amber-900 dark:text-amber-200"
          data-testid="plugin-gate-summary"
        >
          {summary}
        </div>
      )}
      {(gate.artifacts?.length ?? 0) > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {gate.artifacts!.map((path) => (
            <span key={path} className="inline-flex items-stretch rounded border border-amber-300 dark:border-amber-700 overflow-hidden">
              <button
                type="button"
                onClick={() => onOpenArtifact(path)}
                className="text-[11px] font-mono px-2 py-0.5 text-amber-900 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-900/40"
                title="Open the artifact under review"
              >
                📄 {path.split("/").pop()}
              </button>
              <button
                type="button"
                onClick={() => void openEditor(path)}
                className="text-[11px] px-1.5 py-0.5 border-l border-amber-300 dark:border-amber-700 text-amber-900 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-900/40"
                title="Edit the artifact before approving (#305)"
                data-testid={`plugin-gate-edit-${path.split("/").pop()}`}
              >
                ✎
              </button>
            </span>
          ))}
        </div>
      )}
      {/* Edit-then-approve editor (#305). */}
      {editing && (
        <div className="space-y-2" data-testid="plugin-gate-editor">
          <div className="text-[11px] font-mono text-amber-900 dark:text-amber-200">{editing.path}</div>
          {editing.loading ? (
            <div className="text-xs text-gray-500">Loading…</div>
          ) : (
            <>
              <textarea
                value={editing.content}
                onChange={(e) => setEditing({ ...editing, content: e.target.value })}
                rows={14}
                className="w-full text-xs font-mono px-2 py-1.5 rounded border border-amber-300 dark:border-amber-700 bg-white dark:bg-gray-900"
              />
              <div className="flex items-center gap-2">
                <button
                  onClick={() => void saveEdit()}
                  disabled={editing.saving}
                  className="text-xs px-2.5 py-1 rounded bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50"
                >
                  {editing.saving ? "Saving…" : "Save & commit edit"}
                </button>
                <button
                  onClick={() => setEditing(null)}
                  className="text-xs px-2.5 py-1 rounded border border-amber-300 dark:border-amber-700 text-amber-900 dark:text-amber-200"
                >
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      )}
      {(lineNotes?.length ?? 0) > 0 && (
        <div className="text-[11px] text-amber-800 dark:text-amber-300" data-testid="plugin-gate-line-notes">
          {lineNotes!.length} line comment(s) from the diff will be attached to revision feedback.
        </div>
      )}
      {selected?.input === "text" && (
        <div className="space-y-1.5">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            rows={4}
            autoFocus
            placeholder={`${selected.label} — what should change? (rough notes are fine — the butler can polish them)`}
            className="w-full text-sm px-2 py-1.5 rounded border border-amber-300 dark:border-amber-700 bg-white dark:bg-gray-900"
            data-testid="plugin-gate-input"
          />
          <button
            onClick={() => void draftFeedback()}
            disabled={drafting}
            className="text-[11px] px-2 py-0.5 rounded border border-amber-300 dark:border-amber-700 text-amber-900 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-900/40 disabled:opacity-50"
            data-testid="plugin-gate-draft"
            title="Send your rough notes to the butler; it returns submit-ready feedback (#310)"
          >
            {drafting ? "Drafting…" : "✨ Draft with butler"}
          </button>
        </div>
      )}
      <div className="flex items-center gap-2">
        {gate.actions.map((action) => (
          <button
            key={action.id}
            onClick={() => void act(action)}
            disabled={resolving}
            className={`text-sm px-3 py-1.5 rounded disabled:opacity-50 ${
              action.input === "text"
                ? "border border-amber-400 dark:border-amber-600 text-amber-900 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-900/40"
                : "bg-brand-600 text-white hover:bg-brand-700"
            }`}
            data-testid={`plugin-gate-action-${action.id}`}
          >
            {resolving ? "Applying…" : selected?.id === action.id && action.input === "text" ? `Confirm: ${action.label}` : action.label}
          </button>
        ))}
        <button
          onClick={() => void summarize()}
          disabled={summarizing}
          className="text-sm px-3 py-1.5 rounded border border-amber-300 dark:border-amber-700 text-amber-900 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-900/40 disabled:opacity-50"
          data-testid="plugin-gate-summarize"
          title="Butler reads the artifacts and posts a decision-ready digest here (#330)"
        >
          {summarizing ? "Summarizing…" : "🤵 Summarize for me"}
        </button>
      </div>
    </div>
  );
}

// ── Artifact viewer (#288) ────────────────────────────────────────────

type ArtifactResponse = {
  path: string;
  exists: boolean;
  content: string | null;
  truncated: boolean;
  commits: Array<{ sha: string; date: string }>;
  diff: string | null;
};

export function ArtifactViewer({ pluginId, loopName, projectId, path, onClose, onLineNotesChange }: {
  pluginId: string;
  loopName: string;
  projectId: string;
  path: string;
  onClose: () => void;
  /**
   * Line-anchored review notes (#304): comments created on the version diff are
   * reported upward as "file:line: body" strings so the gate card can attach them
   * to revision feedback. Local-only — nothing is persisted server-side.
   */
  onLineNotesChange?: (notes: string[]) => void;
}) {
  const [artifact, setArtifact] = useState<ArtifactResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"rendered" | "raw" | "diff">("rendered");
  const [diffComments, setDiffComments] = useState<DiffComment[]>([]);

  function publishNotes(comments: DiffComment[]) {
    onLineNotesChange?.(comments
      .filter((c) => !c.resolvedAt)
      .map((c) => `${c.filePath}:${c.lineNumNew ?? c.lineNumOld ?? "?"}: ${c.body}`));
  }

  function handleCreateComment(data: CreateDiffCommentRequest) {
    const now = new Date().toISOString();
    const next: DiffComment[] = [...diffComments, {
      id: `local-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      workspaceId: "",
      filePath: data.filePath,
      lineNumOld: data.lineNumOld ?? null,
      lineNumNew: data.lineNumNew ?? null,
      side: data.side,
      body: data.body,
      resolvedAt: null,
      createdAt: now,
      updatedAt: now,
    }];
    setDiffComments(next);
    publishNotes(next);
  }

  function handleEditComment(commentId: string, body: string) {
    const next = diffComments.map((c) => (c.id === commentId ? { ...c, body, updatedAt: new Date().toISOString() } : c));
    setDiffComments(next);
    publishNotes(next);
  }

  function handleDeleteComment(commentId: string) {
    const next = diffComments.filter((c) => c.id !== commentId);
    setDiffComments(next);
    publishNotes(next);
  }

  function handleResolveComment(commentId: string, resolved: boolean) {
    const next = diffComments.map((c) => (c.id === commentId ? { ...c, resolvedAt: resolved ? new Date().toISOString() : null } : c));
    setDiffComments(next);
    publishNotes(next);
  }

  const diffStats = useMemo(() => {
    const diff = artifact?.diff ?? "";
    let insertions = 0;
    let deletions = 0;
    for (const line of diff.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) insertions++;
      else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
    }
    return { filesChanged: 1, insertions, deletions };
  }, [artifact?.diff]);

  useEffect(() => {
    let cancelled = false;
    setArtifact(null);
    setError(null);
    setTab("rendered");
    apiFetch<ArtifactResponse>(
      `/api/plugins/${pluginId}/loops/${encodeURIComponent(loopName)}/artifact?projectId=${projectId}&path=${encodeURIComponent(path)}`,
    )
      .then((res) => { if (!cancelled) setArtifact(res); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [pluginId, loopName, projectId, path]);

  const isMarkdown = /\.(md|markdown)$/i.test(path);
  return (
    <div
      className="rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 flex flex-col max-h-[60vh]"
      data-testid="plugin-artifact-viewer"
    >
      <div className="flex items-center gap-2 border-b border-gray-100 dark:border-gray-800 px-3 py-2">
        <span className="text-xs font-mono text-gray-600 dark:text-gray-300 truncate flex-1" title={path}>{path}</span>
        {artifact?.exists && (
          <div className="flex items-center gap-1 text-[11px]">
            {(["rendered", "raw"] as const).filter((t) => t !== "rendered" || isMarkdown).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-2 py-0.5 rounded ${tab === t ? "bg-brand-600 text-white" : "text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"}`}
              >
                {t === "rendered" ? "Rendered" : "Raw"}
              </button>
            ))}
            {artifact.diff && (
              <button
                onClick={() => setTab("diff")}
                className={`px-2 py-0.5 rounded ${tab === "diff" ? "bg-brand-600 text-white" : "text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"}`}
                title="Diff between the artifact's last two committed versions"
              >
                Diff v-1→v
              </button>
            )}
          </div>
        )}
        <button
          onClick={onClose}
          className="text-xs px-2 py-0.5 rounded text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"
          aria-label="Close artifact"
        >
          ✕
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto p-3">
        {error && <div className="text-xs text-red-600 dark:text-red-400">{error}</div>}
        {!artifact && !error && <div className="text-xs text-gray-500 dark:text-gray-400">Loading…</div>}
        {artifact && !artifact.exists && (
          <div className="text-xs text-gray-500 dark:text-gray-400">
            Not produced yet — the file will appear once its step has run.
          </div>
        )}
        {artifact?.exists && artifact.content !== null && (
          tab === "diff" && artifact.diff ? (
            // Full diff surface (#304): syntax highlight + INLINE COMMENTS. Comments stay
            // local; the gate card attaches them to revision feedback as "file:line: note".
            <DiffViewer
              diff={artifact.diff}
              stats={diffStats}
              comments={diffComments}
              onCreateComment={handleCreateComment}
              onEditComment={handleEditComment}
              onDeleteComment={handleDeleteComment}
              onResolveComment={handleResolveComment}
            />
          ) : tab === "rendered" && isMarkdown ? (
            <div className="prose prose-sm dark:prose-invert max-w-none">
              <ReactMarkdown>{artifact.content}</ReactMarkdown>
            </div>
          ) : (
            <pre className="text-[11px] whitespace-pre-wrap break-all text-gray-700 dark:text-gray-300">{artifact.content}</pre>
          )
        )}
        {artifact?.truncated && (
          <div className="mt-2 text-[11px] text-amber-700 dark:text-amber-400">Truncated — the full file is in the repo.</div>
        )}
      </div>
    </div>
  );
}

// ── Timeline + cost (#292, #294) ─────────────────────────────────────

type LoopEventsResponse = {
  events: Array<{ id: string; type: string; payload: Record<string, unknown> | null; createdAt: string }>;
  cost: { totalUsd: number; byUnit: Array<{ unitId: string; costUsd: number; sessions: number }> };
};

function eventSummary(event: LoopEventsResponse["events"][number]): string {
  const p = event.payload ?? {};
  switch (event.type) {
    case "advance": {
      const created = Array.isArray(p.created) ? p.created.length : 0;
      const note = typeof p.note === "string" && p.note ? ` — ${p.note}` : "";
      return created > 0 ? `Advanced: ${created} ticket(s) created${note}` : `Advanced: nothing planned${note}`;
    }
    case "gate-reached":
      return `Reached gate: ${typeof p.question === "string" ? p.question : String(p.gateId ?? "")}`;
    case "gate-resolved": {
      const input = typeof p.input === "string" && p.input ? ` — "${p.input.slice(0, 120)}"` : "";
      return `Decision: ${String(p.actionLabel ?? p.actionId ?? "?")}${input}`;
    }
    case "paused": return "Paused by a human";
    case "resumed": return "Resumed";
    case "converged": return "Converged — nothing left to do";
    default: return event.type;
  }
}

const EVENT_MARK: Record<string, string> = {
  "advance": "▸",
  "gate-reached": "✋",
  "gate-resolved": "✔",
  "paused": "⏸",
  "resumed": "▶",
  "converged": "★",
};

export function LoopTimeline({ pluginId, loopName, projectId, refreshKey }: {
  pluginId: string;
  loopName: string;
  projectId: string;
  /** Bump to refetch (e.g. after an advance or gate decision). */
  refreshKey: number;
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<LoopEventsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    apiFetch<LoopEventsResponse>(
      `/api/plugins/${pluginId}/loops/${encodeURIComponent(loopName)}/events?projectId=${projectId}&limit=50`,
    )
      .then((res) => { if (!cancelled) { setData(res); setError(null); } })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [open, pluginId, loopName, projectId, refreshKey]);

  return (
    <div className="border-t border-gray-100 dark:border-gray-800 pt-3" data-testid="plugin-loop-timeline">
      <button
        onClick={() => setOpen((o) => !o)}
        className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200"
      >
        {open ? "▾" : "▸"} History & cost
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          {error && <div className="text-xs text-red-600 dark:text-red-400">{error}</div>}
          {!data && !error && <div className="text-xs text-gray-400">Loading…</div>}
          {data && (
            <>
              {(data.cost.totalUsd > 0 || data.cost.byUnit.length > 0) && (
                <div className="text-xs text-gray-600 dark:text-gray-300">
                  Total agent cost: <span className="font-medium">${data.cost.totalUsd.toFixed(2)}</span>
                  {data.cost.byUnit.length > 0 && (
                    <span className="text-gray-400 dark:text-gray-500">
                      {" "}({data.cost.byUnit.slice(0, 5).map((u) => `${u.unitId}: $${u.costUsd.toFixed(2)}`).join(" · ")})
                    </span>
                  )}
                </div>
              )}
              <ul className="space-y-1">
                {data.events.map((event) => (
                  <li key={event.id} className="text-[11px] text-gray-600 dark:text-gray-300 flex items-baseline gap-1.5">
                    <span className="text-gray-400 dark:text-gray-500 w-3 shrink-0" aria-hidden="true">{EVENT_MARK[event.type] ?? "·"}</span>
                    <span className="flex-1">{eventSummary(event)}</span>
                    <span className="text-gray-400 dark:text-gray-500 shrink-0">{formatRelativeTime(event.createdAt)}</span>
                  </li>
                ))}
                {data.events.length === 0 && <li className="text-[11px] text-gray-400">No history yet.</li>}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}

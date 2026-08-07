import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import { apiFetch, apiPost } from "../lib/api.js";
import { showToast } from "./Toast.js";
import { formatRelativeTime } from "../lib/formatRelativeTime.js";

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
  };
  startPolicy: StartPolicy;
}) {
  const chips: Array<{ text: string; tone: "gray" | "amber" | "green" | "blue" | "red" }> = [];
  if (loop.paused) chips.push({ text: "Paused", tone: "amber" });
  if (loop.openTickets > 0) chips.push({ text: "Round running", tone: "blue" });
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

// ── Approval gate card (#286) ─────────────────────────────────────────

type GateResolveResponse = {
  gateId: string;
  actionId: string;
  resolve: { code: number | null; stdout: string; stderr: string; timedOut: boolean };
  advance: { note: string | null; created: Array<{ issueNumber: number | null; title: string }> } | null;
};

export function GateCard({ pluginId, loopName, projectId, gate, onResolved, onOpenArtifact }: {
  pluginId: string;
  loopName: string;
  projectId: string;
  gate: PluginGate;
  onResolved: () => void;
  onOpenArtifact: (path: string) => void;
}) {
  const [selected, setSelected] = useState<PluginGateAction | null>(null);
  const [input, setInput] = useState("");
  const [resolving, setResolving] = useState(false);

  // A fresh gate (new id) must not inherit the previous gate's half-typed feedback.
  useEffect(() => { setSelected(null); setInput(""); }, [gate.id]);

  async function act(action: PluginGateAction) {
    if (action.input === "text" && selected?.id !== action.id) {
      setSelected(action); // first click arms the textarea; the confirm button submits
      return;
    }
    if (action.input === "text" && !input.trim()) {
      showToast("This action needs text (e.g. what should change)", "error");
      return;
    }
    setResolving(true);
    try {
      const res = await apiPost<GateResolveResponse>(
        `/api/plugins/${pluginId}/loops/${encodeURIComponent(loopName)}/gate/resolve`,
        { projectId, gateId: gate.id, actionId: action.id, input: action.input === "text" ? input : undefined },
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

  return (
    <div
      className="rounded border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-4 space-y-3 max-w-2xl"
      data-testid="plugin-gate-card"
    >
      <div className="text-sm font-medium text-amber-900 dark:text-amber-200">
        ✋ {gate.question}
      </div>
      {(gate.artifacts?.length ?? 0) > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {gate.artifacts!.map((path) => (
            <button
              key={path}
              type="button"
              onClick={() => onOpenArtifact(path)}
              className="text-[11px] font-mono px-2 py-0.5 rounded border border-amber-300 dark:border-amber-700 text-amber-900 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-900/40"
              title="Open the artifact under review"
            >
              📄 {path.split("/").pop()}
            </button>
          ))}
        </div>
      )}
      {selected?.input === "text" && (
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows={4}
          autoFocus
          placeholder={`${selected.label} — what should change?`}
          className="w-full text-sm px-2 py-1.5 rounded border border-amber-300 dark:border-amber-700 bg-white dark:bg-gray-900"
          data-testid="plugin-gate-input"
        />
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

export function ArtifactViewer({ pluginId, loopName, projectId, path, onClose }: {
  pluginId: string;
  loopName: string;
  projectId: string;
  path: string;
  onClose: () => void;
}) {
  const [artifact, setArtifact] = useState<ArtifactResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"rendered" | "raw" | "diff">("rendered");

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
            <pre className="text-[11px] whitespace-pre-wrap break-all text-gray-700 dark:text-gray-300">{artifact.diff}</pre>
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

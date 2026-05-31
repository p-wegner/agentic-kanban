import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { IssueArtifact, IssueWithStatus } from "@agentic-kanban/shared";
import { apiFetch } from "../lib/api.js";
import { showToast } from "./Toast.js";
import { AgentQuestionsPanel } from "./AgentQuestionsPanel.js";

type WorkspaceInfo = NonNullable<NonNullable<IssueWithStatus["workspaceSummary"]>["main"]>;

interface NextTransition {
  toNodeId: string;
  toNodeName: string;
  label: string | null;
  condition: string;
  verdict?: "fire" | "block" | "manual";
}

interface Progress {
  currentNodeId: string | null;
  nextTransitions: NextTransition[];
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "activity";
  text: string;
}

type ButlerEvent =
  | { type: "ready" }
  | { type: "session"; sessionId: string }
  | { type: "turn-start" }
  | { type: "user"; text: string }
  | { type: "text"; text: string }
  | { type: "tool"; name: string }
  | { type: "result"; text?: string; isError?: boolean }
  | { type: "error"; message: string };

const SPEC_PHASES = new Set(["specify", "design", "tasks"]);

function phaseKey(phaseName: string): string {
  return phaseName.trim().toLowerCase();
}

export function isSpecPlanningPhase(phaseName?: string | null): boolean {
  return !!phaseName && SPEC_PHASES.has(phaseKey(phaseName));
}

function artifactCaption(phaseName: string): string {
  return `phase-artifact:${phaseKey(phaseName)}`;
}

function artifactTitle(phaseName: string): string {
  if (phaseKey(phaseName) === "tasks") return "tasks.md";
  if (phaseKey(phaseName) === "design") return "design.md";
  return "spec.md";
}

function assistantSeed(issue: IssueWithStatus, phaseName: string, artifact: string): string {
  return [
    `We are refining the ${phaseName} artifact for #${issue.issueNumber ?? "?"} ${issue.title}.`,
    "Before suggesting changes, load the project constitution from CLAUDE.md and honor its Scope Constraints.",
    "Any rewritten artifact must include a short Constitution Alignment section that cites CLAUDE.md.",
    "Keep the phase gate human-controlled. Do not advance the workflow.",
    "When you suggest artifact changes, return concise markdown the user can apply.",
    "",
    "Current artifact:",
    artifact.trim() || "(empty)",
  ].join("\n");
}

function ChatBubble({ message }: { message: ChatMessage }) {
  if (message.role === "activity") {
    return (
      <div className="flex justify-center">
        <span className="rounded-full bg-gray-100 dark:bg-gray-800 px-2 py-0.5 text-[11px] text-gray-500 dark:text-gray-400">
          {message.text}
        </span>
      </div>
    );
  }
  const isUser = message.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${
          isUser
            ? "rounded-tr-md bg-brand-600 text-white"
            : "rounded-tl-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-200"
        }`}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap break-words">{message.text}</p>
        ) : (
          <div className="prose prose-sm dark:prose-invert max-w-none prose-p:my-1 prose-pre:my-1 prose-headings:mt-2 prose-headings:mb-1">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.text}</ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}

export function SpecPhasePanel({
  issue,
  workspace,
  onApproved,
}: {
  issue: IssueWithStatus;
  workspace: WorkspaceInfo;
  onApproved?: () => void;
}) {
  const phaseName = workspace.workflow?.currentNodeName ?? "";
  const caption = useMemo(() => artifactCaption(phaseName), [phaseName]);
  const [artifactId, setArtifactId] = useState<string | null>(null);
  const [artifactText, setArtifactText] = useState("");
  const [savedText, setSavedText] = useState("");
  const [loadingArtifact, setLoadingArtifact] = useState(true);
  const [savingArtifact, setSavingArtifact] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [transitioning, setTransitioning] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [sending, setSending] = useState(false);
  const assistantBufRef = useRef("");
  const assistantIdRef = useRef<string | null>(null);
  const phaseStreamRef = useRef<EventSource | null>(null);

  const loadArtifact = useCallback(async () => {
    setLoadingArtifact(true);
    try {
      const artifacts = await apiFetch<IssueArtifact[]>(`/api/issues/${issue.id}/artifacts`);
      const match = artifacts
        .filter((a) => a.type === "text" && a.caption === caption)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      const fallback = `# ${artifactTitle(phaseName)}\n\n`;
      setArtifactId(match?.id ?? null);
      setArtifactText(match?.content ?? fallback);
      setSavedText(match?.content ?? fallback);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to load phase artifact", "error");
    } finally {
      setLoadingArtifact(false);
    }
  }, [caption, issue.id, phaseName]);

  const loadProgress = useCallback(async () => {
    try {
      const data = await apiFetch<Progress>(`/api/workflows/workspaces/${workspace.id}/progress`);
      setProgress(data);
    } catch {
      setProgress(null);
    }
  }, [workspace.id]);

  useEffect(() => {
    void loadArtifact();
    void loadProgress();
  }, [loadArtifact, loadProgress]);

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws/board/${issue.projectId}`);
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "board_changed" && (msg.reason === "workflow_transition" || msg.reason === "issue_updated")) {
          void loadProgress();
          void loadArtifact();
        }
      } catch {
        // ignore malformed board events
      }
    };
    return () => {
      ws.onclose = null;
      ws.close();
    };
  }, [issue.projectId, loadArtifact, loadProgress]);

  useEffect(() => {
    return () => {
      phaseStreamRef.current?.close();
      phaseStreamRef.current = null;
    };
  }, []);

  function appendAssistantText(text: string) {
    assistantBufRef.current += text;
    const id = assistantIdRef.current ?? `assistant-${Date.now()}`;
    assistantIdRef.current = id;
    const nextText = assistantBufRef.current;
    setChatMessages((prev) => {
      const existing = prev.findIndex((m) => m.id === id);
      if (existing >= 0) {
        const next = [...prev];
        next[existing] = { ...next[existing], text: nextText };
        return next;
      }
      return [...prev, { id, role: "assistant", text: nextText }];
    });
  }

  function handleButlerEvent(event: ButlerEvent) {
    if (event.type === "text") appendAssistantText(event.text);
    if (event.type === "tool") {
      assistantBufRef.current = "";
      assistantIdRef.current = null;
      setChatMessages((prev) => [...prev, { id: `activity-${Date.now()}`, role: "activity", text: event.name.replace(/^mcp__[^_]+__/, "").replace(/_/g, " ") }]);
    }
    if (event.type === "result") {
      setSending(false);
      assistantBufRef.current = "";
      assistantIdRef.current = null;
      phaseStreamRef.current?.close();
      phaseStreamRef.current = null;
      if (event.isError && event.text) {
        setChatMessages((prev) => [...prev, { id: `error-${Date.now()}`, role: "activity", text: `Error: ${event.text}` }]);
      }
    }
    if (event.type === "error") {
      setSending(false);
      assistantBufRef.current = "";
      assistantIdRef.current = null;
      phaseStreamRef.current?.close();
      phaseStreamRef.current = null;
      setChatMessages((prev) => [...prev, { id: `error-${Date.now()}`, role: "activity", text: `Error: ${event.message}` }]);
    }
  }

  async function saveArtifact(): Promise<boolean> {
    if (savingArtifact) return false;
    setSavingArtifact(true);
    try {
      if (artifactId) {
        await apiFetch(`/api/issues/${issue.id}/artifacts/${artifactId}`, { method: "DELETE" });
      }
      const result = await apiFetch<{ id: string }>(`/api/issues/${issue.id}/artifacts`, {
        method: "POST",
        body: JSON.stringify({
          type: "text",
          mimeType: "text/markdown",
          content: artifactText,
          caption,
          workspaceId: workspace.id,
        }),
      });
      setArtifactId(result.id);
      setSavedText(artifactText);
      showToast("Phase artifact saved", "success");
      return true;
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to save artifact", "error");
      return false;
    } finally {
      setSavingArtifact(false);
    }
  }

  async function sendChat() {
    const content = chatInput.trim();
    if (!content || sending) return;
    setSending(true);
    setChatInput("");
    setChatMessages((prev) => [...prev, { id: `user-${Date.now()}`, role: "user", text: content }]);
    try {
      phaseStreamRef.current?.close();
      const es = new EventSource(`/api/projects/${issue.projectId}/butler/stream`);
      phaseStreamRef.current = es;
      es.onmessage = (ev) => handleButlerEvent(JSON.parse(ev.data) as ButlerEvent);
      es.onerror = () => {
        es.close();
        if (phaseStreamRef.current === es) phaseStreamRef.current = null;
      };
      const prompt = `${assistantSeed(issue, phaseName, artifactText)}\n\nUser request:\n${content}`;
      await apiFetch(`/api/projects/${issue.projectId}/butler/message`, {
        method: "POST",
        body: JSON.stringify({ content: prompt }),
      });
      setTimeout(() => {
        if (phaseStreamRef.current === es) {
          es.close();
          phaseStreamRef.current = null;
          setSending(false);
        }
      }, 180_000);
    } catch (err) {
      phaseStreamRef.current?.close();
      phaseStreamRef.current = null;
      setSending(false);
      showToast(err instanceof Error ? err.message : "Failed to message phase butler", "error");
    }
  }

  async function approve() {
    const next = progress?.nextTransitions.find((t) => t.verdict !== "block") ?? progress?.nextTransitions[0];
    if (!next || transitioning) return;
    if (!artifactId || artifactText !== savedText) {
      const saved = await saveArtifact();
      if (!saved) return;
    }
    setTransitioning(true);
    try {
      await apiFetch(`/api/workflows/workspaces/${workspace.id}/transition`, {
        method: "POST",
        body: JSON.stringify({
          toNodeId: next.toNodeId,
          summary: `Approved ${phaseName} artifact and continued to ${next.toNodeName}`,
        }),
      });
      showToast(`Approved ${phaseName} and continued to ${next.toNodeName}`, "success");
      onApproved?.();
      void loadProgress();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to approve phase", "error");
    } finally {
      setTransitioning(false);
    }
  }

  const nextTransition = progress?.nextTransitions.find((t) => t.verdict !== "block") ?? progress?.nextTransitions[0] ?? null;
  const dirty = artifactText !== savedText;

  return (
    <section className="mt-3 rounded-md border border-blue-200 dark:border-blue-800 bg-blue-50/40 dark:bg-blue-950/20" data-testid="spec-phase-panel">
      <div className="border-b border-blue-100 dark:border-blue-900 px-3 py-2">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-blue-700 dark:text-blue-300">
              {phaseName} planning
            </h4>
            <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
              Artifact: {artifactTitle(phaseName)}
            </p>
            <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
              Constitution: repo-root CLAUDE.md, including Scope Constraints
            </p>
          </div>
          <button
            type="button"
            onClick={() => void approve()}
            disabled={!nextTransition || transitioning || loadingArtifact}
            className="shrink-0 rounded bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50"
            title={nextTransition ? `Approve and continue to ${nextTransition.toNodeName}` : "No next phase available"}
          >
            {transitioning ? "Approving..." : `Approve & continue${nextTransition ? ` to ${nextTransition.toNodeName}` : ""}`}
          </button>
        </div>
      </div>

      <div className="grid gap-3 p-3 lg:grid-cols-[minmax(0,1.15fr)_minmax(280px,0.85fr)]">
        <div className="min-w-0">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-xs font-medium text-gray-700 dark:text-gray-300">Draft artifact</span>
            <div className="flex items-center gap-2">
              {dirty && <span className="text-[11px] text-amber-600 dark:text-amber-400">Unsaved edits</span>}
              <button
                type="button"
                onClick={() => void saveArtifact()}
                disabled={savingArtifact || loadingArtifact || !dirty}
                className="rounded border border-blue-300 dark:border-blue-700 px-2 py-1 text-xs text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/40 disabled:opacity-50"
              >
                {savingArtifact ? "Saving..." : "Save artifact"}
              </button>
            </div>
          </div>
          <textarea
            value={artifactText}
            onChange={(e) => setArtifactText(e.target.value)}
            disabled={loadingArtifact}
            rows={18}
            className="w-full resize-y rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 px-3 py-2 font-mono text-xs text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-60"
          />
        </div>

        <div className="min-w-0 space-y-3">
          <AgentQuestionsPanel
            projectId={issue.projectId}
            issueId={issue.id}
            workspaceId={workspace.id}
            title="Clarifying questions"
          />
          <div className="rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-950">
            <div className="border-b border-gray-100 dark:border-gray-800 px-3 py-2">
              <span className="text-xs font-medium text-gray-700 dark:text-gray-300">Refinement chat</span>
            </div>
            <div className="max-h-80 space-y-2 overflow-y-auto px-3 py-3">
              {chatMessages.length === 0 ? (
                <p className="py-6 text-center text-xs text-gray-400 dark:text-gray-500">
                  Ask for a rewrite, risks, missing requirements, or a tighter task breakdown.
                </p>
              ) : (
                chatMessages.map((message) => <ChatBubble key={message.id} message={message} />)
              )}
              {sending && (
                <div className="flex justify-start">
                  <div className="rounded-2xl rounded-tl-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-xs text-gray-500 dark:text-gray-400">
                    Streaming...
                  </div>
                </div>
              )}
            </div>
            <div className="border-t border-gray-100 dark:border-gray-800 p-2">
              <div className="flex items-end gap-2">
                <textarea
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void sendChat();
                    }
                  }}
                  rows={2}
                  disabled={sending}
                  placeholder={`Refine the ${phaseName} artifact...`}
                  className="min-h-[42px] flex-1 resize-y rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-60"
                />
                <button
                  type="button"
                  onClick={() => void sendChat()}
                  disabled={sending || !chatInput.trim()}
                  className="rounded bg-brand-600 px-3 py-2 text-sm text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Send
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

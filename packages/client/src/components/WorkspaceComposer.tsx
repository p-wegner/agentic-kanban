import React, { useEffect, useRef, useState } from "react";
import TicketMentionInput from "./TicketMentionInput.js";
import { WorkspaceActionButton } from "./WorkspaceActionButton.js";
import { composerState } from "../lib/workspaceComposer.js";

/**
 * The workspace message composer (#970) — one control for every session state.
 *
 * `WorkspaceCard` used to carry two near-identical hand-rolled `flex` blocks
 * (a running footer and an idle input) that each decided inline what to render.
 * They disagreed, and between them produced the ticket's three complaints:
 * an input that was disabled — and so unusable — the entire time the agent was
 * working, a Ctrl+Enter that stopped the agent instead of sending, and a Stop
 * button that swapped into the send slot so the buttons appeared to move.
 *
 * Presentation only: every decision comes from `lib/workspaceComposer.ts`, and
 * the layout fixes the alignment by giving the textarea and the button column a
 * shared `items-stretch` row instead of pinning single-height buttons with
 * `self-end`.
 */
export interface WorkspaceComposerProps {
  wsId: string;
  prompt: string;
  setPrompt: (value: string) => void;
  inputRef?: React.Ref<HTMLTextAreaElement>;
  isSessionAlive: boolean;
  isWaitingForInput: boolean;
  actionLoading: boolean;
  /** Deliver `prompt` to a live, waiting session. */
  onSendTurn: (wsId: string) => void;
  /** Start (or resume) a session carrying `prompt`. */
  onLaunch: (wsId: string) => void;
  /** Stop the running agent. Absent when stopping is not offered. */
  onStop?: (wsId: string) => void;
}

export function WorkspaceComposer({
  wsId,
  prompt,
  setPrompt,
  inputRef,
  isSessionAlive,
  isWaitingForInput,
  actionLoading,
  onSendTurn,
  onLaunch,
  onStop,
}: WorkspaceComposerProps) {
  // A draft armed while the agent was working, flushed on the working →
  // awaiting-input edge. In-memory by design: the server has no turn queue and
  // refuses a mid-turn send (409), so there is nowhere durable to put it.
  const [queued, setQueued] = useState(false);
  const queuedRef = useRef(false);
  queuedRef.current = queued;

  const c = composerState({ isSessionAlive, isWaitingForInput, actionLoading, prompt, queued });

  // Flush the queued draft the moment the agent asks for input.
  useEffect(() => {
    if (!queuedRef.current) return;
    if (!isSessionAlive || !isWaitingForInput) return;
    if (!prompt.trim()) {
      setQueued(false);
      return;
    }
    setQueued(false);
    onSendTurn(wsId);
  }, [isSessionAlive, isWaitingForInput, prompt, wsId, onSendTurn]);

  // A session that ended without ever asking for input drops the arming, so a
  // stale "Queued" badge cannot outlive the turn it belonged to.
  useEffect(() => {
    if (!isSessionAlive && queuedRef.current) setQueued(false);
  }, [isSessionAlive]);

  function runPrimary() {
    if (!c.primaryEnabled) return;
    if (c.action === "queue") {
      setQueued(true);
      return;
    }
    if (c.action === "send-turn") onSendTurn(wsId);
    else onLaunch(wsId);
  }

  const showStop = c.showStop && !!onStop;

  return (
    <div className="space-y-1">
      {/* items-stretch, not self-end: the buttons share the textarea's height so
          nothing sits half a row out of line (the "misaligned" complaint). */}
      <div className="flex items-stretch gap-2">
        <TicketMentionInput
          inputRef={inputRef}
          value={prompt}
          onChange={setPrompt}
          onKeyDown={(e) => {
            if (e.key === "Enter" && e.ctrlKey) {
              e.preventDefault();
              // Ctrl+Enter is submit, and only ever submit. It used to call
              // stop while a turn was running.
              runPrimary();
            }
          }}
          placeholder={c.placeholder}
          rows={2}
          data-testid="workspace-composer-input"
          className="flex-1 text-sm bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 border border-gray-300 dark:border-gray-600 rounded-md px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500 resize-none"
        />
        {/* Stop keeps its own slot on the far right so the primary button never
            moves as the session changes state. */}
        <div className="flex flex-col gap-2 shrink-0">
          <WorkspaceActionButton
            intent="primary"
            className="flex-1"
            onClick={runPrimary}
            disabled={!c.primaryEnabled}
            data-testid="workspace-composer-primary"
            title={c.action === "queue" ? "Hold this message and send it when the current turn ends (Ctrl+Enter)" : "Send (Ctrl+Enter)"}
          >
            {c.primaryLabel}
          </WorkspaceActionButton>
          {showStop && (
            <WorkspaceActionButton
              intent="danger"
              className="flex-1"
              onClick={() => onStop?.(wsId)}
              disabled={actionLoading}
              data-testid="workspace-composer-stop"
              title="Stop the running agent"
            >
              Stop
            </WorkspaceActionButton>
          )}
        </div>
      </div>
      {c.hint && (
        <p className="text-[11px] text-gray-500 dark:text-gray-400">{c.hint}</p>
      )}
    </div>
  );
}

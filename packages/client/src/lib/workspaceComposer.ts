/**
 * The workspace message composer's state machine — the pure core behind
 * `components/WorkspaceComposer.tsx` (#970).
 *
 * The interaction area used to be two hand-rolled `<div className="flex gap-2">`
 * blocks inside `WorkspaceCard`, each deciding inline which button to render and
 * whether to disable the textarea. That produced the three defects the ticket
 * names:
 *
 *  1. **The input was never usable while the agent worked.** The running footer
 *     hard-`disabled` the textarea whenever a session was alive and not already
 *     waiting for input — which is the overwhelming majority of the time an
 *     agent is running. You could not type a follow-up, so the box was, in
 *     practice, permanently dead. It is now always typable: you compose while
 *     the agent works and the draft is held until the turn ends.
 *
 *     Deliberately CLIENT-side and in-memory. `POST /api/workspaces/:id/turn`
 *     refuses a mid-turn send with 409 ("Agent is still processing the previous
 *     turn") and the server keeps no queue, so a draft cannot be handed over
 *     early. Holding it in the composer and sending on the `working →
 *     awaiting-input` edge is the honest version of that: the draft survives
 *     the turn, but not a page reload, and the UI says so rather than implying
 *     durable delivery.
 *  2. **Ctrl+Enter was bound to a destructive action.** In that same state the
 *     send shortcut called `handleStop`, so the muscle-memory "submit" chord
 *     killed the agent instead of sending anything.
 *  3. **The buttons were misaligned.** `self-end` pinned a single-height button
 *     against a two-row textarea, and Stop swapped in and out of the send slot,
 *     so the control moved horizontally as the session changed state.
 *
 * Modelling this as one function of the session state removes the ambiguity: a
 * composer is always in exactly one `mode`, every mode says what the primary
 * button does, and Stop is a SEPARATE control that appears beside the primary
 * one rather than replacing it.
 */

/** What the composer knows about the session it is attached to. */
export interface ComposerSessionState {
  /** A session process exists and has not exited. */
  isSessionAlive: boolean;
  /** The agent has finished its turn and is waiting on the user. */
  isWaitingForInput: boolean;
  /** Any workspace-level action (merge, review, …) is in flight. */
  actionLoading: boolean;
  /** Current textarea contents. */
  prompt: string;
  /** A deferred send is armed and waiting for the turn to end. */
  queued?: boolean;
}

export type ComposerMode =
  /** A turn is in progress; typing queues a follow-up for when it ends. */
  | "working"
  /** The agent finished its turn and is waiting for the next message. */
  | "awaiting-input"
  /** No live session; sending resumes the prior conversation. */
  | "idle";

/**
 * The single action the primary (right-hand) button performs.
 *
 * `queue` does not reach the server: it arms the deferred send described above,
 * which fires as `send-turn` once the agent asks for input.
 */
export type ComposerAction = "send-turn" | "launch" | "queue";

export interface ComposerState {
  mode: ComposerMode;
  /** What the primary button does when clicked / Ctrl+Enter is pressed. */
  action: ComposerAction;
  /** Label for the primary button. */
  primaryLabel: string;
  /** Textarea placeholder. */
  placeholder: string;
  /**
   * Whether the textarea accepts typing. Always true — see (1) above. Kept as
   * an explicit field so the guarantee is asserted by a test rather than
   * implied by the absence of a `disabled` prop at the call site.
   */
  inputEnabled: boolean;
  /** Whether the primary button is clickable. */
  primaryEnabled: boolean;
  /** Whether a separate Stop button is offered beside the primary one. */
  showStop: boolean;
  /**
   * Hint rendered under the box while a turn is running, so it is obvious that
   * what you type is queued rather than dropped.
   */
  hint: string | null;
}

/**
 * Derive the whole composer presentation from the session state.
 *
 * Note the deliberate asymmetry: `showStop` is independent of the primary
 * action. Stop is destructive and must never occupy the slot the eye and the
 * keyboard treat as "submit" — that swap is what made Ctrl+Enter kill agents.
 */
export function composerState(s: ComposerSessionState): ComposerState {
  const hasText = s.prompt.trim().length > 0;

  if (s.isSessionAlive && !s.isWaitingForInput) {
    // A turn is running. The box stays live so a follow-up can be composed and
    // queued; it is delivered as a normal turn the moment the agent asks for
    // input.
    return {
      mode: "working",
      action: "queue",
      primaryLabel: s.queued ? "Queued" : "Queue",
      placeholder: "Queue a follow-up — sent when the agent finishes…",
      inputEnabled: true,
      // Once armed, re-clicking would be a no-op: the draft is already held.
      primaryEnabled: !s.actionLoading && hasText && !s.queued,
      showStop: true,
      hint: s.queued
        ? "Queued — this message is sent as soon as the current turn ends."
        : "Agent is working. You can compose now and queue it for the end of this turn.",
    };
  }

  if (s.isWaitingForInput) {
    return {
      mode: "awaiting-input",
      action: "send-turn",
      primaryLabel: "Send",
      placeholder: "Message agent…",
      inputEnabled: true,
      primaryEnabled: !s.actionLoading && hasText,
      // A live session that is merely waiting can still be stopped.
      showStop: s.isSessionAlive,
      hint: null,
    };
  }

  return {
    mode: "idle",
    action: "launch",
    primaryLabel: "Send",
    placeholder: "Message agent…",
    inputEnabled: true,
    primaryEnabled: !s.actionLoading && hasText,
    showStop: false,
    hint: null,
  };
}

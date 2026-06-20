// Pure classification of a butler SDK-loop failure into a recovery outcome.
// Extracted from butler-sdk.service.runLoop's catch cascade so the precedence
// (abort > transient > resume-reset > fatal) is a single directly-testable
// decision, separate from the side-effecting recovery the service performs.

export type ButlerLoopErrorOutcome =
  /** Deliberate teardown (clear-context / profile switch / stop) — swallow silently. */
  | "aborted"
  /** Anthropic socket blip / hot-reload — log and let the next ensure reopen. */
  | "transient"
  /** Resume id unusable (gone, or unverifiable thinking signature) — drop resume, retry fresh. */
  | "resume-reset"
  /** Genuine error — surface to the user. */
  | "fatal";

export function classifyButlerLoopError(input: {
  /** session.abort.signal.aborted */
  aborted: boolean;
  /** isTransientNetworkError(err) */
  transient: boolean;
  /** the loop was started with a resume id */
  hasResume: boolean;
  /** isStaleResumeError(message) */
  staleResume: boolean;
  /** isInvalidThinkingSignatureError(message) */
  invalidThinkingSignature: boolean;
}): ButlerLoopErrorOutcome {
  if (input.aborted) return "aborted";
  if (input.transient) return "transient";
  if (input.hasResume && (input.staleResume || input.invalidThinkingSignature)) return "resume-reset";
  return "fatal";
}

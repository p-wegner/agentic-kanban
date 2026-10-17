/**
 * A one-shot builder that ends its turn while "waiting" on background work (#1557).
 *
 * #1553's builder finished with "the snapshot regeneration and the time-zone checks are still
 * running in the background. I'm waiting for the monitor to report", exit 0, no commit. A session
 * is one turn: background work dies with it, so nothing was ever going to report and the ticket
 * stalled until an operator resumed it. That is partial work with no commit, so the board sends
 * the builder a follow-up turn (the same channel as the implement-exit feedback turn) instead of
 * leaving the card idle. Bounded: after the cap the exit is left alone for the monitor / operator.
 */
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { readSessionStdoutFileTailAsync } from "../../lib/session-output-reader.js";
import { parseLastAgentMessage } from "../../services/session-message-parser.js";

export const BACKGROUND_WAIT_MAX_FOLLOW_UPS = 2;

/** Phrases by which a final message admits it is waiting on work that will not outlive the turn. */
export const BACKGROUND_WAIT_PATTERNS: readonly RegExp[] = [
  /\b(?:still|currently)\s+(?:running|executing|in\s+progress|regenerating|processing)\b[^.\n]{0,60}\bbackground\b/i,
  /\b(?:running|executing|processing)\s+in\s+the\s+background\b/i,
  /\bin\s+the\s+background\b[^.\n]{0,80}\b(?:still|waiting|running|pending)\b/i,
  /\b(?:i['’]?m|i\s+am|now|am)\s+(?:still\s+)?waiting\s+(?:for|on)\s+(?:the\s+)?(?:monitor|background|task|job|notification|results?|checks?)\b/i,
  /\bwaiting\s+(?:for|on)\s+the\s+(?:monitor|background\s+(?:task|job|process|work)s?)\b/i,
  /\bwill\s+(?:report|notify|ping)\s+(?:me\s+)?when\s+(?:it|they|the\s+\w+)\s+(?:finish|complete|is\s+done|are\s+done)/i,
];

/** Pure: the matching excerpt when `finalMessage` says it is waiting on background work, else null. */
export function findBackgroundWaitPhrase(finalMessage: string | null | undefined): string | null {
  if (!finalMessage) return null;
  for (const pattern of BACKGROUND_WAIT_PATTERNS) {
    const m = pattern.exec(finalMessage);
    if (m) return finalMessage.slice(Math.max(0, m.index - 20), m.index + m[0].length + 20).replace(/\s+/g, " ").trim();
  }
  return null;
}

export function buildBackgroundWaitFollowUpPrompt(input: { phrase: string; attempt: number; cap: number }): string {
  return [
    `Your last turn ended while waiting on background work ("${input.phrase}") and made no commit.`,
    "",
    "This session is one-shot: when you end a turn the session ends, and anything running in the background dies with it. Nothing will report back to you.",
    "Run what you need in the FOREGROUND now (blocking, with an adequate timeout), then commit your work and end your turn.",
    "If part of it cannot finish, commit what is done and name what remains in your summary.",
    `This is follow-up turn ${input.attempt} of ${input.cap}.`,
  ].join("\n");
}

const followUps = new Map<string, number>();

export function resetBackgroundWaitFollowUps(workspaceId: string): void {
  followUps.delete(workspaceId);
}

export interface BackgroundWaitExitDeps {
  sendBuilderTurn?: (workspaceId: string, content: string) => Promise<unknown>;
  readFinalMessage?: (sessionId: string) => Promise<string | null>;
  cap?: number;
}

async function readFinalAgentMessage(sessionId: string): Promise<string | null> {
  const tail = await readSessionStdoutFileTailAsync(sessionId);
  return tail ? parseLastAgentMessage(tail.split("\n"), 2000) : null;
}

/**
 * For a builder exit with no new commit: true when the board sent a follow-up turn (the caller
 * stops its exit handling), false when the exit is not a background wait or the cap is spent.
 */
export async function followUpOnBackgroundWait(
  deps: BackgroundWaitExitDeps,
  input: { workspaceId: string; sessionId: string },
): Promise<boolean> {
  if (!deps.sendBuilderTurn) return false;
  const cap = deps.cap ?? BACKGROUND_WAIT_MAX_FOLLOW_UPS;
  const sent = followUps.get(input.workspaceId) ?? 0;
  if (sent >= cap) return false;
  const phrase = findBackgroundWaitPhrase(await (deps.readFinalMessage ?? readFinalAgentMessage)(input.sessionId).catch(() => null));
  if (!phrase) return false;
  const attempt = sent + 1;
  followUps.set(input.workspaceId, attempt);
  try {
    await deps.sendBuilderTurn(input.workspaceId, buildBackgroundWaitFollowUpPrompt({ phrase, attempt, cap }));
    console.log(`[background-wait] workspace ${input.workspaceId}: session ${input.sessionId} ended waiting on background work with no commit; sent follow-up turn ${attempt}/${cap} (#1557)`);
    return true;
  } catch (err) {
    console.warn(`[background-wait] workspace ${input.workspaceId}: follow-up turn could not be delivered: ${errorMessage(err)}`);
    return false;
  }
}

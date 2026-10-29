// Worker side of the bearer-token rotation handshake (#1766).
//
// The board expires a worker token ~30 days after issue. The worker asks for a fresh one over its
// authenticated socket (`token_rotate_request` -> `token_rotate`) once the old one is within
// ROTATE_BEFORE_EXPIRY_MS of expiry, or at once when it has no recorded expiry (a pre-#1766
// pairing). The answer is persisted to the state file BEFORE the in-memory identity is swapped.
import { randomUUID } from "node:crypto";
import type { WorkerToBoardMessage } from "@agentic-kanban/shared/lib/worker-protocol";
import { saveIdentity, type WorkerIdentity } from "./worker-state.js";

export const ROTATE_BEFORE_EXPIRY_MS = 15 * 24 * 60 * 60 * 1000;

export function tokenNeedsRotation(identity: Pick<WorkerIdentity, "tokenExpiresAt">, nowMs: number = Date.now()): boolean {
  if (!identity.tokenExpiresAt) return true;
  const exp = Date.parse(identity.tokenExpiresAt);
  return !Number.isFinite(exp) || exp - nowMs <= ROTATE_BEFORE_EXPIRY_MS;
}

export function createTokenRotator(a: {
  getIdentity: () => WorkerIdentity;
  setIdentity: (next: WorkerIdentity) => void;
  stateFile: string;
  boardUrl: () => string;
  urls: () => string[];
  send: (m: WorkerToBoardMessage) => void;
  log: (line: string) => void;
}) {
  let pending: string | null = null;
  return {
    /** Ask for a new token when one is due and no request is in flight. */
    maybeRotate(nowMs: number = Date.now()): void {
      if (pending || !tokenNeedsRotation(a.getIdentity(), nowMs)) return;
      pending = randomUUID();
      a.send({ type: "token_rotate_request", requestId: pending });
    },
    /** Returns true when the frame was a rotation answer (consumed). */
    handle(message: { type: string; requestId?: string; workerToken?: string; tokenExpiresAt?: string; error?: string }): boolean {
      if (message.type !== "token_rotate") return false;
      if (message.requestId !== pending) return true;
      pending = null;
      if (!message.workerToken) {
        a.log(`[worker] token rotation refused: ${message.error ?? "no token"}`);
        return true;
      }
      const next: WorkerIdentity = { ...a.getIdentity(), workerToken: message.workerToken, ...(message.tokenExpiresAt ? { tokenExpiresAt: message.tokenExpiresAt } : {}) };
      saveIdentity(a.stateFile, a.boardUrl(), next, a.urls());
      a.setIdentity(next);
      a.log(`[worker] rotated bearer token (expires ${message.tokenExpiresAt ?? "?"})`);
      return true;
    },
    /** A dropped socket loses any in-flight request. */
    reset(): void { pending = null; },
  };
}

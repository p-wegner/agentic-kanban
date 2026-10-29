// Board->worker frame authentication (#1756).
//
// The `assign` frame carries a board-authored setupScript, so on a plaintext listener anyone who can
// inject a frame runs code on the worker. Every board->worker frame therefore carries
// `auth: { seq, mac }`: an HMAC-SHA256 over `${seq}.${payload}` keyed by a key derived from the
// worker's bearer token (the board stores only sha256(token), and derives the same key from that).
// `auth` is an extra JSON field, which an older worker's parser simply ignores, so signing needs no
// protocol-shape change; the daemon decides whether to REQUIRE it.
//
// `seq` is `max(previous + 1, Date.now())`: strictly increasing per worker across reconnects and
// board restarts, and doubling as a timestamp so a captured frame cannot be replayed after a worker
// restart once it is older than {@link FRAME_MAX_AGE_MS}. LIMIT: the token also travels in the
// WebSocket upgrade header, so an on-path observer of that header can derive the key. This stops
// blind injection and replay, not a sniffer that captured the pairing handshake; TLS is the control
// for that adversary.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

// Local (not ./bearer-token) so the worker binary graph gains one file, not two (worker-cli-isolation).
const sha256Hex = (v: string): string => createHash("sha256").update(v).digest("hex");

export const FRAME_MAX_AGE_MS = 15 * 60 * 1000;

/** The signing key, from the stored token digest (board) or the raw token (worker) — same value. */
export function frameKeyFromTokenHash(tokenHash: string): string {
  return sha256Hex(`fleet-frame-v1:${tokenHash}`);
}

export function frameKeyFromToken(token: string): string {
  return frameKeyFromTokenHash(sha256Hex(token));
}

function mac(key: string, seq: number, payload: string): string {
  return createHmac("sha256", key).update(`${seq}.${payload}`).digest("hex");
}

/** Board side: serialise `message` with its `auth` field. */
export function signFrame(key: string, message: object, seq: number): string {
  const payload = JSON.stringify(message);
  return JSON.stringify({ ...(JSON.parse(payload) as object), auth: { seq, mac: mac(key, seq, payload) } });
}

export type FrameVerdict = { ok: true; seq: number } | { ok: false; reason: "unsigned" | "bad-mac" | "replay" | "stale" };

/** Worker side: check a raw frame. `lastSeq` is the highest seq already accepted. */
export function verifyFrame(key: string, raw: string, lastSeq: number, nowMs = Date.now()): FrameVerdict {
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(raw) as Record<string, unknown>; } catch { return { ok: false, reason: "unsigned" }; }
  const auth = parsed?.auth as { seq?: unknown; mac?: unknown } | undefined;
  if (!auth || typeof auth.seq !== "number" || !Number.isFinite(auth.seq) || typeof auth.mac !== "string") return { ok: false, reason: "unsigned" };
  const { auth: _auth, ...rest } = parsed;
  const expected = Buffer.from(mac(key, auth.seq, JSON.stringify(rest)), "hex");
  const got = Buffer.from(auth.mac, "hex");
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return { ok: false, reason: "bad-mac" };
  if (auth.seq <= lastSeq) return { ok: false, reason: "replay" };
  if (nowMs - auth.seq > FRAME_MAX_AGE_MS) return { ok: false, reason: "stale" };
  return { ok: true, seq: auth.seq };
}

// --- worker-side gate (kept out of `startWorkerDaemon`: function-nloc ratchet) ---

/**
 * Once a signed frame has been seen (or `requireSigned` is set) an unsigned/invalid/replayed frame
 * is refused, so an injected assign (setupScript = code execution) cannot run. An old board never
 * signs, so until then unsigned frames are accepted (deliberate compatibility window).
 */
export function createFrameGate(workerToken: string, requireSigned: boolean | undefined, log: (line: string) => void): (raw: string) => boolean {
  const key = frameKeyFromToken(workerToken);
  let lastSeq = 0;
  let signedSeen = false;
  return (raw) => {
    const verdict = verifyFrame(key, raw, lastSeq);
    if (verdict.ok) { lastSeq = verdict.seq; signedSeen = true; return true; }
    if (requireSigned || signedSeen || verdict.reason !== "unsigned") {
      log(`[worker] REFUSED board frame: ${verdict.reason} (signing ${signedSeen || requireSigned ? "required" : "optional"})`);
      return false;
    }
    return true;
  };
}

// One-time connect codes for the agent-readable connect URL (#1442).
//
// A code is bound to ONE pairing token, expires after a short TTL (15 min by default, and never
// outlives the token it carries), may be fetched only a few times, and dies on the first
// successful pairing or when the operator revokes it. It lives in memory on purpose: a board
// restart should invalidate every outstanding code, exactly as it already does for pairing tokens
// (`createExpiringDigestStore`). The code itself is never logged — only `redactConnectCode`.
import { randomBytes } from "node:crypto";
import type { ConnectRunbookOptions } from "../lib/worker-connect-runbook.js";

export const CONNECT_CODE_TTL_MS = 15 * 60 * 1000;
export const CONNECT_CODE_MAX_FETCHES = 5;
/** Progress reports are accepted this long after the code stops serving the page (install + doctor take time). */
export const CONNECT_PROGRESS_GRACE_MS = 60 * 60 * 1000;
const MAX_PROGRESS_ENTRIES = 100;
const MAX_OUTPUT_CHARS = 400;

export type ConnectCodeStatus = "active" | "used" | "revoked" | "expired" | "fetch-limit";

export interface ConnectProgressEntry {
  step: string;
  status: "ok" | "failed";
  output: string;
  at: string;
}

interface ConnectCodeRecord {
  code: string;
  pairingToken: string;
  fleetUrl: string;
  options: ConnectRunbookOptions;
  createdAtMs: number;
  expiresAtMs: number;
  fetches: number;
  paired: boolean;
  revoked: boolean;
  progress: ConnectProgressEntry[];
}

export interface ConnectCodeView {
  /** Prefix only — enough to tell codes apart in the view without re-exposing the secret. */
  codeHint: string;
  status: ConnectCodeStatus;
  expiresAt: string;
  fetches: number;
  maxFetches: number;
  progress: ConnectProgressEntry[];
}

export type ResolveResult =
  | { ok: true; code: string; pairingToken: string; fleetUrl: string; options: ConnectRunbookOptions }
  | { ok: false; reason: Exclude<ConnectCodeStatus, "active"> | "unknown" };

export const CONNECT_GONE_MESSAGE: Record<Exclude<ConnectCodeStatus, "active"> | "unknown", string> = {
  expired: "This connect code has expired. Ask the operator to mint a new one in the board's Connect view.",
  used: "This connect code was already used to pair a worker. Ask the operator to mint a new one in the board's Connect view.",
  revoked: "This connect code was revoked by the operator. Ask them to mint a new one in the board's Connect view.",
  "fetch-limit": "This connect code was fetched too many times. Ask the operator to mint a new one in the board's Connect view.",
  unknown: "This connect code is not valid (never issued, or the board restarted). Ask the operator to mint a new one in the board's Connect view.",
};

export function redactConnectCode(code: string): string {
  return `${code.slice(0, 4)}…`;
}

export function createConnectCodeStore(defaults: { ttlMs?: number; maxFetches?: number } = {}) {
  const records = new Map<string, ConnectCodeRecord>();
  const defaultTtl = defaults.ttlMs ?? CONNECT_CODE_TTL_MS;
  const maxFetches = defaults.maxFetches ?? CONNECT_CODE_MAX_FETCHES;

  const statusOf = (r: ConnectCodeRecord, nowMs: number): ConnectCodeStatus => {
    if (r.revoked) return "revoked";
    if (r.paired) return "used";
    if (nowMs >= r.expiresAtMs) return "expired";
    if (r.fetches >= maxFetches) return "fetch-limit";
    return "active";
  };

  function prune(nowMs: number): void {
    for (const [code, r] of records) {
      if (nowMs >= r.expiresAtMs + CONNECT_PROGRESS_GRACE_MS) records.delete(code);
    }
  }

  function mint(input: {
    pairingToken: string;
    /** The pairing token's own expiry — a code must not outlive it. */
    tokenExpiresAtMs?: number;
    fleetUrl: string;
    options: ConnectRunbookOptions;
    ttlMs?: number;
    nowMs?: number;
  }): { code: string; expiresAt: string } {
    const nowMs = input.nowMs ?? Date.now();
    prune(nowMs);
    const code = randomBytes(24).toString("base64url");
    let expiresAtMs = nowMs + (input.ttlMs ?? defaultTtl);
    if (input.tokenExpiresAtMs !== undefined) expiresAtMs = Math.min(expiresAtMs, input.tokenExpiresAtMs);
    records.set(code, {
      code,
      pairingToken: input.pairingToken,
      fleetUrl: input.fleetUrl,
      options: input.options,
      createdAtMs: nowMs,
      expiresAtMs,
      fetches: 0,
      paired: false,
      revoked: false,
      progress: [],
    });
    return { code, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  /** Serve the page: counts one fetch. Everything but "active" is a 410. */
  function consumeFetch(code: string, nowMs: number = Date.now()): ResolveResult {
    const r = records.get(code);
    if (!r) return { ok: false, reason: "unknown" };
    const status = statusOf(r, nowMs);
    if (status !== "active") return { ok: false, reason: status };
    r.fetches += 1;
    return { ok: true, code, pairingToken: r.pairingToken, fleetUrl: r.fleetUrl, options: r.options };
  }

  /** Read-only peek (for the owner's "Copy as Markdown" parity) — does not count a fetch. */
  function peek(code: string, nowMs: number = Date.now()): ResolveResult {
    const r = records.get(code);
    if (!r) return { ok: false, reason: "unknown" };
    const status = statusOf(r, nowMs);
    if (status !== "active") return { ok: false, reason: status };
    return { ok: true, code, pairingToken: r.pairingToken, fleetUrl: r.fleetUrl, options: r.options };
  }

  /** The pairing token was used: the page stops serving. Returns whether a code was bound to it. */
  function markPaired(pairingToken: string): boolean {
    let any = false;
    for (const r of records.values()) {
      if (r.pairingToken === pairingToken && !r.paired) {
        r.paired = true;
        r.progress.push({ step: "paired", status: "ok", output: "worker paired with the board", at: new Date().toISOString() });
        any = true;
      }
    }
    return any;
  }

  function revoke(code: string): boolean {
    const r = records.get(code);
    if (!r) return false;
    r.revoked = true;
    return true;
  }

  /** Accepted until revoked, and for a grace period after expiry. Returns false for an unknown/closed code. */
  function recordProgress(
    code: string,
    entry: { step: string; status: "ok" | "failed"; output?: string },
    nowMs: number = Date.now(),
  ): boolean {
    const r = records.get(code);
    if (!r || r.revoked || nowMs >= r.expiresAtMs + CONNECT_PROGRESS_GRACE_MS) return false;
    if (r.progress.length >= MAX_PROGRESS_ENTRIES) r.progress.shift();
    r.progress.push({
      step: entry.step.slice(0, 64),
      status: entry.status,
      output: (entry.output ?? "").slice(0, MAX_OUTPUT_CHARS),
      at: new Date(nowMs).toISOString(),
    });
    return true;
  }

  function view(code: string, nowMs: number = Date.now()): ConnectCodeView | null {
    const r = records.get(code);
    if (!r) return null;
    return {
      codeHint: redactConnectCode(r.code),
      status: statusOf(r, nowMs),
      expiresAt: new Date(r.expiresAtMs).toISOString(),
      fetches: r.fetches,
      maxFetches,
      progress: [...r.progress],
    };
  }

  return { mint, consumeFetch, peek, markPaired, revoke, recordProgress, view, maxFetches };
}

export type ConnectCodeStore = ReturnType<typeof createConnectCodeStore>;

let singleton: ConnectCodeStore | null = null;
/** Process-wide store: the owner (loopback) routes and the fleet-listener routes must see the same codes. */
export function getConnectCodeStore(): ConnectCodeStore {
  singleton ??= createConnectCodeStore();
  return singleton;
}

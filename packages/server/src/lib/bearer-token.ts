/**
 * The primitives the board's three bearer-authed listeners share (#556).
 *
 * The fleet control plane, the git transport and the MCP HTTP bridge each grew their own
 * copy: `/^Bearer\s+(.+)$/i` parsed in three places, `randomBytes(32).toString("hex")` minted
 * in four, `sha256Hex` declared twice, and two digest-keyed expiring stores that behaved
 * differently — `createGitTokenStore` pruned on every issue, while the worker registry's
 * `pendingPairings` map only ever deleted the entry it consumed, so an unclaimed pairing token
 * sat in memory until the process exited.
 *
 * Deliberately NOT a shared auth middleware: each listener decides for itself what a token
 * authorises, and the "board API is never mounted on the fleet or git port" invariant (decision
 * 012) depends on those staying separate servers. These are the primitives underneath, nothing more.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** 256 bits of entropy, hex — the board's one token shape. */
export function mintToken(): string {
  return randomBytes(32).toString("hex");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Constant-time compare of two hex digests of equal length. */
export function digestsEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

export interface ExtractBearerOptions {
  /**
   * Also accept HTTP Basic, for git: it sends `http://x-token:<token>@host`, so the token
   * rides in the PASSWORD slot — and only there (#753).
   *
   * It used to be accepted in the username slot too, on the reasoning that someone who
   * pasted it the wrong way round should get a working clone instead of an unexplainable
   * 401. That trades a legible error for a credential in the worst possible place: a
   * username is the half of a URL that gets echoed into prompts, `git remote -v` output,
   * proxy access logs and error messages, while the password half is what every tool in
   * that chain knows to redact. A 401 is recoverable; a token in a log is not.
   */
  allowBasic?: boolean;
}

/** The token out of an `Authorization` header value, or null. Never throws on malformed input. */
export function extractBearer(header: string | string[] | undefined | null, opts: ExtractBearerOptions = {}): string | null {
  if (!header || Array.isArray(header)) return null;
  const trimmed = header.trim();
  const bearer = /^Bearer\s+(.+)$/i.exec(trimmed);
  if (bearer) return bearer[1]!;
  if (!opts.allowBasic) return null;
  const basic = /^Basic\s+(.+)$/i.exec(trimmed);
  if (!basic) return null;
  try {
    const decoded = Buffer.from(basic[1]!, "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    // Password slot ONLY (#753). No colon at all means there is no password slot, so
    // there is no token here — not "treat the whole thing as the token".
    if (idx < 0) return null;
    return decoded.slice(idx + 1) || null;
  } catch {
    return null;
  }
}

export interface ExpiringDigestStore<Scope> {
  /** Mint a token, store `scope` under its digest, and return the token. The plaintext is never kept. */
  issue(scope: Scope, opts?: { ttlMs?: number; now?: number }): string;
  /** The scope for a token, or null when unknown or expired. An expired hit is deleted on the way out. */
  resolve(token: string, nowMs?: number): Scope | null;
  /** Delete a token's entry (single-use tokens consume this way). Returns whether one existed. */
  consume(token: string, nowMs?: number): Scope | null;
  /** Drop every expired entry. Called on each issue, so a store nobody reads still cannot grow forever. */
  prune(nowMs?: number): number;
  /** Drop every entry whose scope matches — e.g. every token belonging to a revoked worker. */
  revokeWhere(predicate: (scope: Scope) => boolean): number;
  /** Entry count, expired ones included. For tests and diagnostics. */
  size(): number;
}

/**
 * A digest-keyed store of scopes with a TTL. Tokens are looked up BY DIGEST, so there is no
 * per-candidate comparison to leak timing, and a memory dump does not yield usable tokens.
 */
export function createExpiringDigestStore<Scope>(opts: { ttlMs: number }): ExpiringDigestStore<Scope> {
  const entries = new Map<string, { scope: Scope; expiresAtMs: number }>();

  function prune(nowMs = Date.now()): number {
    let removed = 0;
    for (const [hash, entry] of entries) {
      if (entry.expiresAtMs <= nowMs) {
        entries.delete(hash);
        removed += 1;
      }
    }
    return removed;
  }

  return {
    issue(scope, issueOpts = {}) {
      const nowMs = issueOpts.now ?? Date.now();
      prune(nowMs);
      const token = mintToken();
      entries.set(sha256Hex(token), { scope, expiresAtMs: nowMs + (issueOpts.ttlMs ?? opts.ttlMs) });
      return token;
    },
    resolve(token, nowMs = Date.now()) {
      const hash = sha256Hex(token);
      const entry = entries.get(hash);
      if (!entry) return null;
      if (entry.expiresAtMs <= nowMs) {
        entries.delete(hash);
        return null;
      }
      return entry.scope;
    },
    consume(token, nowMs = Date.now()) {
      const hash = sha256Hex(token);
      const entry = entries.get(hash);
      if (!entry) return null;
      entries.delete(hash);
      return entry.expiresAtMs <= nowMs ? null : entry.scope;
    },
    prune,
    revokeWhere(predicate) {
      let removed = 0;
      for (const [hash, entry] of entries) {
        if (predicate(entry.scope)) {
          entries.delete(hash);
          removed += 1;
        }
      }
      return removed;
    },
    size: () => entries.size,
  };
}

export interface EnvPortOptions<T extends number | null> {
  /** Returned when the variable is absent or empty — the two listeners differ here on purpose (0 = OS-assigned, null = disabled). */
  fallback: T;
  /** Prefix for the warning on an invalid value, e.g. "[git-http]". */
  logPrefix: string;
  /** What the warning says happens instead, e.g. "using an OS-assigned port". */
  onInvalid: string;
}

/**
 * A port from an env var. Invalid values warn and fall back rather than crashing the board on
 * a typo: a cross-machine deployment must pin these ports through a firewall rule, and losing
 * the whole board to a mistyped one is a worse outcome than losing the listener.
 */
export function envPort<T extends number | null>(name: string, opts: EnvPortOptions<T>, env: NodeJS.ProcessEnv = process.env): number | T {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return opts.fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    console.warn(`${opts.logPrefix} ignoring invalid ${name}=${raw}; ${opts.onInvalid}`);
    return opts.fallback;
  }
  return parsed;
}

/**
 * The shared "which interface" decision for both plaintext fleet listeners (#753).
 *
 * One function because one policy: an explicit host is used as given, an absent host means
 * LOOPBACK, and every-interface has to be asked for by name via `KANBAN_FLEET_INSECURE=1`.
 * The two listeners keep separate host variables (they can legitimately sit on different
 * interfaces) but must not drift on what "unset" means.
 *
 * Why the default changed: everything on both listeners is plaintext HTTP — the assignment
 * token rides an `Authorization: Basic` header, the pack data and the board-authored setup
 * script are in clear — so binding every interface by default published a
 * credential-bearing channel onto whatever networks the machine happens to be on (office
 * LAN, home LAN, hotel wifi) as a side effect of pinning a port. Opening it wider is a
 * decision, so it is now said out loud.
 */
export function resolveListenHost(opts: {
  raw: string | undefined;
  insecure: string | undefined;
  logPrefix: string;
}): string {
  const raw = opts.raw?.trim();
  if (raw) return raw;
  if (opts.insecure?.trim() === "1") {
    console.warn(
      `${opts.logPrefix} KANBAN_FLEET_INSECURE=1: binding 0.0.0.0 with no host restriction. ` +
        "This is a plaintext, bearer-authed listener — every interface of this machine now carries it.",
    );
    return "0.0.0.0";
  }
  console.warn(
    `${opts.logPrefix} binding 127.0.0.1: this listener is plaintext and no interface was named. ` +
      "For a cross-machine fleet name it explicitly (e.g. the tailnet address) — " +
      "or set KANBAN_FLEET_INSECURE=1 to accept every interface. See docs/worker-fleet.md section 6.",
  );
  return "127.0.0.1";
}

// The receive-pack stream guards for the fleet's git transport (#246, #753).
//
// Two separate jobs, both on the way IN to `git receive-pack`:
//
//  1. REF SCOPE (#246). The command section of a push names the refs it wants to
//     update. A worker's token is issued for exactly ONE incoming ref, so any other
//     refname — `refs/heads/*` above all, since those are checked out in board-side
//     worktrees — must be refused before git sees it.
//
//  2. RESOURCE LIMITS (#753). The parser buffers the command section until the flush
//     packet, and it had no cap of any kind: no byte limit, no line limit, and an empty
//     refname passed the scope check outright (the test was `refname && ...`, which skips
//     it). An authenticated client could therefore stream gigabytes of never-completing
//     pkt-lines and OOM the board process — which takes every worktree agent on the
//     machine with it. A guard that asks politely is not a guard, so the caps below are
//     enforced by destroying the stream, and they sit deliberately far below anything a
//     real push produces: a command section is one pkt-line per ref, ~110 bytes each.
//
// Extracted from git-http.service.ts so the transport module stays about transport and
// these limits are testable without a listener.

import { Transform } from "node:stream";

export const KANBAN_INCOMING_REF_PREFIX = "refs/kanban/incoming/";

/**
 * Hard cap on the buffered receive-pack COMMAND section.
 *
 * A real one is a handful of pkt-lines: two 40-char shas, a refname, and the capability
 * list on the first line — well under 1 KiB for a single-ref push, which is the only kind
 * this transport permits. 64 KiB is ~600x that and still a bound.
 */
export const MAX_COMMAND_SECTION_BYTES = 64 * 1024;

/** Hard cap on command lines before the flush packet. One is expected; 64 is generous. */
export const MAX_COMMAND_LINES = 64;

/**
 * Hard cap on a single RPC body, counted AFTER gzip decompression so a compression bomb
 * is bounded by the same number. 1 GiB is far above any repo this board serves and far
 * below anything that threatens the host.
 *
 * Env-overridable because "far above any repo" is a claim about the operator's repos, not
 * ours — a monorepo with large binary history can legitimately need more, and the operator
 * who raises it is the one who knows.
 */
export const DEFAULT_MAX_RPC_BODY_BYTES = 1024 * 1024 * 1024;

export function resolveMaxRpcBodyBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.KANBAN_GIT_MAX_BODY_BYTES;
  if (raw === undefined || raw.trim() === "") return DEFAULT_MAX_RPC_BODY_BYTES;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.warn(
      `[git-http] ignoring invalid KANBAN_GIT_MAX_BODY_BYTES=${raw}; using ${DEFAULT_MAX_RPC_BODY_BYTES} bytes`,
    );
    return DEFAULT_MAX_RPC_BODY_BYTES;
  }
  return parsed;
}

/**
 * Strict pkt-line length: exactly four LOWERCASE hex digits, and never 1..3
 * (those are shorter than the header itself and would desync the offset).
 * `Number.parseInt(hex, 16)` was too permissive — it accepts `"+000"`, `" 000"`
 * and `"-000"` as 0 (a fake flush that would end the command section early) and
 * `"0abz"` as 10. Git's own parser rejects such streams first, so no bypass was
 * demonstrated, but a guard must not depend on the thing it guards.
 */
export function parsePktLineLength(lenHex: string): number | null {
  if (!/^[0-9a-f]{4}$/.test(lenHex)) return null;
  const len = Number.parseInt(lenHex, 16);
  if (len >= 1 && len <= 3) return null;
  return len;
}

/** Why a receive-pack stream was destroyed. Distinguished so the log names the real cause. */
export type ReceiveViolation =
  | { kind: "refname"; refname: string }
  | { kind: "malformed"; detail: string }
  | { kind: "limit"; detail: string };

/**
 * A Transform that parses the receive-pack COMMAND section (pkt-lines of
 * `<old-sha> <new-sha> <refname>[NUL caps]` up to the `0000` flush) and destroys the
 * stream if any refname is outside `refs/kanban/incoming/`, outside the ONE ref this
 * token was issued for, empty, or if the section exceeds the caps above. After the
 * flush it becomes a passthrough for the packfile.
 */
export function createReceiveGuard(
  allowedRef: string | undefined,
  onViolation: (violation: ReceiveViolation) => void,
): Transform {
  let buffered: Buffer = Buffer.alloc(0);
  let commandsDone = false;
  let lines = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, callback) {
      if (commandsDone) {
        callback(null, chunk);
        return;
      }
      buffered = Buffer.concat([buffered, chunk]);
      // Checked BEFORE parsing, because the unbounded growth being fixed here happens
      // exactly when nothing in the buffer ever parses as a complete pkt-line.
      if (buffered.length > MAX_COMMAND_SECTION_BYTES) {
        const detail = `command section exceeded ${MAX_COMMAND_SECTION_BYTES} bytes without a flush packet`;
        onViolation({ kind: "limit", detail });
        buffered = Buffer.alloc(0);
        callback(new Error(detail));
        return;
      }
      let offset = 0;
      while (offset + 4 <= buffered.length) {
        const lenHex = buffered.subarray(offset, offset + 4).toString("latin1");
        const len = parsePktLineLength(lenHex);
        if (len === null) {
          onViolation({ kind: "malformed", detail: `pkt-line length ${JSON.stringify(lenHex)}` });
          callback(new Error("malformed receive-pack stream"));
          return;
        }
        if (len === 0) {
          // Flush-pkt: command section over; release everything and pass through.
          commandsDone = true;
          const out = buffered;
          buffered = Buffer.alloc(0);
          callback(null, out);
          return;
        }
        if (offset + len > buffered.length) break; // incomplete pkt — wait for more
        lines += 1;
        if (lines > MAX_COMMAND_LINES) {
          const detail = `more than ${MAX_COMMAND_LINES} command lines in one push`;
          onViolation({ kind: "limit", detail });
          callback(new Error(detail));
          return;
        }
        const line = buffered.subarray(offset + 4, offset + len).toString("utf8");
        const refname = (line.split("\0")[0] ?? "").trim().split(/\s+/)[2] ?? "";
        // An EMPTY refname used to pass: the check was `refname && (...)`, so a command
        // line whose third field was missing skipped the scope test entirely and reached
        // git. It is malformed input to a guard, so it is refused rather than forwarded.
        if (!refname || !refname.startsWith(KANBAN_INCOMING_REF_PREFIX) || refname !== allowedRef) {
          onViolation({ kind: "refname", refname });
          callback(new Error(`push to ${refname || "<empty refname>"} refused`));
          return;
        }
        offset += len;
      }
      callback(); // hold buffered bytes until the section completes
    },
    flush(callback) {
      callback(null, buffered.length > 0 ? buffered : undefined);
    },
  });
}

/**
 * A passthrough that destroys the stream once more than `maxBytes` have flowed through it.
 *
 * Sits AFTER the gunzip, so the number bounds decompressed bytes — the guard above bounds
 * what the board BUFFERS, this bounds what it will accept at all, and the two together are
 * what keep an authenticated push from being a resource-exhaustion primitive.
 */
export function createBodyLimit(maxBytes: number, onExceeded: (seen: number) => void): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, callback) {
      seen += chunk.length;
      if (seen > maxBytes) {
        onExceeded(seen);
        callback(new Error(`request body exceeded ${maxBytes} bytes`));
        return;
      }
      callback(null, chunk);
    },
  });
}

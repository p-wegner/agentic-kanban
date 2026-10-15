// #1504 — what promote records about the just-started stable board when /health never answers.
// Pure helpers (no I/O beyond what is injected) so the formatting and the timeout policy are testable.

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import os from "node:os";

export const BASE_BOOT_TIMEOUT_MS = 180_000;
export const EXTENDED_BOOT_TIMEOUT_MS = 360_000;
/** Below this much free RAM a slow boot is expected (paging), so the boot gets the longer budget. */
export const LOW_FREE_RAM_BYTES = 2 * 1024 ** 3;

/** Boot budget: the longer one when the host is short on free RAM at the time we start waiting. */
export function chooseBootTimeoutMs(freeBytes, floorBytes = LOW_FREE_RAM_BYTES) {
  return typeof freeBytes === "number" && freeBytes < floorBytes ? EXTENDED_BOOT_TIMEOUT_MS : BASE_BOOT_TIMEOUT_MS;
}

const gib = (n) => (n / 1024 ** 3).toFixed(2);

export function hostMemory({ totalmem = os.totalmem, freemem = os.freemem } = {}) {
  return { totalBytes: totalmem(), freeBytes: freemem() };
}

/** Last `maxBytes` of `path` written at or after byte `fromOffset` (the board log is shared and appended). */
export function readLogTail(path, fromOffset = 0, maxBytes = 4096) {
  let fd;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const start = Math.max(fromOffset, size - maxBytes, 0);
    const len = size - start;
    if (len <= 0) return "";
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
    return buf.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** True when `pid` is a live process (signal 0 probe). */
export function isPidAlive(pid, kill = process.kill.bind(process)) {
  if (!pid) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}

/**
 * Multi-line report: alive/exited (+code/signal), elapsed, host memory, and the child's own output
 * since it was spawned. `logTail === ""` is stated outright — silence is itself the finding.
 */
export function formatBootDiagnostics({ pid, alive, exit, elapsedMs, memory, timeoutMs, logTail, extra }) {
  const state = alive
    ? "ALIVE (never answered /health)"
    : exit
      ? `EXITED (code ${exit.code ?? "null"}, signal ${exit.signal ?? "none"})`
      : "NOT RUNNING (exit status unknown)";
  const lines = [
    `child pid ${pid ?? "?"}: ${state}`,
    `waited ${Math.round(elapsedMs / 1000)}s of a ${Math.round(timeoutMs / 1000)}s boot budget`,
    `host RAM: ${gib(memory.freeBytes)} GiB free of ${gib(memory.totalBytes)} GiB`,
  ];
  if (extra) lines.push(extra);
  const tail = (logTail ?? "").trimEnd();
  lines.push(tail ? `child output since spawn (tail):\n${tail}` : "child output since spawn: NOTHING (no 'Server starting' line — it never got that far, or is blocked before logging)");
  return lines.join("\n");
}

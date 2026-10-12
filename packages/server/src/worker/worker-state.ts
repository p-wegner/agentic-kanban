// The worker's pairing state file, keyed by BOARD IDENTITY rather than by the URL dialed (#1337).
//
// A board reachable at several URLs (plain LAN + tailnet) is ONE board: one pairing, one worker
// registration. The board sends a stable id (`boardId`, from its register answer and its
// unauthenticated /health); the pairing lives under `boards["board:<id>"]` and `urls` maps every URL
// this machine has seen for that board to its id.
//
// Old files are URL-keyed (`boards["http://host:3003"]`). They keep working: a lookup falls back to
// the URL key, and `adoptBoardId` MIGRATES the entry to the identity key the first time the board's
// id is learned. A board too old to send an id simply stays URL-keyed.
//
// Db-free: this module ships in the standalone worker binary.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface WorkerIdentity {
  workerId: string;
  workerToken: string;
  name: string;
  /** The board's stable id, when the board sent one (#1337). */
  boardId?: string;
}

export interface WorkerStateFile {
  boards: Record<string, WorkerIdentity>;
  /** URL -> board id, for every URL seen for a board that identified itself (#1337). */
  urls?: Record<string, string>;
}

export const BOARD_KEY_PREFIX = "board:";
export const boardKey = (boardId: string): string => `${BOARD_KEY_PREFIX}${boardId}`;

export function normalizeBoardUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

/** `--board a,b` / repeated `--board`: ordered, normalized, de-duplicated. */
export function parseBoardList(raw: string | string[] | undefined): string[] {
  const parts = (Array.isArray(raw) ? raw : [raw ?? ""]).flatMap((s) => s.split(","));
  return [...new Set(parts.map((p) => normalizeBoardUrl(p.trim())).filter(Boolean))];
}

export function loadState(stateFile: string): WorkerStateFile {
  try {
    if (existsSync(stateFile)) {
      return JSON.parse(readFileSync(stateFile, "utf8")) as WorkerStateFile;
    }
  } catch {
    /* corrupt state — re-register */
  }
  return { boards: {} };
}

function writeState(stateFile: string, state: WorkerStateFile): void {
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

/** The pairing for `url`: via its recorded board id, else the legacy URL key. */
export function findIdentity<T = WorkerIdentity>(state: { boards?: Record<string, T>; urls?: Record<string, string> }, url: string): T | undefined {
  const key = normalizeBoardUrl(url);
  const id = state.urls?.[key];
  return (id ? state.boards?.[boardKey(id)] : undefined) ?? state.boards?.[key];
}

/** The pairing held for a board id, if any. */
export function findIdentityByBoardId(state: Pick<WorkerStateFile, "boards">, boardId: string): WorkerIdentity | undefined {
  return state.boards?.[boardKey(boardId)];
}

/**
 * A URL was just seen to belong to `boardId`: record the mapping and migrate a legacy URL-keyed
 * pairing onto the identity key. When both exist the identity key wins and the legacy entry is
 * dropped (it is the same board). Returns whether the file changed.
 */
export function adoptBoardId(stateFile: string, url: string, boardId: string): boolean {
  const state = loadState(stateFile);
  const key = normalizeBoardUrl(url);
  state.boards ??= {};
  let changed = false;
  const legacy = state.boards[key];
  if (legacy) {
    if (!state.boards[boardKey(boardId)]) state.boards[boardKey(boardId)] = { ...legacy, boardId };
    delete state.boards[key];
    changed = true;
  }
  if (state.urls?.[key] !== boardId) {
    state.urls = { ...(state.urls ?? {}), [key]: boardId };
    changed = true;
  }
  if (changed) writeState(stateFile, state);
  return changed;
}

/**
 * Save a pairing. With a board id it goes under the identity key and every URL in `urls` is mapped
 * to it; without one (an older board) it is URL-keyed under `urls[0]`.
 */
export function saveIdentity(stateFile: string, boardUrl: string, identity: WorkerIdentity, urls: string[] = [boardUrl]): void {
  const state = loadState(stateFile);
  state.boards ??= {};
  const boardId = identity.boardId;
  if (boardId) {
    state.boards[boardKey(boardId)] = identity;
    state.urls = { ...(state.urls ?? {}) };
    for (const u of new Set([boardUrl, ...urls].map(normalizeBoardUrl))) {
      state.urls[u] = boardId;
      delete state.boards[u]; // a legacy entry for the same board is superseded
    }
  } else {
    state.boards[normalizeBoardUrl(boardUrl)] = identity;
  }
  writeState(stateFile, state);
}

/** Forget the pairing `url` resolves to (the board id key and/or the legacy URL key). */
export function forgetIdentity(stateFile: string, url: string): void {
  try {
    const state = loadState(stateFile);
    const key = normalizeBoardUrl(url);
    const id = state.urls?.[key];
    let changed = false;
    if (id && boardKey(id) in state.boards) { delete state.boards[boardKey(id)]; changed = true; }
    if (key in state.boards) { delete state.boards[key]; changed = true; }
    if (changed) writeState(stateFile, state);
  } catch {
    /* best-effort: the re-register that follows is what actually matters */
  }
}

export interface BoardProbe {
  url: string;
  reachable: boolean;
  /** Present when the board identified itself on /health. */
  boardId?: string;
}

/** GET `<url>/health`: is the board answering, and which board is it? Never throws. */
export async function probeBoard(url: string, timeoutMs = 2500, fetchImpl: typeof fetch = fetch): Promise<BoardProbe> {
  try {
    const res = await fetchImpl(`${normalizeBoardUrl(url)}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    const body = (await res.json().catch(() => ({}))) as { boardId?: unknown };
    return { url, reachable: true, ...(typeof body.boardId === "string" && body.boardId ? { boardId: body.boardId } : {}) };
  } catch {
    return { url, reachable: false };
  }
}

/**
 * Startup: probe every URL, record which board each one is (migrating URL-keyed pairings) and warn
 * when they disagree. Returns the probes and the index of the first URL that answered.
 */
export async function learnBoards(stateFile: string, urls: string[], log: (line: string) => void): Promise<{ probes: BoardProbe[]; firstReachable: number }> {
  const probes = await Promise.all(urls.map((u) => probeBoard(u)));
  for (const p of probes) {
    if (p.boardId && adoptBoardId(stateFile, p.url, p.boardId)) log(`[worker] ${p.url} is board ${p.boardId}: pairing state keyed by board identity`);
  }
  const ids = new Set(probes.map((p) => p.boardId).filter(Boolean));
  if (ids.size > 1) log(`[worker] WARNING: the --board URLs report different board ids (${[...ids].join(", ")}); they must all be URLs of the SAME board`);
  return { probes, firstReachable: Math.max(0, probes.findIndex((p) => p.reachable)) };
}

/** The URLs that may share one pairing: all of them unless one identified itself as a different board. */
export function urlsOfBoard(urls: string[], probes: BoardProbe[], boardId: string | undefined): string[] {
  return urls.filter((u) => { const id = probes.find((p) => p.url === u)?.boardId; return !id || !boardId || id === boardId; });
}

/** The first URL before `current` that answers and is the same board, or null. */
export async function findPreferredUrl(urls: string[], current: number, boardId: string | undefined): Promise<number | null> {
  for (let i = 0; i < current; i++) {
    const probe = await probeBoard(urls[i]!);
    if (probe.reachable && !(probe.boardId && boardId && probe.boardId !== boardId)) return i;
  }
  return null;
}

/**
 * Which URL to dial after a socket closed. One that was up and dropped (missed keepalive, board
 * gone) retries the PREFERRED url first (or the `switchTarget` a return-to-preferred picked); one
 * that never opened moves on to the next url, wrapping around.
 */
export function nextUrlIndex(current: number, count: number, wasOpen: boolean, switchTarget: number | null): number {
  return wasOpen ? (switchTarget ?? 0) : (current + 1) % count;
}

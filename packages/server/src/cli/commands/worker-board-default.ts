// #1372 — which board a worker-side verb talks to when `--board` is not given. The saved pairings in
// the state file are the answer: a machine paired with exactly one board means that board. Db-free
// (ships in the standalone worker binary).
import { existsSync, readFileSync } from "node:fs";

export const DEFAULT_WORKER_BOARD_URL = "http://127.0.0.1:3001";

/** The boards this state file holds a pairing for (trailing slashes stripped), in file order. */
export function savedBoardUrls(stateFile: string): string[] {
  try {
    if (!existsSync(stateFile)) return [];
    const parsed = JSON.parse(readFileSync(stateFile, "utf8")) as {
      boards?: Record<string, { workerId?: string; workerToken?: string }>;
      urls?: Record<string, string>;
    };
    // #1337: a board is listed ONCE, by its first-recorded URL, however many URLs map to its identity.
    const out: string[] = [];
    for (const [key, v] of Object.entries(parsed.boards ?? {})) {
      if (!v?.workerId || !v.workerToken) continue;
      if (!key.startsWith("board:")) { out.push(key.replace(/\/+$/, "")); continue; }
      const firstUrl = Object.entries(parsed.urls ?? {}).find(([, id]) => `board:${id}` === key)?.[0];
      if (firstUrl) out.push(firstUrl.replace(/\/+$/, ""));
    }
    return out;
  } catch {
    return [];
  }
}

export type BoardChoice =
  | { ok: true; board: string; source: "flag" | "state" | "default"; note?: string }
  | { ok: false; error: string };

/**
 * `--board` if given; else the one board the state file is paired with (said out loud); else, with
 * none, the local default; with several, an error that lists them and asks for `--board`.
 */
export function resolveWorkerBoard(stateFile: string, explicit?: string): BoardChoice {
  // #1337: `--board a,b` is an ordered list for `worker start`; every other verb talks to the first.
  if (explicit) return { ok: true, board: explicit.split(",")[0]!.trim().replace(/\/+$/, ""), source: "flag" };
  const saved = [...new Set(savedBoardUrls(stateFile))];
  if (saved.length === 0) return { ok: true, board: DEFAULT_WORKER_BOARD_URL, source: "default" };
  if (saved.length === 1) {
    return { ok: true, board: saved[0]!, source: "state", note: `no --board given: using the board this worker is paired with (${saved[0]}, from ${stateFile})` };
  }
  return {
    ok: false,
    error:
      `this worker is paired with ${saved.length} boards (from ${stateFile}):\n` +
      saved.map((b) => `  ${b}`).join("\n") +
      "\nPass --board <url> to choose one.",
  };
}

/** worker start: --board, else (no first-pairing token) the board the state file is paired with. */
export function startBoard(o: { board?: string; token?: string; stateFile?: string }, stateFile: string): string {
  return o.board ?? (o.token ? DEFAULT_WORKER_BOARD_URL : boardOrExit(stateFile, undefined));
}

/** Resolve, print the note (stderr when `quiet`, so JSON on stdout stays parseable), exit 1 on ambiguity. */
export function boardOrExit(stateFile: string, explicit: string | undefined, quiet = false): string {
  const choice = resolveWorkerBoard(stateFile, explicit);
  if (!choice.ok) {
    console.error(choice.error);
    process.exit(1);
  }
  if (choice.note) (quiet ? console.error : console.log)(choice.note);
  return choice.board;
}

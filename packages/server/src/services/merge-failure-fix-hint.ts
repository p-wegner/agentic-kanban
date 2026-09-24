/**
 * Turn a DETERMINISTIC guard red into the one-line fix it is (#1250).
 *
 * Observed 2026-09-24 on #1243: three merge presses, each ~8 minutes in the pre-merge gate, the
 * first two failing on `function-nloc-ratchet` (client, then server) refusing a STALE baseline
 * entry — the branch had shrunk five functions and nobody banked the new numbers. The ratchet
 * says exactly what to do (`<file>::<fn>: N < baseline M — lower it to N`), but that sentence
 * reached only the board log and `%TEMP%\kanban-verify-<ws>.log`. This module reads it back out
 * of the verify tail the gate already stores in its failure message and shapes it as EDITS a
 * human or `POST /merge/bank-shrinks` can apply without opening the log.
 *
 * Recognised shapes, each from the suite's own assertion text (pinned by the test file with
 * the real output of both packages):
 *  - `function-nloc-ratchet` (client + server rings): the stale list
 *    `<file>::<fn>: N < baseline M — lower it to N`, attributed to a package by the nearest
 *    preceding package marker (a `packages/<pkg>/` path, the ring's describe title, or a
 *    `[test:mine] <pkg>:` header). The baseline per package is
 *    `packages/<pkg>/src/__tests__/function-nloc-baseline.ts`.
 *  - `always-run-guard-runtime-ratchet`: `Lower BASELINE_TOTAL_MS to N` /
 *    `Lower MERGE_FLOOR_BASELINE_MS to N`, whose baseline is a `const` in the test file itself.
 *  - `max-file-size` PRINTS its stale complexity entries rather than failing on them (several
 *    agents share that checkout, so a red on an improvement gets switched off), so there is no
 *    red to hint at and it is deliberately not parsed.
 *
 * Pure: text in, edits out. A key it cannot attribute to a package is dropped rather than
 * guessed — a wrong baseline file is worse than a missing hint (cf. `repoRelativeSuitePath`).
 */

export interface MergeFixHintEdit {
  /** Repo-relative path of the baseline file to edit. */
  baselineFile: string;
  /** The entry key (`<file>::<fn>` for the nloc rings, the `const` name for the runtime ratchet). */
  key: string;
  /** The value the baseline holds now; null when the failure text did not state it. */
  from: number | null;
  /** The value the ratchet asked for. */
  to: number;
}

export interface MergeFixHint {
  kind: "bank-shrinks";
  edits: MergeFixHintEdit[];
  /** One operator line, e.g. `stale baseline: lower a.tsx::A 416 -> 371 in packages/client/…`. */
  summary: string;
}

const NLOC_PACKAGES = new Set(["client", "server"]);
const NLOC_BASELINE = (pkg: string) => `packages/${pkg}/src/__tests__/function-nloc-baseline.ts`;
const RUNTIME_RATCHET_FILE = "packages/server/src/__tests__/always-run-guard-runtime-ratchet.test.ts";

/** `<file>::<fn>: N < baseline M — lower it to N` (the dash may survive the log as any glyph). */
const NLOC_STALE_RE = /([^\s"'`\[\],]+::[^\s"'`\[\],:]+):\s*(\d+)\s*<\s*baseline\s*(\d+)\s*\S{1,3}\s*lower it to\s*(\d+)/g;
/** `Lower BASELINE_TOTAL_MS to 512345` — the runtime ratchet's two shrink-only consts. */
const RUNTIME_STALE_RE = /Lower\s+(BASELINE_TOTAL_MS|MERGE_FLOOR_BASELINE_MS)\s+to\s+(\d+)/g;

/**
 * Which package a line of vitest output belongs to. The three markers the runner prints, in
 * the order they are trusted: an explicit `packages/<pkg>/` path, the ring's own describe
 * title, the `test-mine` per-package header.
 */
function packageMarker(line: string): string | null {
  const byPath = /packages\/(client|server)\//.exec(line);
  if (byPath) return byPath[1]!;
  const byTitle = /\b(client|server) function nloc is a shrink-only ring/.exec(line);
  if (byTitle) return byTitle[1]!;
  const byHeader = /\[test:mine\]\s+(client|server)\b/.exec(line);
  if (byHeader) return byHeader[1]!;
  return null;
}

function nlocEdits(lines: string[]): MergeFixHintEdit[] {
  const out: MergeFixHintEdit[] = [];
  let pkg: string | null = null;
  for (const line of lines) {
    const marker = packageMarker(line);
    if (marker && NLOC_PACKAGES.has(marker)) pkg = marker;
    for (const m of line.matchAll(NLOC_STALE_RE)) {
      if (!pkg) continue;
      const to = Number(m[4]);
      const measured = Number(m[2]);
      // The sentence names the measured value twice; disagreeing copies mean a mangled line.
      if (to !== measured) continue;
      out.push({ baselineFile: NLOC_BASELINE(pkg), key: m[1]!, from: Number(m[3]), to });
    }
  }
  return out;
}

function runtimeEdits(text: string): MergeFixHintEdit[] {
  const out: MergeFixHintEdit[] = [];
  for (const m of text.matchAll(RUNTIME_STALE_RE)) {
    out.push({ baselineFile: RUNTIME_RATCHET_FILE, key: m[1]!, from: null, to: Number(m[2]) });
  }
  return out;
}

function dedupe(edits: MergeFixHintEdit[]): MergeFixHintEdit[] {
  const seen = new Set<string>();
  return edits.filter((e) => {
    const id = `${e.baselineFile}\u0000${e.key}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** The one line appended to a gate failure message and shown beside the merge error. */
export function describeMergeFixHint(edits: readonly MergeFixHintEdit[]): string {
  const parts = edits.map((e) => `${e.key} ${e.from ?? "?"} -> ${e.to} in ${e.baselineFile}`);
  return `stale baseline: lower ${parts.join("; ")}`;
}

/**
 * Read the shrink-only family's stale entries out of a verify tail. `null` when the text names
 * none — the common case, since most reds are not this family.
 */
export function deriveMergeFixHint(text: string | null | undefined): MergeFixHint | null {
  if (!text) return null;
  const lines = text.split(/\r?\n/);
  const edits = dedupe([...nlocEdits(lines), ...runtimeEdits(text)]);
  if (edits.length === 0) return null;
  return { kind: "bank-shrinks", edits, summary: describeMergeFixHint(edits) };
}

/**
 * Carry the hint onto a failed gate result and end its message with the one-line fix, so the
 * merge path, the issue comment and the board log all say "lower X to N" beside the red.
 * Total: a message with no recognised shape comes back unchanged.
 */
export function withMergeFixHint<T extends { message: string }>(result: T): T & { fixHint?: MergeFixHint } {
  const fixHint = deriveMergeFixHint(result.message);
  if (!fixHint) return result;
  return { ...result, message: `${result.message}\n${fixHint.summary}`, fixHint };
}

/** The shape this projection needs from a merge job (structural, so `MergeJob` fits). */
export interface MergeFixHintJobSource {
  state: string;
  error?: string;
  attempts?: ReadonlyArray<{ outcome?: string; detail?: string }>;
}

/**
 * The hint for a merge job whose LAST gate attempt failed — the `GET /merge-status` half. The
 * attempt's `detail` is the gate message (which already carries the summary line, see
 * `withMergeFixHint`); a job that failed without recording an attempt is read from its error.
 * Null while the job is running, or when it failed for any other reason.
 */
export function mergeFixHintFromJob(job: MergeFixHintJobSource | null | undefined): MergeFixHint | null {
  if (!job) return null;
  const attempts = job.attempts ?? [];
  const last = attempts[attempts.length - 1];
  if (last?.outcome) return last.outcome === "failed" ? deriveMergeFixHint(last.detail) : null;
  return job.state === "failed" ? deriveMergeFixHint(job.error) : null;
}

/**
 * Name the suites a failed verify run blamed, and say whether that failure is DETERMINISTIC (#1230).
 *
 * MEASURED motivation: workspace 75b824fe ran its pre-merge gate 31 times between 22:47 and
 * 06:49 UTC on ONE commit, every run failing the same guard
 * (`packages/client/src/__tests__/function-nloc-ratchet.test.ts`, "no listed function has
 * grown"). ~3 min per run, ~1.8 h of box time, zero information — and the test-impact ledger
 * recorded all 31 rows as `result: fail, failed: []`, so nothing downstream could even see WHICH
 * suite it was.
 *
 * Two facts made both halves invisible, and both are answered here:
 *
 *  1. **Attribution.** `parseFailedSuites` (verify-flake-retry.ts) attributes a `FAIL` line to a
 *     package by the `[test:mine] <pkg>:` header that PRECEDES it — but `resolveVerifyOutcome`
 *     hands it `stderr + "\n" + stdout`, and vitest prints its failure summary on stderr while the
 *     runner prints its headers on stdout. So every `FAIL` line sits ahead of every header, the
 *     package is null, and `repoRelativeSuitePath` (correctly) refuses to guess. {@link
 *     attributeFailedSuites} answers the question the header would have: the suite's
 *     package-relative path exists under exactly ONE `packages/<pkg>/` directory of the worktree,
 *     and that is the attribution. A path that exists under several (or none) is still dropped —
 *     a guessed name is worse than a missing one, see `repoRelativeSuitePath`.
 *
 *  2. **Determinism.** A guard/ratchet suite asserts a property of the whole tree, not of a timing
 *     window: it fails the same way on the same commit every time, so re-running it buys nothing.
 *     {@link isGuardSuite} classifies by the two signals the gate already uses — the
 *     `@gate:always-run` marker (`always-run-guard-floor.ts`) and the `__tests__` naming
 *     convention (`ratchet` / `guard` / `invariant` / `parity`). {@link classifyFailedSuites}
 *     then calls a failure deterministic when EVERY named suite is a guard: a mixed failure may
 *     still contain a load artefact, and a failure that named nothing cannot be classified.
 *
 * Pure apart from `existsSync`/`readFileSync` probes of the worktree; every probe is best-effort
 * and a probe error reads as "not a guard" / "unattributable", never a throw — this runs inside
 * the merge path.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { hasAlwaysRunMarker } from "./always-run-guard-floor.js";

/** The un-prefixed failing-suite shape the ledger and this module both read. */
export interface FailedSuiteRef {
  /** Suite path as vitest printed it: relative to the PACKAGE dir, since that is its cwd. */
  file: string;
  /** The package whose vitest run reported it, or null when the output gave no package context. */
  packageLabel?: string | null;
}

/** Mirrors the ticket's naming rule: a `__tests__` suite whose name says it is a tree-level check. */
export const GUARD_SUITE_NAME_RE = /(?:^|\/)[^/]*(?:ratchet|guard|invariant|parity)[^/]*\.(?:test|spec)\.[cm]?[jt]sx?$/i;

function normalize(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** The package directories a worktree actually has — the candidate set for attribution. */
function packageDirs(workingDir: string): string[] {
  try {
    const root = join(workingDir, "packages");
    return readdirSync(root).filter((name) => {
      try {
        return statSync(join(root, name)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

/**
 * Repo-relative names for the suites that can be placed, in the vocabulary `impact.mjs select`
 * names tests in (`packages/<pkg>/<file>`).
 *
 * A labelled suite is placed by its label, exactly as `repoRelativeSuitePath` does. An
 * UNLABELLED one is placed by DISK: if its package-relative path exists under exactly one
 * `packages/<pkg>/` of the worktree, that package is the attribution. Order is preserved and
 * duplicates collapsed, so a file the runner named twice (once per failing test, once in the
 * summary) is one entry.
 */
export function attributeFailedSuites(workingDir: string | null, suites: readonly FailedSuiteRef[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const pkgs = workingDir ? packageDirs(workingDir) : [];
  for (const suite of suites) {
    const file = normalize(suite.file);
    let placed: string | null = null;
    if (file.startsWith("packages/") || file.startsWith(".claude/")) {
      placed = file;
    } else if (suite.packageLabel) {
      placed = `packages/${suite.packageLabel}/${file}`;
    } else if (workingDir) {
      const hits = pkgs.filter((pkg) => existsSync(join(workingDir, "packages", pkg, file)));
      if (hits.length === 1) placed = `packages/${hits[0]}/${file}`;
    }
    if (!placed || seen.has(placed)) continue;
    seen.add(placed);
    out.push(placed);
  }
  return out;
}

/**
 * Is this (repo-relative) suite a tree-level guard — i.e. a suite whose verdict is a property of
 * the commit, not of the machine? Either signal suffices: the `@gate:always-run` marker in the
 * file, or the `__tests__` naming convention. The marker read is best-effort; an unreadable file
 * falls back to the name alone.
 */
export function isGuardSuite(workingDir: string | null, repoRelativePath: string): boolean {
  const file = normalize(repoRelativePath);
  if (/(?:^|\/)__tests__\//.test(file) && GUARD_SUITE_NAME_RE.test(file)) return true;
  if (!workingDir) return false;
  try {
    return hasAlwaysRunMarker(readFileSync(join(workingDir, file), "utf8"));
  } catch {
    return false;
  }
}

export interface FailedSuiteClassification {
  /** Every failing suite that could be placed, repo-relative, in the runner's order. */
  files: string[];
  /** The subset of `files` that are guards/ratchets. */
  guardSuites: string[];
  /**
   * True when the failure is deterministic by construction: at least one suite was named and
   * EVERY named suite is a guard. Re-gating such a failure on the same commit cannot change
   * the verdict.
   */
  guardFailure: boolean;
}

/** {@link attributeFailedSuites} + {@link isGuardSuite}, as one verdict. */
export function classifyFailedSuites(workingDir: string | null, suites: readonly FailedSuiteRef[]): FailedSuiteClassification {
  const files = attributeFailedSuites(workingDir, suites);
  const guardSuites = files.filter((file) => isGuardSuite(workingDir, file));
  return { files, guardSuites, guardFailure: files.length > 0 && guardSuites.length === files.length };
}

/**
 * The operator-facing clause naming the failures, for a log line or a gate message. Empty when
 * nothing could be named, so a caller can prepend it unconditionally.
 */
export function describeFailedSuites(classification: { files: readonly string[]; guardFailure: boolean }): string {
  if (classification.files.length === 0) return "";
  const kind = classification.guardFailure ? " [deterministic guard failure]" : "";
  return `failing suite(s): ${classification.files.join(", ")}${kind}`;
}

/**
 * Carry the named failures onto a failed gate result and lead its message with them, so the
 * merge path, the issue comment and the board log all name the file(s) without opening
 * `%TEMP%\kanban-verify-<ws>.log`. Total: with nothing named the result comes back unchanged.
 */
export function withFailedSuites<T extends { message: string }>(
  result: T,
  named: { failedSuites?: string[]; guardFailure?: boolean },
): T & { failedSuites?: string[]; guardFailure?: boolean } {
  const files = named.failedSuites ?? [];
  if (files.length === 0) return result;
  const lead = describeFailedSuites({ files, guardFailure: named.guardFailure === true });
  return { ...result, message: `${lead}. ${result.message}`, failedSuites: files, guardFailure: named.guardFailure === true };
}

/**
 * The verify gate's TUNABLES: the three per-project preferences that decide how long the
 * gate may run, how wide it may run, and whether it may scope itself to changed files —
 * plus the capacity derivation (#909) behind the worker count.
 *
 * Its own module for the reason the two extractions before it happened
 * (`verify-failure-summary.ts` #221/#490, `pre-merge-gate-tier.ts` #538):
 * `pre-merge-gate.service.ts` sits against the 1000-line god-module ceiling, and this block
 * is the most separable thing in it — it reads preferences and the machine, and touches no
 * part of running the gate. Everything here is re-exported from `pre-merge-gate.service.ts`,
 * so existing importers (and `verify-budget-parity.test.ts`) are unchanged.
 */
import * as os from "node:os";
import { projectPref } from "@agentic-kanban/shared/lib/dynamic-preference-keys";
import { readTier0Capacity, deriveVerifyWorkers } from "@agentic-kanban/shared/lib/machine-capacity";
import type { Database } from "../db/index.js";
import { getPreference } from "../repositories/preferences.repository.js";
import { VERIFY_SCRIPT_TIMEOUT_MS } from "./verify-budget.js";

/**
 * Default verify-gate timeout (#192). The verify gate runs a full build+test suite in a
 * fresh worktree (cold daemon/cache), a materially heavier job than the setup/install
 * script `DEFAULT_SETUP_SCRIPT_TIMEOUT_MS` budgets — so it gets its own, larger default
 * budget rather than sharing the 5-minute setup-script constant. Still overridable per
 * project via `verify_timeout_ms_<projectId>`.
 *
 * The number itself now comes from `verify-budget.ts`, shared with base-branch-health: both
 * run the SAME `verify_script`, and while they held separate budgets (20 vs 45 minutes) the
 * base probe could answer green where every branch gate timed out.
 */
export const DEFAULT_VERIFY_TIMEOUT_MS = VERIFY_SCRIPT_TIMEOUT_MS;

/** Preference key for a per-project override of the verify-gate timeout (ms). */
// #496: built from the registry, so an unregistered prefix is a COMPILE error.
const verifyTimeoutPrefDef = projectPref("verify_timeout_ms");
const verifyMaxWorkersPrefDef = projectPref("verify_max_workers");
const verifyFileScopePrefDef = projectPref("verify_file_scope");

export function verifyTimeoutPrefKey(projectId: string): string {
  return verifyTimeoutPrefDef.key(projectId);
}

/** Bounds a parsed timeout override to something sane: at least 30s, at most 3 hours. */
const MIN_TIMEOUT_MS = 30 * 1000;
const MAX_TIMEOUT_MS = 3 * 60 * 60 * 1000;

export async function resolveVerifyTimeoutMs(projectId: string, database: Database): Promise<number> {
  const raw = await getPreference(verifyTimeoutPrefKey(projectId), database).catch(() => null);
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  if (Number.isFinite(parsed) && parsed >= MIN_TIMEOUT_MS && parsed <= MAX_TIMEOUT_MS) return parsed;
  return DEFAULT_VERIFY_TIMEOUT_MS;
}

/**
 * Fallback vitest worker cap when neither a live capacity read nor the pref override is
 * available (#278; degraded from a fixed default to a fallback by #909). Two forks still
 * overlap I/O-bound suites while leaving the box responsive; the pre-fix default was `cpus/2`.
 */
export const DEFAULT_VERIFY_MAX_WORKERS = 2;

/**
 * Preference key for a per-project CEILING on the verify-gate vitest worker cap (integer,
 * clamped to 1..{@link MAX_VERIFY_WORKERS}; anything unparseable falls back to
 * {@link DEFAULT_VERIFY_MAX_WORKERS}).
 *
 * **There is no UI for this** — it is set through the preferences API/CLI/MCP like any other
 * project-scoped pref, which is why the revert procedure is written down here rather than in a
 * settings panel description.
 *
 * **Since #909 this is a CEILING, not the worker count itself.** `resolveVerifyMaxWorkers`
 * derives the actual number from live capacity (spare cores, free RAM via
 * `deriveVerifyWorkers`/`machine-capacity.ts`) and never exceeds this pref. `KANBAN_VERIFY_CONCURRENCY`
 * remains an unconditional env override on top of both, for an operator who wants to pin an
 * exact number regardless of what the box looks like at gate time.
 *
 * **What raising the ceiling buys, measured (#536).** This repo's gate was CPU-bound at the
 * 2-worker cap: 4127s of test CPU against 2380s wall, i.e. both workers ~87% busy on a 16-core
 * box with 14 cores idle. Raising it to 6 cut the run to 1564s. Two effects made that safe
 * rather than flaky: the 60s per-test timeouts were already in place, and #581 now holds
 * builder launches while a gate runs (`quiesce_builders_during_gate`), so the forks are not
 * competing with an agent's own test run for the same box. The same 6 flakes on a loaded box —
 * which is exactly why #909 makes the LIVE number, not just the ceiling, capacity-derived.
 *
 * **Revert procedure — one pref write, no deploy, no restart.** The value is read fresh on
 * every gate run (`resolveVerifyMaxWorkers` below), so clearing the override takes effect on
 * the next merge — set `verify_max_workers_<projectId>` back to `2` (the shipped default), or
 * to the empty string, which the clamp turns into the same thing.
 */
export function verifyMaxWorkersPrefKey(projectId: string): string {
  return verifyMaxWorkersPrefDef.key(projectId);
}

/**
 * Preference key for turning the gate's file-level test scoping OFF per project (#278).
 *
 * Defaults to ON. It is a real narrowing of what the gate proves — `vitest related` selects
 * suites by import graph, so a test that exercises a change through a mechanism vitest cannot
 * see (a spawned process, a fixture read off disk) is no longer selected. The filesystem
 * ASSERTION suites, which are the ones that provably cannot be reached by import, are
 * force-run by `scripts/test-mine.mjs` (`ALWAYS_RUN_TESTS`), so the residual gap is narrower
 * than "everything not imported". A project that would rather pay the full suite sets this to
 * "false".
 */
export function verifyFileScopePrefKey(projectId: string): string {
  return verifyFileScopePrefDef.key(projectId);
}

export async function resolveVerifyFileScope(projectId: string, database: Database): Promise<boolean> {
  const raw = await getPreference(verifyFileScopePrefKey(projectId), database).catch(() => null);
  return raw?.trim().toLowerCase() !== "false";
}

const MAX_VERIFY_WORKERS = 32;

/** Result of {@link resolveVerifyMaxWorkers} — the chosen width plus how it was chosen, so the
 *  passing gate message can say `workers N (derived, host free X GB)` rather than a bare number
 *  (#909's acceptance criterion: a level/number may only ever be reported, never assumed). */
export interface ResolvedVerifyWorkers {
  workers: number;
  /** True when `workers` came from live capacity rather than an env-var pin. */
  derived: boolean;
  /** Free RAM (GB) observed at derivation time, when available. */
  hostFreeGb: number | null;
}

/**
 * Exported for the base-branch health probe (#931): it spawns the same `verify_script` on
 * the same box and had no worker cap of its own, so it could default to one vitest worker
 * per core just like an unconfigured gate — the SAME budget applies to both. It reads
 * `.workers` off the result; the rest is #909's provenance for the gate message.
 */
export async function resolveVerifyMaxWorkers(projectId: string, database: Database): Promise<ResolvedVerifyWorkers> {
  // `KANBAN_VERIFY_CONCURRENCY`-style unconditional override, but for the vitest fork count:
  // an operator who wants an exact number regardless of the box gets one, same escape hatch as
  // the build semaphore (jvm-build-semaphore.ts).
  const envOverride = Number.parseInt(process.env.KANBAN_VERIFY_MAX_WORKERS ?? "", 10);
  if (Number.isFinite(envOverride) && envOverride >= 1) {
    return { workers: envOverride, derived: false, hostFreeGb: null };
  }

  const raw = await getPreference(verifyMaxWorkersPrefKey(projectId), database).catch(() => null);
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  const ceiling = Number.isFinite(parsed) && parsed >= 1 && parsed <= MAX_VERIFY_WORKERS ? parsed : MAX_VERIFY_WORKERS;

  try {
    const tier0 = readTier0Capacity();
    const workers = deriveVerifyWorkers({ cpuCount: os.cpus().length, freeGb: tier0.freeGb, ceiling });
    return { workers, derived: true, hostFreeGb: tier0.freeGb };
  } catch {
    // Capacity read failed — fall back to the pref (or its shipped default) exactly as before
    // #909, rather than letting a diagnostic failure block or misreport the gate.
    const fallback = Number.isFinite(parsed) && parsed >= 1 && parsed <= MAX_VERIFY_WORKERS ? parsed : DEFAULT_VERIFY_MAX_WORKERS;
    return { workers: fallback, derived: false, hostFreeGb: null };
  }
}

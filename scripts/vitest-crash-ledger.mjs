// #1485 — attribute a vitest worker-fork crash to the file(s) it took down, and decide whether the
// crash alone (zero failed tests) earns ONE automatic retry of the unreported files.
//
// Two halves in one module so the reporter and the decision cannot drift apart:
//   - the DEFAULT EXPORT is a vitest reporter (passed to vitest by file path). It does the
//     onTestModuleQueued / onTestModuleEnd bookkeeping and, at run end, writes a JSON ledger to
//     the path in KANBAN_TEST_CRASH_LEDGER: which files were queued but never reported, which were
//     mid-flight (started, never ended), how many modules failed, and the raw unhandled errors
//     (with any `code` / `signal` the pool attached).
//   - `decideCrashRetry` (pure) reads that ledger and says "retry these files" or "stay red".
import { writeFileSync } from "node:fs";

/** Vitest's own words for a fork that died; deliberately not the app's `unhandled error` logs. */
export const WORKER_CRASH_PATTERN = /\[vitest-pool\]: Worker \w+ emitted error|Worker exited unexpectedly/i;

export const LEDGER_ENV = "KANBAN_TEST_CRASH_LEDGER";

/** Normalise a path for comparison — vitest reports Windows paths with backslashes. */
const slash = (p) => String(p).replace(/\\/g, "/");

export default class CrashLedgerReporter {
  constructor() {
    this.queued = new Set();
    this.started = new Set();
    this.ended = new Set();
    this.failedModules = new Set();
  }

  onInit(vitest) {
    this.root = vitest?.config?.root ?? process.cwd();
  }

  onTestModuleQueued(mod) {
    this.queued.add(slash(mod.moduleId));
  }

  onTestModuleStart(mod) {
    this.started.add(slash(mod.moduleId));
  }

  onTestModuleEnd(mod) {
    const id = slash(mod.moduleId);
    this.ended.add(id);
    let state;
    try {
      state = mod.state();
    } catch {
      state = undefined;
    }
    if (state === "failed") this.failedModules.add(id);
  }

  onTestRunEnd(modules, unhandledErrors, reason) {
    const file = process.env[LEDGER_ENV];
    if (!file) return;
    for (const mod of modules ?? []) {
      // A module can reach the final list without an end event (e.g. its collection errored).
      const id = slash(mod.moduleId);
      if (!this.ended.has(id) && mod.state?.() === "failed") this.failedModules.add(id);
    }
    const unreported = [...this.queued].filter((f) => !this.ended.has(f));
    const inFlight = [...this.started].filter((f) => !this.ended.has(f));
    const ledger = {
      root: slash(this.root ?? ""),
      reason,
      unreported,
      inFlight,
      failedModules: [...this.failedModules],
      errors: (unhandledErrors ?? []).map((e) => ({
        name: e?.name,
        message: String(e?.message ?? e),
        code: e?.code,
        signal: e?.signal,
        exitCode: e?.exitCode,
      })),
    };
    try {
      writeFileSync(file, JSON.stringify(ledger));
    } catch {
      // Never let bookkeeping fail the run it is observing.
    }
  }
}

/** One line per crashed file naming what the pool told us about how the fork died. */
export function describeCrash(ledger, relativize = (f) => f) {
  const how = ledger.errors
    .filter((e) => WORKER_CRASH_PATTERN.test(e.message))
    .map((e) => {
      const parts = [];
      const exit = e.exitCode ?? e.code;
      if (exit !== undefined && exit !== null) parts.push(`exit code ${exit}`);
      if (e.signal) parts.push(`signal ${e.signal}`);
      return parts.length ? parts.join(", ") : "exit code/signal not reported by vitest";
    });
  const detail = how.length ? how.join("; ") : "exit code/signal not reported by vitest";
  const files = ledger.inFlight.length ? ledger.inFlight : ledger.unreported;
  const label = ledger.inFlight.length ? "fork died while running" : "never reported (fork died)";
  return files.map((f) => `${label}: ${relativize(f)} — ${detail}`);
}

/**
 * Decide whether a non-zero run was ONLY a fork crash. Retry when: every unhandled error is a
 * worker crash (anything else is a real error and stays red), no module failed, and there is at
 * least one unreported file to re-run. Returns `{ retry: false, reason }` otherwise.
 *
 * @param {{unreported:string[], failedModules:string[], errors:{message:string}[]}|null} ledger
 * @param {(abs:string)=>string|null} toPackageRelative  null = file is outside the package
 */
export function decideCrashRetry(ledger, toPackageRelative) {
  if (!ledger) return { retry: false, reason: "no ledger written" };
  if (ledger.errors.length === 0) return { retry: false, reason: "no unhandled errors" };
  if (!ledger.errors.every((e) => WORKER_CRASH_PATTERN.test(e.message))) {
    return { retry: false, reason: "unhandled errors other than a worker crash" };
  }
  if (ledger.failedModules.length > 0) return { retry: false, reason: "test files failed" };
  const files = ledger.unreported.map(toPackageRelative).filter((f) => f);
  if (files.length === 0) return { retry: false, reason: "no unreported file could be named" };
  return { retry: true, files };
}

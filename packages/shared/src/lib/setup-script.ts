import { spawn } from "node:child_process";

export interface SetupScriptResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /**
   * True when the process was killed for exceeding its timeout budget rather than
   * exiting on its own. Callers MUST check this before treating a non-zero exit as a
   * verdict (#192) — a timeout means "didn't finish in time" (cache-temperature-
   * dependent, retryable), not "the build/tests are broken".
   */
  timedOut?: boolean;
  /**
   * True when the process was killed by the NO-PROGRESS watchdog rather than the wall-clock
   * timeout (#903). A hung verify child (workers idle, no stdout/stderr) is invisible below
   * the (up to 3h) wall-clock ceiling — this is the earlier, cheaper backstop. Like
   * `timedOut`, this is NOT a build/test failure verdict: it means the process stopped making
   * progress, not that it ran and failed.
   */
  noProgress?: boolean;
  /**
   * True when the process was killed because the caller's `signal` aborted (#989).
   *
   * A THIRD non-verdict, alongside `timedOut` and `noProgress`, and it must be read the same
   * way: the caller changed its mind, so the run says nothing about the thing under test. The
   * base-health probe uses it to abandon a verify mid-flight when a merge gate is waiting for
   * the box's verify slot.
   */
  aborted?: boolean;
}

/** Fallback timeout when a caller doesn't pass `timeoutMs` (#192 — was a non-configurable constant). */
export const DEFAULT_SETUP_SCRIPT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Default no-progress budget (#903): kill+fail a verify/setup child after this many ms with
 * NO stdout/stderr output at all, far below the up-to-3h wall-clock `timeoutMs` ceiling.
 * Measured live: a hung merge-gate vitest run sat with idle workers for 47 minutes of wall
 * clock before anything noticed — the only backstop was the 90-minute `verify_timeout_ms`.
 * 15 minutes comfortably covers legitimate silent stretches (a cold package-manager install,
 * a compile step with no progress output) while catching a genuinely stuck process an order
 * of magnitude sooner than the wall-clock ceiling.
 */
export const DEFAULT_NO_PROGRESS_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * The container a setup script must run inside, when the workspace's builder is
 * containerized. Structurally identical to `DevcontainerHandle`; declared
 * locally so this module stays free of a devcontainer-exec import.
 */
export interface SetupScriptContainer {
  containerId: string;
  remoteUser: string;
  remoteWorkspaceFolder: string;
}

/**
 * Rewrite a leading/chained POSIX wrapper invocation (`./gradlew`, `./mvnw`) into the
 * form cmd.exe can actually run (#181).
 *
 * `cmd.exe` parses `./gradlew` as the command `.` (a Windows drive-relative path
 * separator, not "current directory" like POSIX shells) and fails with "'.' is not
 * recognized" — so a `verify_script`/`setup_script` of `./gradlew build` (the profile's
 * own testCommand/buildCommand text, or a hand-set override, or an older project
 * predating the platform-aware wrapper detection in gradle-detect.service.ts) fails the
 * merge gate outright on Windows, regardless of where that POSIX-style text came from.
 * The explicit `.\` prefix is required too — a bare `gradlew.bat`/`mvnw.cmd` is not
 * resolved from the cwd under `cmd /c`.
 *
 * Every shell separator counts, not just `&&`. The original pattern matched only the
 * start of the script or a preceding `&&`, so the SECOND half of the very scripts this
 * exists for slipped through untranslated and failed exactly as before —
 * `./gradlew check || ./gradlew clean check`, `cd app; ./gradlew build`, a piped or
 * parenthesised invocation, and any multi-line script. The character class below covers
 * `&&`/`||` too (their last character is `&`/`|`), and the captured whitespace is
 * restored so the rewritten script keeps its original spacing. Deliberately
 * conservative: a wrapper preceded by anything else (a quote, another path segment as in
 * `./sub/gradlew`) is left alone.
 */
const WRAPPER_INVOCATION_START = "(^|[\\r\\n;&|(])(\\s*)";

export function translatePosixWrapperForWindows(script: string): string {
  return script
    .replace(new RegExp(`${WRAPPER_INVOCATION_START}\\./gradlew\\b`, "g"), "$1$2.\\gradlew.bat")
    .replace(new RegExp(`${WRAPPER_INVOCATION_START}\\./mvnw\\b`, "g"), "$1$2.\\mvnw.cmd");
}

export interface RunSetupScriptOptions {
  /**
   * When present, the script runs INSIDE this container instead of on the host.
   *
   * This is not an optimization — it is required for correctness (#135). A
   * host-run `pnpm install` materializes node_modules as symlinks into the host
   * package store, so on Windows every link target is a Windows path and NOTHING
   * resolves inside a Linux container: the agent could write code but not run
   * tests (`Cannot find module .../vitest.mjs`). The same breakage hits any
   * native module or platform-specific binary.
   */
  container?: SetupScriptContainer;
  /**
   * Wall-clock budget in ms before the process is killed. Defaults to
   * {@link DEFAULT_SETUP_SCRIPT_TIMEOUT_MS} (#192 — was hardcoded to exactly 5 minutes with
   * no override, which became a hard ceiling on project size: any compiled-stack build that
   * exceeds it from a cold cache gets killed and misreported as a failure).
   */
  timeoutMs?: number;
  /**
   * No-progress budget in ms (#903): the process is killed if it produces NO stdout/stderr
   * for this long, independent of the wall-clock `timeoutMs`. Defaults to
   * {@link DEFAULT_NO_PROGRESS_TIMEOUT_MS}. Pass `0` (or a negative number) to disable the
   * watchdog entirely — used by callers that intentionally run a silent command.
   */
  noProgressTimeoutMs?: number;
  /**
   * Extra env vars layered onto `process.env` for this invocation (e.g. a per-worktree
   * `GRADLE_USER_HOME`, #194) — applied AFTER the process env copy so a caller's value wins.
   */
  env?: Record<string, string>;
  /**
   * Abort the run from outside (#989): when this fires, the child is killed and the promise
   * RESOLVES with `aborted: true` — never rejects, matching the never-reject contract the
   * timeout and no-progress paths already keep, so a caller cannot mistake "we stopped it" for
   * "it ran and failed".
   *
   * An already-aborted signal kills before the child does any work; the process is still spawned
   * first so there is exactly one teardown path rather than two.
   */
  signal?: AbortSignal;
}

/**
 * Build the argv that runs `script` inside a container.
 *
 * `/bin/sh -c` mirrors the POSIX host branch, so a setup script sees the same
 * shell semantics whether it runs on a POSIX host or in a container. `-w` is the
 * container's view of the worktree, never the host path.
 */
export function buildContainerSetupSpec(
  script: string,
  container: SetupScriptContainer,
): { command: string; args: string[] } {
  return {
    command: "docker",
    args: [
      "exec",
      "-u",
      container.remoteUser,
      "-w",
      container.remoteWorkspaceFolder,
      container.containerId,
      "/bin/sh",
      "-c",
      script,
    ],
  };
}

export function runSetupScript(
  worktreePath: string,
  script: string,
  options: RunSetupScriptOptions = {},
): Promise<SetupScriptResult> {
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === "win32";
    const container = options.container;
    // On Windows, pass the command to cmd.exe VERBATIM. With the default
    // windowsVerbatimArguments:false, Node re-quotes/escapes the single `script`
    // arg and corrupts embedded double-quotes before cmd.exe sees them, so a
    // legitimately-quoted setupScript (e.g. `node -e "..."`) silently no-ops (#111).
    // The `/d /s /c` + verbatim form matches process-exec.ts `shellCommandSpec`.
    const hostShell = isWindows ? "cmd.exe" : "/bin/sh";
    const hostScript = isWindows ? translatePosixWrapperForWindows(script) : script;
    const hostArgs = isWindows ? ["/d", "/s", "/c", hostScript] : ["-c", script];
    const spec = container
      ? buildContainerSetupSpec(script, container)
      : { command: hostShell, args: hostArgs };

    const proc = spawn(spec.command, spec.args, {
      cwd: worktreePath,
      env: { ...process.env, ...options.env },
      windowsHide: true,
      // Verbatim quoting is a cmd.exe concern only. `docker` is a real
      // executable receiving a normal argv, so re-quoting must stay OFF for it
      // or the script would be corrupted on the way into the container.
      windowsVerbatimArguments: isWindows && !container,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let lastOutputAt = Date.now();

    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); lastOutputAt = Date.now(); });
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); lastOutputAt = Date.now(); });

    const timeoutMs = options.timeoutMs ?? DEFAULT_SETUP_SCRIPT_TIMEOUT_MS;
    const noProgressTimeoutMs = options.noProgressTimeoutMs ?? DEFAULT_NO_PROGRESS_TIMEOUT_MS;

    // #989 — one place that undoes every listener/timer, so the three kill paths below and the
    // normal exit cannot each forget a different one. `onAbort` in particular must come off the
    // signal: a long-lived signal outliving this call would otherwise retain the closure (and
    // its buffered stdout) for as long as the caller holds it.
    let onAbort: (() => void) | undefined;
    const cleanup = () => {
      clearTimeout(timeout);
      if (noProgressInterval) clearInterval(noProgressInterval);
      if (onAbort) options.signal?.removeEventListener("abort", onAbort);
    };

    const timeout = setTimeout(() => {
      proc.kill();
      // Resolve (never reject) on timeout — a kill is NOT the same verdict as a
      // script that ran to completion and failed (#192). `timedOut: true` lets
      // callers report "didn't finish in time" instead of "failed (exit 1)".
      cleanup();
      resolve({ exitCode: 124, stdout, stderr, timedOut: true });
    }, timeoutMs);

    // #903 — a hung child (idle workers, no output) is invisible below the (up to 3h)
    // wall-clock `timeout` above. Poll at a fraction of the budget rather than setting a
    // single deferred timer, so output that arrives just before a naive deadline can't
    // leave a STALE timer that fires anyway; checking "how long since the last byte"
    // against the CURRENT time on each tick is self-correcting regardless of tick cadence.
    let noProgressInterval: ReturnType<typeof setInterval> | undefined;
    if (noProgressTimeoutMs > 0) {
      const pollMs = Math.max(1000, Math.min(60_000, Math.floor(noProgressTimeoutMs / 10)));
      noProgressInterval = setInterval(() => {
        if (Date.now() - lastOutputAt >= noProgressTimeoutMs) {
          proc.kill();
          // Same never-reject contract as the wall-clock timeout: a no-progress kill is
          // "stopped producing evidence", not "ran and failed".
          cleanup();
          resolve({ exitCode: 124, stdout, stderr, noProgress: true });
        }
      }, pollMs);
      noProgressInterval.unref?.();
    }

    // #989 — wired AFTER both timers, because an already-aborted signal fires `onAbort`
    // synchronously and `cleanup` reads them.
    if (options.signal) {
      onAbort = () => {
        proc.kill();
        cleanup();
        // Same never-reject contract as the two kill paths above: an abort is "the caller
        // stopped us", not "ran and failed". 130 is the conventional SIGINT-ish exit.
        resolve({ exitCode: 130, stdout, stderr, aborted: true });
      };
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }

    proc.on("exit", (code: number | null) => {
      cleanup();
      resolve({ exitCode: code ?? 1, stdout, stderr, timedOut: false });
    });

    proc.on("error", (err: Error) => {
      cleanup();
      reject(err);
    });
  });
}

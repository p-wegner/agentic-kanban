import { spawn } from "node:child_process";

/**
 * A board-driven "does it boot and respond/render" smoke check, parameterized by a stack
 * profile's dev command + health URL + a couple of generic assertions. Generalizes the
 * hand-rolled `frontend-smoke.ps1` into a stack-agnostic descriptor.
 *
 * Only web/service projects produce one (see `buildSmokeCheck`); for libraries/CLIs there
 * is nothing to boot, so the harness yields `null` and the smoke step is skipped cleanly.
 */
export interface SmokeCheck {
  /** Command that starts the dev server (e.g. "pnpm dev", "cargo run", "./gradlew bootRun"). */
  devCommand: string;
  /** URL polled for an HTTP-200 (and optional body assertions). */
  healthUrl: string;
  /**
   * Substrings the response body must contain ("render" assertions). Empty means an
   * HTTP-200 alone passes — appropriate for an API/service with no HTML to assert on.
   */
  expectBodyContains: string[];
}

export interface SmokeCheckResult {
  /** True when the server booted and the health URL passed status + body assertions. */
  passed: boolean;
  /** True when there was nothing to check (no SmokeCheck) — a clean no-op, never a failure. */
  skipped: boolean;
  /** Final HTTP status observed (0 if the server never became reachable). */
  status: number;
  /** Human-readable outcome, suitable for surfacing in a review comment / log. */
  message: string;
  /** A bounded snippet of the response body, for diagnostics on failure. */
  bodySnippet: string;
}

export interface RunSmokeCheckOptions {
  /** Total seconds to wait for the server to boot and pass. Default 60. */
  timeoutSeconds?: number;
  /** Seconds between health-URL polls. Default 2. */
  pollIntervalSeconds?: number;
  /** Per-request fetch timeout in ms. Default 4000. */
  requestTimeoutMs?: number;
  /** Max characters of body to keep for diagnostics. Default 600. */
  snippetLength?: number;
}

const SIGNAL_NOOP: SmokeCheckResult = {
  passed: true,
  skipped: true,
  status: 0,
  message: "No smoke check applies (not a web/service project).",
  bodySnippet: "",
};

/**
 * Serialize smoke checks process-wide. A smoke check boots the project's dev server on a fixed
 * port (from the stack profile) and tears it down afterward. When several reviews finish close
 * together (WIP > 1), running their smoke checks concurrently makes the 2nd+ server fail to bind
 * the port — a false negative that withholds merge. Rather than assume every stack honors a PORT
 * env override (Ktor does, Spring uses SERVER_PORT, Vite uses a flag, …), we serialize: one dev
 * server up at a time, the port freed before the next starts. Slower under load, but correct on
 * any stack. The chain never rejects (each link swallows its own errors), so a hung/erroring smoke
 * can't wedge the queue.
 */
let smokeChain: Promise<void> = Promise.resolve();
function runSerialized<T>(task: () => Promise<T>): Promise<T> {
  const result = smokeChain.then(task);
  // Advance the chain regardless of this task's outcome; add a tiny settle delay so the killed
  // server's port is actually released before the next boot.
  smokeChain = result.then(
    () => new Promise((r) => setTimeout(r, 500)),
    () => new Promise((r) => setTimeout(r, 500)),
  );
  return result;
}

/** Stop a spawned dev server and its child process tree, cross-platform. */
function killTree(pid: number): void {
  try {
    if (process.platform === "win32") {
      // Kill the whole tree — a dev script typically spawns child server/build processes.
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    } else {
      // Negative pid targets the process group (we spawn detached to create one).
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        process.kill(pid, "SIGTERM");
      }
    }
  } catch {
    // Best-effort teardown — the server may already be gone.
  }
}

/** One health probe: returns the status + body, or status 0 when unreachable. */
async function probe(
  url: string,
  requestTimeoutMs: number,
): Promise<{ status: number; body: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: "follow" });
    const body = await res.text().catch(() => "");
    return { status: res.status, body };
  } catch {
    return { status: 0, body: "" };
  } finally {
    clearTimeout(timer);
  }
}

function snippet(body: string, max: number): string {
  return body.slice(0, Math.max(0, max));
}

/** True when every required substring is present in the body (case-insensitive). */
function bodyAssertionsPass(body: string, expect: string[]): boolean {
  if (expect.length === 0) return true;
  const haystack = body.toLowerCase();
  return expect.every((needle) => haystack.includes(needle.toLowerCase()));
}

/**
 * Boot the project's dev server in `worktreePath`, poll its health URL until it returns
 * HTTP-200 and satisfies the body assertions (or the timeout elapses), then tear the
 * server down. Pure I/O orchestration — the WHAT (command, URL, assertions) all comes
 * from the caller's `SmokeCheck`, so this is fully stack-agnostic.
 *
 * Never throws: any failure (server never booted, non-200, missing render text, timeout)
 * resolves to `{ passed: false }` with a diagnostic message + body snippet. A `null` check
 * resolves to a clean skip (`{ passed: true, skipped: true }`).
 */
export async function runSmokeCheck(
  worktreePath: string,
  check: SmokeCheck | null,
  options?: RunSmokeCheckOptions,
): Promise<SmokeCheckResult> {
  if (!check) return SIGNAL_NOOP;
  // Serialize the actual boot/poll/teardown so concurrent reviews don't fight over the dev port.
  return runSerialized(() => runSmokeCheckInner(worktreePath, check, options));
}

async function runSmokeCheckInner(
  worktreePath: string,
  check: SmokeCheck,
  options?: RunSmokeCheckOptions,
): Promise<SmokeCheckResult> {
  const timeoutSeconds = options?.timeoutSeconds ?? 60;
  const pollIntervalSeconds = options?.pollIntervalSeconds ?? 2;
  const requestTimeoutMs = options?.requestTimeoutMs ?? 4000;
  const snippetLength = options?.snippetLength ?? 600;

  const isWindows = process.platform === "win32";
  const shell = isWindows ? "cmd.exe" : "/bin/sh";
  const shellArgs = isWindows ? ["/c", check.devCommand] : ["-c", check.devCommand];

  const proc = spawn(shell, shellArgs, {
    cwd: worktreePath,
    env: { ...process.env },
    windowsHide: true,
    // POSIX: own process group so we can kill the whole tree via the negative pid.
    detached: !isWindows,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let serverLog = "";
  const captureLog = (chunk: Buffer) => {
    // Keep only a bounded tail so a chatty dev server can't balloon memory.
    serverLog = (serverLog + chunk.toString()).slice(-4000);
  };
  proc.stdout?.on("data", captureLog);
  proc.stderr?.on("data", captureLog);

  let exited = false;
  let exitCode: number | null = null;
  proc.on("exit", (code) => {
    exited = true;
    exitCode = code;
  });

  const deadline = Date.now() + timeoutSeconds * 1000;
  let last: { status: number; body: string } = { status: 0, body: "" };

  try {
    while (Date.now() < deadline) {
      // If the dev server process died, there is no point polling further.
      if (exited) {
        return {
          passed: false,
          skipped: false,
          status: 0,
          message: `Dev server "${check.devCommand}" exited before serving (code ${exitCode ?? "?"}). Server output: ${snippet(serverLog, 400)}`,
          bodySnippet: snippet(serverLog, snippetLength),
        };
      }

      last = await probe(check.healthUrl, requestTimeoutMs);
      if (last.status === 200 && bodyAssertionsPass(last.body, check.expectBodyContains)) {
        return {
          passed: true,
          skipped: false,
          status: 200,
          message: `Smoke check passed: ${check.healthUrl} returned 200${check.expectBodyContains.length ? ` and rendered expected content (${check.expectBodyContains.join(", ")})` : ""}.`,
          bodySnippet: snippet(last.body, snippetLength),
        };
      }

      await new Promise((r) => setTimeout(r, pollIntervalSeconds * 1000));
    }

    // Timed out. Distinguish "never reachable" from "reachable but failed assertions".
    if (last.status === 0) {
      return {
        passed: false,
        skipped: false,
        status: 0,
        message: `Smoke check timed out: ${check.healthUrl} never became reachable within ${timeoutSeconds}s. Server output: ${snippet(serverLog, 400)}`,
        bodySnippet: snippet(serverLog, snippetLength),
      };
    }
    if (last.status !== 200) {
      return {
        passed: false,
        skipped: false,
        status: last.status,
        message: `Smoke check failed: ${check.healthUrl} returned HTTP ${last.status} (expected 200).`,
        bodySnippet: snippet(last.body, snippetLength),
      };
    }
    return {
      passed: false,
      skipped: false,
      status: last.status,
      message: `Smoke check failed: ${check.healthUrl} returned 200 but the body was missing expected content (${check.expectBodyContains.join(", ")}).`,
      bodySnippet: snippet(last.body, snippetLength),
    };
  } finally {
    if (proc.pid && !exited) killTree(proc.pid);
  }
}

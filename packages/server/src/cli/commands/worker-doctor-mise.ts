/**
 * `worker doctor` check for mise (#1371): the one tool manager the board's install-on-request uses.
 * WARN, not fail: a worker that never takes install requests (`--toolchain-install=never`, the default)
 * does not need it, and doctor cannot see the daemon's flags. Probe injected like the git prereqs.
 */
import type { CheckStatus } from "./worker-doctor.js";
import type { ProbeFn } from "./worker-doctor-git-prereqs.js";

export async function checkMise(probe: ProbeFn): Promise<{ name: string; status: CheckStatus; detail: string; remedy?: string }> {
  const res = await probe("mise", ["--version"]);
  if (res.found && res.code === 0) return { name: "mise on PATH", status: "pass", detail: res.output.split("\n")[0]?.trim() || "mise present" };
  return {
    name: "mise on PATH",
    status: "warn",
    detail:
      "mise is not on PATH, so the board cannot have this worker install a project's missing toolchains " +
      "(--toolchain-install=ask|auto). There is no fallback to winget/apt; a project that needs a toolchain this machine lacks stays blocked.",
    remedy: "Install mise (https://mise.jdx.dev/getting-started.html), re-open the shell, and start the worker with --toolchain-install=ask",
  };
}

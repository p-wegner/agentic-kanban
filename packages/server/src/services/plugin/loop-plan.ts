import {
  parsePluginLoopPlan,
  substitutePluginEnv,
  substitutePluginPlaceholders,
  type PluginLoopDef,
  type PluginPlaceholderVars,
} from "@agentic-kanban/shared/lib/plugin-manifest";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { runPluginCommand, STRUCTURED_STDOUT_CAP } from "../plugin-exec.js";
import { PluginLoopError } from "./loop-identity.js";

/**
 * Running a loop's PLANNER — the one thing the plugin contributes to a loop, and the only place
 * the board reads a subprocess's stdout as DATA rather than as diagnostics.
 *
 * That distinction is the whole reason this is its own module: every failure mode here is about
 * getting the plan out of the subprocess intact and blaming the right party when it doesn't —
 * a timeout, a non-zero exit, and (#662) the truncation that used to masquerade as a malformed
 * plan and send the reader to the plugin's JSON when the output had been clipped on the way in.
 */

export const PLAN_TIMEOUT_MS = 2 * 60 * 1000;

export type LoopPlan = ReturnType<typeof parsePluginLoopPlan>;

export async function runLoopPlan(args: {
  loop: PluginLoopDef;
  vars: PluginPlaceholderVars;
  /** The OUTPUT repo — where `plan.cwd: "repo"` runs. */
  repoPath: string;
  pluginLocalPath: string;
}): Promise<LoopPlan> {
  const { loop, vars } = args;
  const result = await runPluginCommand(substitutePluginPlaceholders(loop.plan.command, vars), {
    // A planner defaults to the plugin's own checkout — that is where its
    // scripts live; it reads the TARGET through the substituted env/args.
    cwd: loop.plan.cwd === "repo" ? args.repoPath : args.pluginLocalPath,
    env: substitutePluginEnv(loop.plan.env, vars),
    timeoutMs: PLAN_TIMEOUT_MS,
    // A plan is stdout read as DATA, so it must not be tail-truncated: a clipped JSON document
    // fails to parse at every offset, and the error then blames the plugin's output format
    // instead of the clipping. Measured: a 24-module plan is ~23.5 KB, well past the 16 KB
    // diagnostics tail, so this silently broke every loop on a target with many modules.
    maxStdoutChars: STRUCTURED_STDOUT_CAP,
  });
  if (result.timedOut) {
    throw new PluginLoopError(`Loop "${loop.name}" plan command timed out after ${PLAN_TIMEOUT_MS / 1000}s`);
  }
  if (result.code !== 0) {
    throw new PluginLoopError(
      `Loop "${loop.name}" plan command exited ${result.code}: ${(result.stderr || result.stdout).slice(-800)}`,
    );
  }
  try {
    return parsePluginLoopPlan(result.stdout, { truncated: result.stdoutTruncated });
  } catch (err) {
    const base = errorMessage(err);
    // Never let a truncation masquerade as a malformed plan: that misdirects the reader to the
    // plugin's JSON when the output was clipped on the way in.
    throw new PluginLoopError(
      result.stdoutTruncated
        ? `${base}\n\nNOTE: the plan command's stdout exceeded ${STRUCTURED_STDOUT_CAP} characters and its FRONT was discarded, so the payload above is a fragment. The plugin's output is probably fine — raise the cap or make the planner emit less.`
        : base,
    );
  }
}

/**
 * Worker-side resolution of a launch spec's executable (#747).
 *
 * The board no longer decides how to invoke the agent binary on a machine it cannot see.
 * A cross-machine spec carries a {@link WorkerLaunchIntent} — the provider and the LOGICAL
 * program name — and this module turns that into the concrete `{ command, useShell }` for
 * THIS platform:
 *
 *  - **Windows**: prefer a real `.exe` (spawnable with `shell: false`, which keeps stdio
 *    piping and the detach-free contract). Otherwise take whatever `where` returns; a
 *    `.cmd`/`.bat`/`.ps1` shim is not executable by `CreateProcess`, so it needs
 *    `shell: true` — that is precisely the failure a Linux board caused by sending
 *    `useShell: false`.
 *  - **POSIX**: `execvp` resolves a bare program name against PATH, so the program name is
 *    the command and no shell is needed. A board-resolved `C:\...\claude.exe` would have
 *    been ENOENT here — the other half of #747.
 *
 * A spec with NO intent is a same-filesystem (or legacy-board) assignment: it is used
 * verbatim, because there the board's own resolution is correct by construction.
 *
 * Resolution failure is NOT an error: the program name is returned as-is (with the
 * platform's shell default) so the spawn produces the real ENOENT the operator needs to
 * see, rather than a worker-invented one.
 */
import { execFileSync } from "node:child_process";
import type { WorkerLaunchSpec } from "@agentic-kanban/shared/lib/worker-protocol";

export interface ResolvedSpecCommand {
  command: string;
  useShell: boolean;
  /** Where the value came from — logged so a cross-OS launch is diagnosable. */
  source: "spec" | "resolved" | "unresolved";
}

/** Look a program up on PATH. Returns the first hit, or null. Never throws. */
export type ProgramLookup = (program: string) => string | null;

/**
 * Default lookup: `where` on Windows, `command -v` on POSIX. `windowsHide` because this
 * runs on every remote launch and a console flash steals focus.
 */
export function defaultProgramLookup(platform: NodeJS.Platform = process.platform): ProgramLookup {
  return (program: string) => {
    try {
      const out =
        platform === "win32"
          ? execFileSync("where", [program], { encoding: "utf8", windowsHide: true })
          : execFileSync("/bin/sh", ["-c", `command -v ${JSON.stringify(program)}`], {
              encoding: "utf8",
              // A no-op off Windows, but the #597 guard is blanket on purpose: the next
              // person to copy this call may not be on POSIX.
              windowsHide: true,
            });
      const first = out.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
      return first ?? null;
    } catch {
      return null;
    }
  };
}

/** A shim that Windows cannot spawn without a shell. */
function needsShell(resolved: string): boolean {
  return /\.(cmd|bat|ps1)$/i.test(resolved);
}

export interface ResolveSpecCommandOptions {
  platform?: NodeJS.Platform;
  lookup?: ProgramLookup;
}

/**
 * Resolve the command + shell decision for a spec on THIS machine.
 *
 * Pure with respect to the platform and the lookup, so the whole cross-OS matrix is
 * testable from either OS.
 */
export function resolveSpecCommand(
  spec: Pick<WorkerLaunchSpec, "command" | "useShell" | "intent">,
  options: ResolveSpecCommandOptions = {},
): ResolvedSpecCommand {
  const platform = options.platform ?? process.platform;
  const intent = spec.intent;
  if (!intent) {
    // Same-filesystem / legacy assignment: the board's own machine IS this machine (or an
    // older board that never learned to express intent). Use what it sent.
    return { command: spec.command, useShell: spec.useShell ?? false, source: "spec" };
  }
  const lookup = options.lookup ?? defaultProgramLookup(platform);
  if (platform === "win32") {
    const exe = lookup(`${intent.program}.exe`);
    if (exe) return { command: exe, useShell: false, source: "resolved" };
    const any = lookup(intent.program);
    if (any) return { command: any, useShell: needsShell(any), source: "resolved" };
    // Nothing found: a bare name plus a shell is the only form that can still hit a
    // `.cmd` shim that `where` could not see (e.g. a shell alias/function).
    return { command: intent.program, useShell: true, source: "unresolved" };
  }
  const found = lookup(intent.program);
  return found
    ? { command: found, useShell: false, source: "resolved" }
    : { command: intent.program, useShell: false, source: "unresolved" };
}

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { DoctorCheck } from "./worker-doctor.js";

/**
 * Check 6 — has the operator trusted this machine's worker checkouts? (#851)
 *
 * A worker clones each project into `<work-root>/repos/<projectId>` and carves per-session
 * worktrees out of it, so that directory HAS NEVER BEEN OPENED INTERACTIVELY — by
 * construction. Claude Code therefore prints, on every dispatch to a new worker/project
 * pair:
 *
 *   Ignoring N permissions.allow entries from .claude/settings.json ...:
 *   this workspace has not been trusted.
 *
 * WHAT THIS IS AND IS NOT. The worker launches the agent in `bypassPermissions`, and the
 * session transcript from the first real cross-machine dispatch (`c63965b3`) shows zero
 * permission denials, zero prompts, and all 65 PreToolUse hook events firing normally — the
 * real guardrails were active throughout. So the discarded ALLOW list costs nothing and this
 * is a recurring confusing banner, not a security bypass. What it would cost, on a project
 * that defines `deny`/`ask` rules, is those rules — dropped the same silent way. Nothing
 * here defines any today, which is why the check names which case it found rather than
 * warning flatly, and why it is `unknown` rather than `fail`: a doctor that exits non-zero
 * over a cosmetic banner is the #847 defect again.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: write `hasTrustDialogAccepted` itself. That would make
 * the banner vanish by routing around a security control — the board granting trust, on a
 * machine it deliberately holds no credentials for (decision 012), to code it just pushed
 * there. It would also only make the run PERMITTED, never more CORRECT. The decision stays
 * with this machine's operator; the doctor's job is to tell them it is theirs to make.
 *
 * Lives in its own module rather than `worker-doctor.ts` because that file sits at the
 * god-module gate's 20-declaration ceiling (#889) — same reason as
 * worker-doctor-node-check.ts and worker-doctor-provider-auth.ts.
 */
export function checkWorkerCheckoutTrust(workRoot: string, home: string): DoctorCheck {
  const name = "worker checkouts trusted";
  const reposDir = join(workRoot, "repos");
  let projectDirs: string[];
  try {
    projectDirs = readdirSync(reposDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(reposDir, e.name));
  } catch {
    return {
      name,
      status: "skip",
      detail: `${reposDir} does not exist yet — this machine has not been dispatched any git work, so there is no checkout to trust`,
    };
  }
  if (projectDirs.length === 0) {
    return { name, status: "skip", detail: `${reposDir} holds no project clone yet — nothing to trust` };
  }

  // Claude Code reads .claude.json from CLAUDE_CONFIG_DIR, not from the home directory — and a
  // fleet worker ALWAYS has that pinned (a Scheduled Task inherits nothing). Reading only
  // ~/.claude.json made the check name a file the agent does not read: it looked right whenever
  // both files happened to agree, and flipped to a false PASS the moment an operator followed
  // the remedy, while every dispatch kept printing the banner. A check that becomes wrong
  // precisely when you obey it is worse than no check.
  //
  // The doctor cannot always observe the env the DISPATCHED agent gets (it may run from a
  // different shell), so it consults every candidate and requires them ALL to grant trust. A
  // false FAIL costs a confusing message; a false PASS costs the operator their fix.
  // Only files that EXIST count — a machine with a single config must not fail because a
  // candidate path it never uses is absent.
  const allCandidates = resolveTrustConfigPaths(home);
  const present = allCandidates.filter((path) => existsSync(path));
  const trustCandidates = present.length > 0 ? present : allCandidates.slice(0, 1);
  const grantedBy = trustCandidates.map((path) => ({ path, trusted: readTrustedProjectPaths(path) }));
  const untrusted = projectDirs.filter((dir) =>
    grantedBy.some(({ trusted }) => !trusted.has(normalizeTrustKey(dir))),
  );
  const consulted = trustCandidates.join(", ");
  if (untrusted.length === 0) {
    return { name, status: "pass", detail: `all ${projectDirs.length} worker checkout(s) under ${reposDir} are trusted in ${consulted}` };
  }

  const described = untrusted.map((dir) => `${dir} (${describeLostRules(dir)})`);

  // Say WHICH config is the odd one out. Reporting a blanket absence across every consulted
  // file is false in the case an operator is most likely to be reading this in — halfway
  // through the fix, having granted trust in one file and not yet the other — and it sends
  // them to edit files that are already correct. Both sets are already computed above; naming
  // them is the only genuinely actionable fact this check holds.
  const lacking = grantedBy.filter(({ trusted }) => untrusted.some((dir) => !trusted.has(normalizeTrustKey(dir))));
  const granting = grantedBy.filter((g) => !lacking.includes(g));
  const lackingPaths = lacking.map((g) => g.path).join(", ");
  const where =
    granting.length > 0
      ? `are trusted in ${granting.map((g) => g.path).join(", ")} but NOT in ${lackingPaths}`
      : `have no hasTrustDialogAccepted entry in ${lackingPaths}`;

  return {
    name,
    status: "unknown",
    detail:
      `${untrusted.length} of ${projectDirs.length} worker checkout(s) ${where}, so every dispatch into them prints ` +
      '"this workspace has not been trusted" and ' +
      `drops that repo's permission settings: ${described.join("; ")}. The agent still runs either way — the worker ` +
      "launches it with permissions bypassed and the PreToolUse hooks fire regardless.",
    remedy:
      "If you want the banner gone (and any deny/ask rules honoured), THIS MACHINE'S OPERATOR grants the trust — the " +
      "board never will: run Claude Code interactively once in each directory above and accept the trust dialog, or set " +
      `projects["<that path, forward slashes>"].hasTrustDialogAccepted: true in ${lackingPaths}. ` +
      "Every config Claude Code might read here has to agree, because CLAUDE_CONFIG_DIR decides which one the agent " +
      "actually gets and a worker always has it pinned.",
  };
}

/** Trust keys are written with forward slashes and vary in case on Windows. */
function normalizeTrustKey(p: string): string {
  const slashed = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? slashed.toLowerCase() : slashed;
}

/**
 * Every `.claude.json` Claude Code might read on this machine, most authoritative first:
 * `$CLAUDE_CONFIG_DIR/.claude.json` when that is set (what a dispatched worker agent uses),
 * then the `~/.claude/` and `~/` defaults. Deduplicated, order preserved.
 */
export function resolveTrustConfigPaths(home: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const paths: string[] = [];
  const configDir = env.CLAUDE_CONFIG_DIR?.trim();
  if (configDir) paths.push(join(configDir, ".claude.json"));
  paths.push(join(home, ".claude", ".claude.json"));
  paths.push(join(home, ".claude.json"));
  return [...new Set(paths)];
}

/** The project paths `~/.claude.json` records as trusted. Never throws. */
export function readTrustedProjectPaths(claudeJsonPath: string): Set<string> {
  const out = new Set<string>();
  try {
    const parsed = JSON.parse(readFileSync(claudeJsonPath, "utf8")) as {
      projects?: Record<string, { hasTrustDialogAccepted?: unknown }>;
    };
    for (const [key, value] of Object.entries(parsed.projects ?? {})) {
      if (value && value.hasTrustDialogAccepted === true) out.add(normalizeTrustKey(key));
    }
  } catch {
    /* absent or corrupt — treat as "nothing is trusted", which is the safe read */
  }
  return out;
}

/**
 * Does this repo actually LOSE anything when its settings are ignored?
 *
 * A shallow count of `permissions.deny` / `permissions.ask` in the checkout's two settings
 * files — deliberately NOT a settings parser: no merge order, no precedence, no rule
 * semantics. It only has to separate "there are restrictive rules here that would be
 * dropped" from "allow-only, so this is cosmetic", and for that a count is enough.
 */
function describeLostRules(repoDir: string): string {
  let restrictive = 0;
  let read = false;
  for (const file of ["settings.json", "settings.local.json"]) {
    try {
      const parsed = JSON.parse(readFileSync(join(repoDir, ".claude", file), "utf8")) as {
        permissions?: { deny?: unknown[]; ask?: unknown[] };
      };
      read = true;
      restrictive += (parsed.permissions?.deny?.length ?? 0) + (parsed.permissions?.ask?.length ?? 0);
    } catch {
      /* absent or unreadable — contributes nothing */
    }
  }
  if (!read) return "no .claude settings found, so nothing is being dropped";
  return restrictive > 0
    ? `${restrictive} deny/ask rule(s) here WOULD be dropped — worth acting on`
    : "allow-only settings, so the effect is a confusing banner and nothing more";
}

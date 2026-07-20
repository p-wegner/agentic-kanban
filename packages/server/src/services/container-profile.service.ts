import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * A minimal, board-owned Claude profile directory for containerized builders (#133),
 * plus the transcript mount that keeps their sessions inspectable (#134 and the
 * compounding-engineering loop).
 *
 * WHAT THIS REPLACES. The working recipe bind-mounted the host's entire `~/.claude`
 * read-write: ~551 MB, 4,800+ files, including every other profile's OAuth
 * credentials and 3,098 past session transcripts. An agent inside the container
 * could read or overwrite all of it. That gives back most of the isolation
 * containerization is supposed to buy (decision 011 treats agent code as
 * host-root-equivalent precisely because such holes exist), so `devcontainer_builders`
 * shipped OFF. This narrows the mount to the handful of files a builder needs.
 *
 * CREDENTIAL POLICY (the decision #133 asks for, made explicitly).
 * Auth is an OAuth session, not a static key: `.credentials.json` holds an access
 * token (~24h) and a refresh token (~16d), and refreshing REWRITES the file. So a
 * read-only mount cannot work, and a single-file bind mount is fragile because the
 * refresh replaces the inode by atomic rename.
 *
 * The policy is: ONE board-owned directory PER SOURCE PROFILE, holding copies of
 * only the auth/config files, mounted read-write, and RESEEDED from the host
 * profile on every provision.
 *
 *  - Per source profile, not per workspace: containers sharing a profile must share
 *    one credentials file, or each would refresh independently against the same
 *    upstream session. Different profiles (subscription rotation) stay isolated,
 *    which is what rotation requires.
 *  - Reseeded per provision: bounds divergence between the host profile and the
 *    container's copy to a single session's lifetime.
 *  - RESIDUAL RISK, stated plainly rather than papered over: the container refreshes
 *    against its COPY. If the upstream rotates refresh tokens on use, the host's
 *    copy can go stale and need a re-login. This is the accepted cost of not giving
 *    the agent write access to the live credential file; it is why the reseed exists
 *    and why this stays behind an off-by-default setting.
 */

/** Files copied into the narrow profile. Everything else in `~/.claude` stays out. */
const PROFILE_FILES = [
  // The OAuth session. Without it the agent is unauthenticated.
  ".credentials.json",
  // User-level config the CLI reads. Also an auth marker for profile-health checks.
  "settings.json",
  /**
   * #134: `.claude.json` lives at `~/.claude.json`, a SIBLING of `~/.claude`, so
   * mounting the profile directory never carried it in and every containerized turn
   * printed `Claude configuration file not found at: /home/node/.claude.json` to
   * stderr before any JSON — exactly the unstructured-preamble class that has broken
   * stream-json parsing before. Seeding it INSIDE the profile dir fixes it, because
   * the launch sets CLAUDE_CONFIG_DIR to that dir and the CLI then looks for
   * `<CLAUDE_CONFIG_DIR>/.claude.json` instead of `$HOME/.claude.json`.
   */
  ".claude.json",
] as const;

export interface ContainerProfile {
  /** Host directory to bind-mount as the container's Claude config dir. */
  hostDir: string;
  /** Files actually seeded (present in the source), for logging/diagnostics. */
  seeded: string[];
}

/** Where board-owned container profiles live. Outside the repo, alongside the DB. */
export function containerProfileRoot(stateDir?: string): string {
  return join(stateDir ?? join(homedir(), ".agentic-kanban"), "container-profiles");
}

/**
 * Seed (or reseed) the narrow profile directory for a source profile and return it.
 *
 * Best-effort by the same contract as the rest of provisioning: if the source has no
 * credentials there is nothing to copy, and the caller decides whether to proceed.
 */
export function provisionContainerProfile(opts: {
  /** The host profile dir to copy FROM — `~/.claude` or a `~/.claude-<name>` config dir. */
  sourceDir: string;
  /** Names the target directory. Use the profile/subscription name, or "default". */
  profileKey: string;
  /** When set, also seed `settings_<name>.json` for a settings-file profile. */
  settingsProfile?: string;
  /** Overridable for tests; defaults to the host user's home. */
  hostHome?: string;
  /** Overridable for tests; defaults to `~/.agentic-kanban`. */
  stateDir?: string;
}): ContainerProfile {
  const { sourceDir, profileKey, settingsProfile, hostHome = homedir(), stateDir } = opts;

  const hostDir = join(containerProfileRoot(stateDir), sanitizeProfileKey(profileKey));
  mkdirSync(hostDir, { recursive: true });

  const seeded: string[] = [];
  for (const name of PROFILE_FILES) {
    // `.claude.json` may live inside the config dir (when CLAUDE_CONFIG_DIR is in
    // use) or as a sibling of `~/.claude` (the default layout) — prefer the former.
    const candidates =
      name === ".claude.json" ? [join(sourceDir, name), join(hostHome, name)] : [join(sourceDir, name)];
    const source = candidates.find((candidate) => existsSync(candidate));
    if (!source) continue;
    try {
      copyFileSync(source, join(hostDir, name));
      seeded.push(name);
    } catch (err) {
      console.warn(`[devcontainer] could not seed ${name} into the container profile:`, err);
    }
  }

  if (settingsProfile) {
    const name = `settings_${settingsProfile}.json`;
    const source = join(sourceDir, name);
    if (existsSync(source)) {
      try {
        copyFileSync(source, join(hostDir, name));
        seeded.push(name);
      } catch (err) {
        console.warn(`[devcontainer] could not seed ${name} into the container profile:`, err);
      }
    }
  }

  return { hostDir, seeded };
}

/** Volume/dir names must not be able to escape the profile root. */
function sanitizeProfileKey(profileKey: string): string {
  const slug = profileKey.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^[-.]+|-+$/g, "");
  return slug.length > 0 ? slug : "default";
}

/**
 * Claude's project-directory name encoding: `:`, `\` and `/` all become `-`.
 * Mirrors `butler-transcripts.service.ts`, which reads transcripts back out.
 */
export function encodeTranscriptCwd(cwd: string): string {
  return cwd.replace(/[:\\/]/g, "-");
}

/**
 * The host directory Claude would write this worktree's transcripts into, created if
 * absent so it can be bind-mounted.
 */
export function hostTranscriptDir(worktreePath: string, hostHome: string = homedir()): string {
  const dir = join(hostHome, ".claude", "projects", encodeTranscriptCwd(worktreePath));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * The transcript mount that keeps a containerized builder's sessions readable by
 * `session-inspector`, `fleet-analysis` and the board's own transcript readers.
 *
 * Narrowing the profile mount moves CLAUDE_CONFIG_DIR, and Claude writes transcripts
 * under `<config>/projects/<encoded-cwd>/`. Left alone, a containerized builder's
 * transcripts would land in the board-owned profile dir under the CONTAINER's cwd
 * encoding — invisible to every existing reader, which resolves
 * `~/.claude/projects/<host-cwd-encoding>/`. Those sessions are the input to the
 * compounding-engineering loop, so losing them is a real regression, not cosmetic.
 *
 * Mapping the container's transcript directory ONTO the host's real one for the same
 * worktree fixes it without a copy-out step: transcripts stream to the host live, so
 * even a container that is killed leaves its transcript behind. It also stays within
 * #133's intent — the agent sees only its OWN worktree's transcripts, not the 3,098
 * files the whole-profile mount exposed.
 */
export function transcriptMount(opts: {
  worktreePath: string;
  /** The worktree's path INSIDE the container. */
  remoteWorkspaceFolder: string;
  /** The container's CLAUDE_CONFIG_DIR. */
  containerConfigDir: string;
  hostHome?: string;
}): { source: string; target: string } {
  const { worktreePath, remoteWorkspaceFolder, containerConfigDir, hostHome } = opts;
  return {
    source: hostTranscriptDir(worktreePath, hostHome).replace(/\\/g, "/"),
    target: `${containerConfigDir}/projects/${encodeTranscriptCwd(remoteWorkspaceFolder)}`,
  };
}

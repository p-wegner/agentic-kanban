/**
 * Worker-side profile ATTESTATION and profile RESOLUTION (#1027).
 *
 * Two jobs, one module, because they are the two halves of a single promise:
 *
 *  1. **Attest** — tell the board, by NAME, which agent profiles this machine can
 *     authenticate as, with the role each of those profiles declares for itself and its
 *     current quota. That is what lets a profile-restricted project dispatch here at all;
 *     without it #651's blanket refusal stands and this machine simply never gets that
 *     work.
 *  2. **Resolve** — when an assign names profile `anth`, turn that into the concrete
 *     env/argv for THIS machine, or REJECT the assignment. Never a fallback to "whatever
 *     account this box is logged into": running the wrong client's subscription is the
 *     failure the restriction exists to prevent, and it is worse than not running.
 *
 * ## Nothing secret leaves
 *
 * An attestation is names, roles and percentages. The tokens are read HERE, by this
 * machine, for one request each to the usage endpoint (`oauth-quota-core.ts` — literally
 * the board's own reader, so the board and the worker cannot disagree about what
 * "exhausted" means), and never travel. Decision 012 is untouched: the board still sends
 * no credentials, and the worker still sends none back.
 *
 * ## Declared vs discovered
 *
 * `--profiles anth,team5x` is narrowed to what discovery can actually FIND, exactly as
 * `--providers` is narrowed by `attestProviders` (#895): an operator declaring a profile
 * this machine does not hold would otherwise attract work that then gets rejected at
 * assign time, which is a slower and more confusing version of the same refusal. With no
 * `--profiles` flag the discovered set IS the attestation, and `--profiles none` opts out
 * entirely (the machine then behaves exactly as a protocol-1 worker: it attests nothing
 * and restricted projects do not reach it).
 */
import {
  discoverLocalProfiles,
  findLocalProfile,
  localProfileLaunchAdjustment,
  type LocalProfile,
} from "../lib/local-profile-discovery.js";
import { readProfileAttributes } from "../lib/profile-attributes.js";
import {
  OAuthQuotaPoller,
  quotaReadingOf,
  type OAuthProfileRef,
} from "../lib/oauth-quota-core.js";
import type {
  WorkerLaunchSpec,
  WorkerProfileAttestation,
} from "@agentic-kanban/shared/lib/worker-protocol";

/** `--profiles none` — an explicit "attest nothing", distinct from "flag absent". */
export const PROFILES_OPT_OUT = "none";

/** Prefix on the `assign_failed` a rejected profile produces. Board-side classifier pins it. */
export const PROFILE_UNKNOWN_PREFIX = "unknown agent profile";

export interface WorkerProfileAttestorOptions {
  /**
   * The `--profiles` value, already split. `undefined` = the flag was absent, so the
   * discovered set is attested; `["none"]` = opt out; anything else is narrowed to what
   * discovery finds.
   */
  declared?: string[];
  /** Override the home dir — the seam tests use, and a service install with its own HOME. */
  home?: string;
  log?: (line: string) => void;
  /** Injected for tests. Passed straight to the shared poller. */
  fetchImpl?: typeof fetch;
}

export interface WorkerProfileAttestor {
  /**
   * The attestation as it stands, including the newest quota reading. `nowMs` is the
   * tick's time (CLAUDE.md `nowMs?: number` convention); production callers pass nothing.
   */
  current(nowMs?: number): WorkerProfileAttestation[];
  /**
   * ONE quota tick: at most one upstream request, round-robin over the due profiles. Called
   * from the heartbeat, which is why it must stay one request — a worker holding five
   * logins would otherwise burst five times a minute against a shared rate budget.
   */
  refreshQuota(nowMs?: number): Promise<void>;
}

/**
 * Which of this machine's profiles even HAS an OAuth token to measure.
 *
 * A `settings_<name>.json` (API-key) profile holds no OAuth session, so there is nothing
 * to read and no request to spend — the same exclusion the board's `listOAuthProfiles`
 * makes. Such a profile is still attested; it simply reports no quota, which downstream
 * reads as `unknown` and therefore keeps it usable rather than dropping it.
 */
export function quotaPollableProfiles(profiles: readonly LocalProfile[]): OAuthProfileRef[] {
  return profiles
    .filter((p) => p.kind === "claude-config-dir")
    .map((p) => ({ profile: p.name, configDir: p.path }));
}

/**
 * Narrow a declared `--profiles` list to what this machine actually holds, logging one
 * line per exclusion. `undefined` (no flag) attests everything discovered.
 */
export function narrowDeclaredProfiles(
  discovered: readonly LocalProfile[],
  declared: string[] | undefined,
  log: (line: string) => void,
): LocalProfile[] {
  if (declared === undefined) return [...discovered];
  const wanted = declared.map((d) => d.trim()).filter(Boolean);
  if (wanted.length === 1 && wanted[0].toLowerCase() === PROFILES_OPT_OUT) return [];
  const out: LocalProfile[] = [];
  for (const name of wanted) {
    const match = discovered.find((p) => p.name === name);
    if (match) {
      out.push(match);
      continue;
    }
    log(
      `[worker] NOT attesting profile '${name}': no local login carries that name. A project ` +
        `restricted to it will not be dispatched here (run 'agentic-kanban-worker doctor' for detail).`,
    );
  }
  return out;
}

export function createWorkerProfileAttestor(
  options: WorkerProfileAttestorOptions = {},
): WorkerProfileAttestor {
  const log = options.log ?? ((line: string) => console.log(line));
  const attested = narrowDeclaredProfiles(discoverLocalProfiles(options.home), options.declared, log);
  const pollable = quotaPollableProfiles(attested);
  const poller = new OAuthQuotaPoller({
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    log: (line) => log(`[worker][quota] ${line}`),
  });
  const configDirOf = new Map(pollable.map((p) => [p.profile, p.configDir]));

  return {
    current(nowMs: number = Date.now()): WorkerProfileAttestation[] {
      return attested.map((profile) => {
        // The role is a property of the ACCOUNT, read from the profile's own carrier by the
        // one shared reader (#1024) — so a `forbidden` account is forbidden on every machine
        // the login exists on, not only on the board.
        const attributes = readProfileAttributes(profile.provider, profile.name, {
          ...(options.home ? { home: options.home } : {}),
        });
        const dir = configDirOf.get(profile.name);
        const reading = dir ? quotaReadingOf(poller.record(dir), nowMs) : undefined;
        return {
          provider: profile.provider,
          name: profile.name,
          role: attributes.role,
          ...(attributes.dedicatedProject ? { dedicatedProject: attributes.dedicatedProject } : {}),
          ...(reading
            ? {
                quota: {
                  usedPct5h: reading.usedPct5h,
                  usedPct7d: reading.usedPct7d,
                  measuredAt: reading.measuredAt,
                  stale: reading.stale,
                },
              }
            : {}),
        };
      });
    },
    async refreshQuota(nowMs: number = Date.now()): Promise<void> {
      if (pollable.length === 0) return;
      await poller.refreshOne(pollable, nowMs);
    },
  };
}

/** A spec that may run here, or the reason it may not. */
export type ProfileResolution =
  | { ok: true; spec: WorkerLaunchSpec }
  | { ok: false; error: string };

/**
 * Apply the assign's requested profile to the spec, or refuse.
 *
 * A spec with no `intent.profile` passes through untouched — that is every launch the
 * board did not pin to a profile, i.e. every project without a roster, and it must stay
 * byte-for-byte what it was before this ticket.
 *
 * The refusal is the point of the ticket. An attestation can be stale (the login was
 * removed, renamed, or the daemon has been up since before it went away), and the only
 * two options at that moment are "reject and let the board re-place" and "run under some
 * other account". The second is the thing #651 refused remote dispatch to prevent.
 */
export function applyProfileToSpec(
  spec: WorkerLaunchSpec,
  options: { home?: string; log?: (line: string) => void } = {},
): ProfileResolution {
  const requested = spec.intent?.profile?.trim();
  if (!requested) return { ok: true, spec };
  const provider = spec.intent?.provider ?? "";
  const local = findLocalProfile(provider, requested, options.home);
  if (!local) {
    return {
      ok: false,
      error:
        `${PROFILE_UNKNOWN_PREFIX} '${requested}' (provider ${provider || "unknown"}): this worker has no ` +
        `local login by that name, so it cannot run the assignment under it. The attestation the board ` +
        `placed on is stale — re-check with 'agentic-kanban-worker doctor'.`,
    };
  }
  const adjustment = localProfileLaunchAdjustment(local);
  options.log?.(
    `[worker] launching under profile '${local.name}' (${local.kind}) from ${local.path}`,
  );
  return {
    ok: true,
    spec: {
      ...spec,
      env: { ...(spec.env ?? {}), ...adjustment.env },
      args: [...spec.args, ...adjustment.args],
    },
  };
}

/**
 * Hand-written types for `legacy-temp-prefixes.mjs`, per the `promote-plan.d.mts` /
 * `test-mine.d.mts` convention: the script is plain `.mjs` so it can run with no build step, and
 * its test lives in `packages/server`, which typechecks.
 */

/** A bare prefix shorter than this, with no hyphen, is too common to claim as ours. */
export declare const MIN_GENERIC_LENGTH: number;

/**
 * Is this bare prefix specific enough to claim? Rejects purely numeric fragments (which fall out
 * of `ak-<ticket>-something`) and short hyphen-free words like `plan`/`ws`/`fork`, whose bare
 * forms could belong to any tool on the machine.
 */
export declare function isClaimablePrefix(prefix: string | null | undefined): boolean;

/**
 * The bare `%TEMP%` prefixes this repo can PROVE it minted, derived from the `ak-<X>-` names it
 * mints today: a bare `<X>-` directory was minted by an older revision of that same call site.
 *
 * `rejected` is returned alongside so a caller can SHOW what it declined — a derivation that
 * silently narrows is one nobody can check.
 */
export declare function deriveLegacyPrefixes(root: string): {
  claimable: string[];
  rejected: string[];
};

/**
 * The derived prefix this entry name belongs to, or null. Matches both separators older call
 * sites used (`smoke-srv-00QDjs`, `impres_000abjgx`); a longer name that merely starts with the
 * same letters is NOT a match.
 */
export declare function matchLegacyPrefix(name: string, prefixes: readonly string[]): string | null;

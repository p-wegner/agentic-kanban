/**
 * The two boundary mappers between a `ProfileSelection` and the legacy bare profile
 * string (#528).
 *
 * `ProfileSelection` is the only profile carrier inside the server now. Two places still
 * speak the old string, and both are genuine boundaries rather than leftovers:
 *
 *   - the `workspaces.claude_profile` COLUMN (renaming it is out of scope), and
 *   - the `claudeProfile` field on the workspace API DTO, marked `@deprecated`.
 *
 * Everything between them goes through `{provider, name}`. These two functions are how
 * the edges convert, so the mapping exists once instead of being re-derived per call site.
 *
 * ## The column is provider-agnostic despite its name
 *
 * `profileNameOf` deliberately does NOT filter on provider. The reader
 * (`applyWorkspaceAgentSelection`) treats `workspaces.claude_profile` as "this
 * workspace's profile name, whatever its provider" and re-tags it with the workspace's
 * own provider on the way out. The writers disagreed with that: several did
 *
 *     claudeProfile: provider === "claude" ? profileName : undefined
 *
 * and then wrote the result unconditionally, so saving a codex/copilot/pi workspace
 * NULLED the column. On the next launch the reader found nothing and fell back to the
 * board's current default for that provider — i.e. a workspace pinned to a specific
 * codex license silently drifted off it, with no error and nothing in the log.
 *
 * Provider-tagging belongs on the way OUT of the column (`toProfileSelection`), not on
 * the way in.
 *
 * PURE and client-safe: type-only import, no node builtins.
 */
import type { ProfileSelection } from "../types/api/common.js";
import { narrowProvider } from "./provider-traits.js";

/**
 * Column/DTO string -> tagged selection. `provider` is the workspace's own provider;
 * an unknown one narrows to claude, matching every other provider read in the codebase.
 */
export function toProfileSelection(
  provider: string | null | undefined,
  name: string | null | undefined,
): ProfileSelection | undefined {
  return name ? { provider: narrowProvider(provider), name } : undefined;
}

/**
 * Tagged selection -> column/DTO string. `null` (not `undefined`) because both consumers
 * are nullable columns/fields, and an explicit null is what clears one.
 */
export function profileNameOf(selection: ProfileSelection | null | undefined): string | null {
  return selection?.name ?? null;
}

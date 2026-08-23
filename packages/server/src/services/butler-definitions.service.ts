/**
 * Butler definitions — facade.
 *
 * #819 split this module in two along a consumer-verified seam:
 *  - `butler-definitions/definitions-store.ts` — CRUD over the global
 *    `butler_definitions` preference (12 declarations).
 *  - `butler-definitions/launch-config.ts` — resolving how a butler launches:
 *    provider, profile, backend, model, resume id (9 declarations).
 *
 * The seam argument, and what it costs, is in `launch-config.ts`'s header. This file
 * re-exports both halves so no call site changed in the splitting commit; a NEW call
 * site should import the half it actually needs.
 */
export {
  type ButlerDefinition,
  MAX_BUTLERS,
  DEFAULT_BUTLER,
  ButlerDefinitionError,
  listButlerDefinitions,
  getButlerDefinition,
  createButlerDefinition,
  updateButlerDefinition,
  deleteButlerDefinition,
} from "./butler-definitions/definitions-store.js";

export {
  type ButlerLaunchConfig,
  butlerProfilePrefKey,
  resolveButlerLaunchConfig,
} from "./butler-definitions/launch-config.js";

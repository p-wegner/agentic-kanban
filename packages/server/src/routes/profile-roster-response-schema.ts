/**
 * The zod RESPONSE schema for `GET /api/profile-roster` (#1028).
 *
 * The house convention is that a response contract is a hand-authored interface in
 * `shared/src/types/api/` applied with `satisfies` — zod on the server has so far been for
 * request bodies only. That convention is kept: `ProfileRosterResponse` in shared is still
 * the single declaration of the shape, and the client imports it as a type.
 *
 * This adds a runtime check ON TOP, for the one property `satisfies` cannot give: this
 * payload is not assembled from literals a typechecker can see through. It is a join of a
 * filesystem walk over profile carriers, an HTTP quota reading that may be absent or stale,
 * and a resolver result — three sources that produce `null`/`undefined` at runtime in
 * places the types say they do not. A `satisfies` on such an object is only as true as the
 * weakest `as` in the chain that fed it.
 *
 * `.strict()` deliberately, and only here: this schema is written from the shared interface
 * in the same commit, so an extra key means the two have drifted, which is exactly what a
 * response check is for. (The CLIENT-side registry is `.passthrough()` by construction for
 * the opposite reason — there, stripping unknown keys would be data loss.)
 */
import { z } from "zod";

const profileRole = z.enum(["pool", "reserve", "forbidden"]);

const quota = z.object({
  status: z.enum(["ok", "auth", "error", "unknown", "none"]),
  usedPct5h: z.number().nullable(),
  usedPct7d: z.number().nullable(),
  resetAt5h: z.string().nullable(),
  measuredAt: z.string().nullable(),
  ageSeconds: z.number().nullable(),
  stale: z.boolean(),
}).strict();

const profile = z.object({
  id: z.string(),
  provider: z.string(),
  name: z.string(),
  role: profileRole,
  dedicatedProject: z.string().nullable(),
  roleObservedAt: z.string().nullable(),
  roleConflict: z.boolean(),
  conflictingRoles: z.array(profileRole),
  roleWarnings: z.array(z.string()),
  loggedIn: z.boolean(),
  inRing: z.boolean(),
  coolingUntil: z.string().nullable(),
  quota,
}).strict();

const projectEntry = z.object({
  id: z.string(),
  provider: z.string(),
  name: z.string(),
  role: profileRole,
  globalRole: profileRole,
}).strict();

const selection = z.object({
  profileId: z.string().nullable(),
  usedReserve: z.boolean(),
  reserveNote: z.string().nullable(),
  holdReason: z.string().nullable(),
  refused: z.boolean(),
  poolOrder: z.array(z.string()),
}).strict();

const project = z.object({
  projectId: z.string(),
  projectName: z.string().nullable(),
  entries: z.array(projectEntry),
  restricted: z.boolean(),
  closed: z.boolean(),
  malformed: z.boolean(),
  source: z.enum(["none", "allowed_profiles", "roster"]),
  reserveAllowed: z.boolean(),
  exhaustedPct: z.number(),
  selection,
}).strict();

export const profileRosterResponseSchema = z.object({
  profiles: z.array(profile),
  project: project.nullable(),
  quotaError: z.string().nullable(),
  roleHintCommand: z.string(),
  generatedAt: z.string(),
}).strict();

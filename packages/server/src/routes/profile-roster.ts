/**
 * `GET /api/profile-roster` (#1028) — the roster read model behind Settings → Agent and the
 * Monitor view's roster warnings.
 *
 * ONE endpoint rather than three, because the answer is a join: the observed roles (#1024),
 * the quota headroom (#1023) and the selection the roster would make (#1025) are only useful
 * together, and splitting them would let a UI render a role beside a headroom measured in a
 * different second. A thin adapter over `profile-roster-view.service.ts`, per the routes →
 * services layering.
 */
import type { Database } from "../db/index.js";
import { createRouter } from "../middleware/create-router.js";
import { buildProfileRosterView } from "../services/profile-roster-view.service.js";
import { profileRosterResponseSchema } from "./profile-roster-response-schema.js";

export function createProfileRosterRoute(database: Database) {
  const router = createRouter();

  // GET /api/profile-roster?projectId=<id>
  router.get("/", async (c) => {
    const projectId = c.req.query("projectId");
    const view = await buildProfileRosterView(database, { projectId });
    // Parsed, not asserted: this payload is a join of a filesystem walk, an HTTP quota
    // reading and a resolver result — three sources that produce runtime shapes a
    // `satisfies` cannot see through. See the schema module for why it is `.strict()`.
    return c.json(profileRosterResponseSchema.parse(view));
  });

  return router;
}

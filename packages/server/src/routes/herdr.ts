import { createRouter } from "../middleware/create-router.js";
import { getHerdrAvailability } from "../services/herdr-availability.service.js";

/**
 * herdr config discovery (#1144, part of the herdr-support epic #1129). herdr is
 * optional — see `herdr-availability.service.ts` for why it is not a
 * `PROVIDER_NAMES` entry. This route lets Settings/the CLI ask "is herdr usable
 * on this machine" without duplicating the probe logic.
 */
export function createHerdrRoute() {
  const router = createRouter();

  // GET /api/herdr/availability
  router.get("/availability", async (c) => {
    const availability = await getHerdrAvailability();
    return c.json(availability);
  });

  return router;
}

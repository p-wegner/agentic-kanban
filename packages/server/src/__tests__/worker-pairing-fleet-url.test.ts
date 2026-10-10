import { describe, it, expect } from "vitest";
import { describeFleetUrl } from "../routes/workers.js";

describe("describeFleetUrl (#1318)", () => {
  it("reports the loopback fleet URL when only the port is set", () => {
    const r = describeFleetUrl({ KANBAN_FLEET_PORT: "3103" } as NodeJS.ProcessEnv);
    expect(r.fleetUrl).toBe("http://127.0.0.1:3103");
    expect(r.fleetNote).toBeNull();
  });

  it("uses KANBAN_FLEET_HOST when named", () => {
    const r = describeFleetUrl({ KANBAN_FLEET_PORT: "3003", KANBAN_FLEET_HOST: "100.64.0.1" } as NodeJS.ProcessEnv);
    expect(r.fleetUrl).toBe("http://100.64.0.1:3003");
  });

  it("says the listener is disabled when no port is set", () => {
    const r = describeFleetUrl({} as NodeJS.ProcessEnv);
    expect(r.fleetUrl).toBeNull();
    expect(r.fleetNote).toContain("KANBAN_FLEET_PORT");
  });
});

// #848 — `worker list` against the fleet port 404s and blamed the board for being down
// while it was up. `GET /api/workers` is an owner route mounted only on the board's
// loopback app (see `routes/workers.ts` / `createFleetWorkersRoute`), so a 404 there means
// the URL answered but not with that route — not "unreachable". A real connection failure
// never reaches this function at all (fetch rejects before a status exists).
import { describe, expect, it } from "vitest";
import { describeWorkerListFailure } from "../cli/commands/worker.js";

describe("describeWorkerListFailure", () => {
  it("names the owner-route/loopback cause on 404, and does not ask if the board is running", () => {
    const message = describeWorkerListFailure(404, "http://100.105.24.76:3003");
    expect(message).toContain("404");
    expect(message).toContain("100.105.24.76:3003");
    expect(message).toContain("owner route");
    expect(message).toMatch(/loopback|board's own machine/);
    expect(message).not.toMatch(/is the board running/i);
  });

  it("keeps the original 'is the board running' framing for a non-404 failure", () => {
    const message = describeWorkerListFailure(500, "http://127.0.0.1:3001");
    expect(message).toContain("500");
    expect(message).toMatch(/is the board running/i);
  });
});

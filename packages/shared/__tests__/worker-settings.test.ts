import { describe, expect, it } from "vitest";
import {
  changedSettingKeys, parseWorkerSettings, parseWorkerSettingsEnvelope, parseWorkerSettingsReport, workerAllowsProject, workerBelowRamFloor,
} from "../src/lib/worker-settings.js";

describe("worker settings (#1381)", () => {
  it("drops ill-typed fields and out-of-range concurrency", () => {
    expect(parseWorkerSettings({ maxConcurrency: 0, labels: ["a", 3, " a "], drain: "yes", extra: 1 })).toEqual({ labels: ["a"] });
    expect(parseWorkerSettings({ maxConcurrency: 65 })).toEqual({});
    expect(parseWorkerSettings(null)).toEqual({});
  });

  it("an envelope needs a revision", () => {
    expect(parseWorkerSettingsEnvelope('{"rev":"r","settings":{"drain":true}}')).toEqual({ rev: "r", settings: { drain: true } });
    expect(parseWorkerSettingsEnvelope({ settings: {} })).toBeNull();
    expect(parseWorkerSettingsEnvelope("not json")).toBeNull();
  });

  it("a worker cannot claim to pin the board-enforced project lists", () => {
    expect(parseWorkerSettingsReport({ pinned: ["labels", "allowedProjects", "bogus"], appliedRev: "r" }))
      .toEqual({ pinned: ["labels"], appliedRev: "r" });
  });

  it("deny wins, an empty allow list means everyone", () => {
    expect(workerAllowsProject(undefined, "p").allowed).toBe(true);
    expect(workerAllowsProject({ allowedProjects: [] }, "p").allowed).toBe(true);
    expect(workerAllowsProject({ allowedProjects: ["q"] }, "p").allowed).toBe(false);
    expect(workerAllowsProject({ allowedProjects: ["p"], deniedProjects: ["p"] }, "p").allowed).toBe(false);
  });

  it("names the keys that changed", () => {
    expect(changedSettingKeys({ labels: ["a"] }, { labels: ["a"], drain: true })).toEqual(["drain"]);
  });

  it("minFreeRamGb: holds a worker under its floor, never one that has not reported (#1451)", () => {
    expect(parseWorkerSettings({ minFreeRamGb: 8 }).minFreeRamGb).toBe(8);
    expect(parseWorkerSettings({ minFreeRamGb: -1 }).minFreeRamGb).toBeUndefined();
    expect(workerBelowRamFloor({ minFreeRamGb: 8 }, 4)).toMatchObject({ below: true });
    expect(workerBelowRamFloor({ minFreeRamGb: 8 }, 8).below).toBe(false);
    expect(workerBelowRamFloor({ minFreeRamGb: 8 }, undefined).below).toBe(false);
    expect(workerBelowRamFloor({}, 1).below).toBe(false);
  });
});

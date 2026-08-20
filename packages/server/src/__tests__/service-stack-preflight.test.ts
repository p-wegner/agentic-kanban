import { describe, it, expect } from "vitest";
import {
  classifyDockerDeployment,
  runServiceStackPreflight,
} from "../startup/service-stack-preflight.js";

/**
 * #55: the boot preflight must make the silent DooD traps LOUD — an undialable
 * KANBAN_SERVICE_HOST and a daemon that can't see the data root — while never warning in
 * the correct configs (DinD with a proper service host, native local).
 */

describe("classifyDockerDeployment (#55 pure classifier)", () => {
  it("native: no DOCKER_HOST, no socket → localhost is fine, no warning", () => {
    const r = classifyDockerDeployment({ env: {}, socketPresent: false, containerized: false });
    expect(r.mode).toBe("native");
    expect(r.warnings).toEqual([]);
  });

  it("native: a host with a socket but NOT containerized → still native, no warning", () => {
    // A Linux board running directly on the host shares its namespace; localhost works.
    const r = classifyDockerDeployment({ env: { KANBAN_SERVICE_HOST: "localhost" }, socketPresent: true, containerized: false });
    expect(r.mode).toBe("native");
    expect(r.warnings).toEqual([]);
  });

  it("dind: DOCKER_HOST set + a proper service host → no warning", () => {
    const r = classifyDockerDeployment({
      env: { DOCKER_HOST: "tcp://dind:2375", KANBAN_SERVICE_HOST: "dind" },
      socketPresent: false,
      containerized: true,
    });
    expect(r.mode).toBe("dind");
    expect(r.warnings).toEqual([]);
  });

  it("dind: DOCKER_HOST set but KANBAN_SERVICE_HOST=localhost → warns (undialable)", () => {
    const r = classifyDockerDeployment({
      env: { DOCKER_HOST: "tcp://dind:2375", KANBAN_SERVICE_HOST: "localhost" },
      socketPresent: false,
      containerized: true,
    });
    expect(r.mode).toBe("dind");
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/network namespace|reach any stack/i);
  });

  it("dood: mounted socket + containerized + localhost → warns (the #55 trap)", () => {
    const r = classifyDockerDeployment({
      env: { IS_SANDBOX: "1" }, // no KANBAN_SERVICE_HOST → localhost
      socketPresent: true,
      containerized: true,
    });
    expect(r.mode).toBe("dood");
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/host\.docker\.internal|cannot dial/i);
  });

  it("dood: mounted socket + containerized + host.docker.internal → no config warning", () => {
    const r = classifyDockerDeployment({
      env: { KANBAN_SERVICE_HOST: "host.docker.internal" },
      socketPresent: true,
      containerized: true,
    });
    expect(r.mode).toBe("dood");
    expect(r.warnings).toEqual([]);
  });
});

describe("runServiceStackPreflight (#55 orchestration)", () => {
  const base = {
    dataRoot: "/data",
    hasEnabledStack: async () => true,
    isDockerAvailable: async () => true,
  };

  it("skips entirely when no project declares a stack", async () => {
    const warnings: string[] = [];
    const r = await runServiceStackPreflight({
      ...base,
      hasEnabledStack: async () => false,
      warn: (m) => warnings.push(m),
    });
    expect(r.ran).toBe(false);
    expect(warnings).toEqual([]);
  });

  it("skips when docker is unavailable", async () => {
    const r = await runServiceStackPreflight({ ...base, isDockerAvailable: async () => false, warn: () => {} });
    expect(r.ran).toBe(false);
  });

  it("dood + empty data root → emits BOTH the service-host and empty-mount warnings", async () => {
    const warnings: string[] = [];
    const r = await runServiceStackPreflight({
      ...base,
      env: { IS_SANDBOX: "1" }, // localhost + DooD
      socketPresent: true,
      containerized: true,
      probeDataRootVisible: async () => "empty",
      warn: (m) => warnings.push(m),
    });
    expect(r.mode).toBe("dood");
    // service-host warning + empty-mount warning + the summary line.
    expect(warnings.some((w) => /cannot dial/i.test(w))).toBe(true);
    expect(warnings.some((w) => /EMPTY directory/i.test(w))).toBe(true);
  });

  it("dood + visible data root + proper host → no warnings", async () => {
    const warnings: string[] = [];
    const r = await runServiceStackPreflight({
      ...base,
      env: { KANBAN_SERVICE_HOST: "host.docker.internal" },
      socketPresent: true,
      containerized: true,
      probeDataRootVisible: async () => "visible",
      warn: (m) => warnings.push(m),
    });
    expect(r.mode).toBe("dood");
    expect(warnings).toEqual([]);
  });

  it("dood + inconclusive probe → no false empty-mount warning", async () => {
    const warnings: string[] = [];
    await runServiceStackPreflight({
      ...base,
      env: { KANBAN_SERVICE_HOST: "host.docker.internal" },
      socketPresent: true,
      containerized: true,
      probeDataRootVisible: async () => "inconclusive",
      warn: (m) => warnings.push(m),
    });
    expect(warnings.some((w) => /EMPTY directory/i.test(w))).toBe(false);
  });

  it("native → never runs the data-root probe", async () => {
    let probed = false;
    const r = await runServiceStackPreflight({
      ...base,
      env: {},
      socketPresent: false,
      containerized: false,
      probeDataRootVisible: async () => {
        probed = true;
        return "empty";
      },
      warn: () => {},
    });
    expect(r.mode).toBe("native");
    expect(probed).toBe(false);
  });
});

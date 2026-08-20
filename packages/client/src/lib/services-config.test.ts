import { describe, it, expect } from "vitest";
import type { ServiceStackConfig } from "@agentic-kanban/shared";
import { buildServicesConfig, type ServicesConfigFormFields } from "./services-config.js";

function fields(partial: Partial<ServicesConfigFormFields> = {}): ServicesConfigFormFields {
  return {
    servicesEnabled: false,
    servicesComposeFile: "",
    servicesComposeRepo: "",
    servicesPorts: "",
    servicesConfigBase: null,
    ...partial,
  };
}

describe("buildServicesConfig", () => {
  it("builds the config from the form fields when there is no base config", () => {
    const cfg = buildServicesConfig(fields({
      servicesEnabled: true,
      servicesComposeFile: "docker/dev.yml",
      servicesComposeRepo: "infra",
      servicesPorts: "db, redis",
    }));
    expect(cfg).toEqual({
      enabled: true,
      composeFile: "docker/dev.yml",
      composeRepo: "infra",
      ports: ["db", "redis"],
    });
  });

  it("preserves API-only fields (env, readyTimeoutMs) from the last-fetched config", () => {
    const base: ServiceStackConfig = {
      enabled: true,
      composeFile: "docker-compose.yml",
      ports: ["db"],
      readyTimeoutMs: 300000,
      env: { POSTGRES_PASSWORD: "secret" },
    };
    const cfg = buildServicesConfig(fields({
      servicesEnabled: true,
      servicesComposeFile: "docker-compose.yml",
      servicesPorts: "db",
      servicesConfigBase: base,
    }));
    expect(cfg).toEqual({
      enabled: true,
      composeFile: "docker-compose.yml",
      ports: ["db"],
      readyTimeoutMs: 300000,
      env: { POSTGRES_PASSWORD: "secret" },
    });
  });

  it("form fields win over the base config", () => {
    const base: ServiceStackConfig = {
      enabled: true,
      composeFile: "old.yml",
      composeRepo: "old-repo",
      ports: ["old"],
      env: { KEEP: "me" },
    };
    const cfg = buildServicesConfig(fields({
      servicesEnabled: false,
      servicesComposeFile: "new.yml",
      servicesComposeRepo: "new-repo",
      servicesPorts: "db",
      servicesConfigBase: base,
    }));
    expect(cfg).toEqual({
      enabled: false,
      composeFile: "new.yml",
      composeRepo: "new-repo",
      ports: ["db"],
      env: { KEEP: "me" },
    });
  });

  it("drops composeRepo inherited from the base when the form field is emptied", () => {
    const base: ServiceStackConfig = {
      enabled: true,
      composeFile: "docker-compose.yml",
      composeRepo: "infra",
      ports: [],
    };
    const cfg = buildServicesConfig(fields({
      servicesEnabled: true,
      servicesComposeFile: "docker-compose.yml",
      servicesComposeRepo: "",
      servicesConfigBase: base,
    }));
    expect(cfg).not.toBeNull();
    expect(cfg).not.toHaveProperty("composeRepo");
  });

  it("defaults composeFile when enabled with an empty compose file field", () => {
    const cfg = buildServicesConfig(fields({ servicesEnabled: true }));
    expect(cfg?.composeFile).toBe("docker-compose.yml");
  });

  it("returns null (clear the stack) when disabled and every form field is empty", () => {
    expect(buildServicesConfig(fields())).toBeNull();
    // Explicitly clearing all fields clears the whole config, base included.
    expect(buildServicesConfig(fields({
      servicesConfigBase: { enabled: true, composeFile: "x.yml", env: { A: "b" } },
    }))).toBeNull();
  });
});

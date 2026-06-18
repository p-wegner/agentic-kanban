import { describe, it, expect } from "vitest";
import { PROVIDER_NAMES } from "../services/agent-provider/types.js";
import { getProvider } from "../services/agent-provider/registry.js";

/**
 * Locks the agent-provider PORT to its registry. The provider abstraction
 * (buildLaunchConfig / parseStreamEvent) is the strongest hexagonal seam in the
 * codebase; the registry is meant to be the ONLY module that names concrete
 * providers. This test fails if the ProviderName union and the registry drift —
 * e.g. a 5th provider added to the union but not registered, or vice versa.
 */
describe("agent-provider registry parity", () => {
  it("registry resolves every ProviderName to a provider whose name matches", () => {
    for (const name of PROVIDER_NAMES) {
      const provider = getProvider(name);
      expect(provider, `no provider registered for "${name}"`).toBeDefined();
      expect(provider.name, `provider for "${name}" reports a mismatched name`).toBe(name);
      // The port contract must be fully implemented.
      expect(typeof provider.buildLaunchConfig, `${name}.buildLaunchConfig missing`).toBe("function");
      expect(typeof provider.parseStreamEvent, `${name}.parseStreamEvent missing`).toBe("function");
    }
  });

  it("maps the legacy 'claude-code' provider id to the claude provider", () => {
    expect(getProvider("claude-code").name).toBe("claude");
  });

  it("defaults to the claude provider when no name is given", () => {
    expect(getProvider().name).toBe("claude");
    expect(getProvider(undefined).name).toBe("claude");
  });

  it("throws on an unknown provider name", () => {
    expect(() => getProvider("not-a-real-provider")).toThrow(/Unknown agent provider/);
  });
});

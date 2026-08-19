// @gate:always-run — scans services/ by path and reads the provider registry; imports the
// two provider-keyed tables it asserts over.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { PROVIDER_NAMES, type ProviderName } from "../services/agent-provider/types.js";
import { getProviderExitBehavior } from "../services/agent-provider/provider-exit-behavior.js";

/**
 * `provider-pair` — one module per agent provider, same export shape (#593).
 *
 * The board has a FOUR-provider registry (`claude`, `codex`, `copilot`, `pi`) and
 * TWO-provider adapters: `claude-rate-limit.ts`/`codex-rate-limit.ts` mirror three
 * functions each, `claude-login.service.ts`/`codex-login.service.ts` mirror one. Copilot
 * and pi simply have no counterpart, and nothing said whether that was a decision or an
 * omission — which is the actual defect. A missing adapter is fine; a missing adapter
 * nobody declared is how a provider silently gets second-class behaviour.
 *
 * `provider-exit-behavior.ts` already models this correctly and is the precedent: a
 * `Record<ProviderName, …>` the compiler forces to be exhaustive, with copilot and pi
 * given an explicit `makeNoopBehavior(…)` rather than being absent. So does
 * `auth-rotation-ring.ts`, whose header says it exists to write "identical logic once".
 *
 * This suite makes the remaining pairs declare themselves the same way: every provider is
 * either present for a capability or listed in `UNSUPPORTED` with a reason.
 */
const servicesDir = path.join(import.meta.dirname!, "..", "services");
const providerDir = path.join(servicesDir, "agent-provider");

interface Capability {
  name: string;
  /** Where a provider's module for this capability lives, given its name. */
  modulePath: (p: ProviderName) => string;
  /** Providers that deliberately have no module here, each with the reason. */
  unsupported: Partial<Record<ProviderName, string>>;
}

const CAPABILITIES: Capability[] = [
  {
    name: "provider adapter",
    modulePath: (p) => path.join(providerDir, `${p}-provider.ts`),
    unsupported: {},
  },
  {
    name: "usage-limit detection",
    modulePath: (p) => path.join(servicesDir, `${p}-rate-limit.ts`),
    unsupported: {
      copilot: "no published usage-limit banner to match; `EXIT_BEHAVIORS` gives it the explicit no-op detector",
      pi: "same — the no-op detector in `EXIT_BEHAVIORS` is the declaration",
    },
  },
  {
    name: "interactive login",
    modulePath: (p) => path.join(servicesDir, `${p}-login.service.ts`),
    unsupported: {
      copilot: "authenticated through the GitHub CLI, not a board-spawned OAuth window",
      pi: "no interactive login flow of its own",
    },
  },
];

describe("provider-pair parity (#593)", () => {
  it("the registry still lists exactly the four providers this suite reasons about", () => {
    // If a fifth is added, every table below must gain an entry — that is the point.
    expect([...PROVIDER_NAMES].sort()).toEqual(["claude", "codex", "copilot", "pi"]);
  });

  for (const cap of CAPABILITIES) {
    it(`every provider either HAS a "${cap.name}" module or is declared unsupported`, () => {
      const undeclared: string[] = [];
      for (const provider of PROVIDER_NAMES) {
        const exists = fs.existsSync(cap.modulePath(provider));
        const declared = provider in cap.unsupported;
        if (!exists && !declared) undeclared.push(provider);
      }
      expect(
        undeclared,
        `no ${cap.name} module for: ${undeclared.join(", ")}. Add one, or add an entry to ` +
          "this capability's `unsupported` map saying why it does not need one.",
      ).toEqual([]);
    });

    it(`no stale "${cap.name}" unsupported entry`, () => {
      // An `unsupported` entry that outlives the gap it describes is worse than none: it
      // permanently excuses a provider that has since grown the module.
      const stale = Object.keys(cap.unsupported).filter((p) =>
        fs.existsSync(cap.modulePath(p as ProviderName)),
      );
      expect(stale, `these now HAVE a ${cap.name} module — drop them from unsupported`).toEqual([]);
    });
  }

  it("every provider has an exit behaviour — no silent fallthrough", () => {
    // `EXIT_BEHAVIORS` is typed `Record<ProviderName, …>` so this is compile-enforced today.
    // Asserted at runtime too, because widening `ProviderName` without widening the table is
    // exactly the drift that left copilot and pi without adapters in the first place.
    for (const provider of PROVIDER_NAMES) {
      const behavior = getProviderExitBehavior(provider);
      expect(behavior, `no exit behaviour registered for ${provider}`).toBeTruthy();
      expect(behavior.provider).toBe(provider);
    }
  });
});

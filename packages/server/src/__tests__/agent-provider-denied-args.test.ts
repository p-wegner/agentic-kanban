import { describe, it, expect, vi, afterEach } from "vitest";

// Mock node:child_process / node:fs so importing the providers doesn't touch the
// real environment (mirrors agent-provider.test.ts).
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
  execSync: vi.fn(),
}));
vi.mock("node:fs", () => ({
  writeFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(),
}));

import {
  DENIED_ARGS,
  spliceAgentArgs,
  stripDeniedArgs,
} from "../services/agent-provider/helpers.js";
import { PiProvider } from "../services/agent-provider.js";

describe("per-provider denied-flag stripping (ticket #19 / arch-review §2.2)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("declares Pi's --approve as a denied flag (extensible data, not prose)", () => {
    expect(DENIED_ARGS.pi.some((d) => d.flag === "--approve")).toBe(true);
  });

  describe("spliceAgentArgs — Pi", () => {
    it("strips a bare `--approve` token and records a loud warning", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const result = spliceAgentArgs("pi", "--provider openai --approve --model gpt-5");
      expect(result).not.toContain("--approve");
      // Neighbouring, legitimate args survive.
      expect(result).toEqual(["--provider", "openai", "--model", "gpt-5"]);
      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0][0]);
      expect(message).toContain("--approve");
      expect(message).toContain("pi");
    });

    it("strips the `--approve=value` form", () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const result = spliceAgentArgs("pi", "--approve=always --skill C:/repo/SKILL.md");
      expect(result.some((t) => t.startsWith("--approve"))).toBe(false);
      expect(result).toEqual(["--skill", "C:/repo/SKILL.md"]);
    });

    it("strips only the flag for the `--approve <value>` form, NOT the following token (Pi's approve is valueless)", () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const result = spliceAgentArgs("pi", "--approve --skill C:/repo/SKILL.md");
      expect(result).not.toContain("--approve");
      // The unrelated trailing token must NOT be swallowed.
      expect(result).toEqual(["--skill", "C:/repo/SKILL.md"]);
    });

    it("strips multiple occurrences and warns for each", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const result = spliceAgentArgs("pi", "--approve --provider openai --approve=x");
      expect(result.some((t) => t.startsWith("--approve"))).toBe(false);
      expect(result).toEqual(["--provider", "openai"]);
      expect(warn).toHaveBeenCalledTimes(2);
    });

    it("passes a clean args list through unchanged and warns nothing", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const result = spliceAgentArgs("pi", "--provider openai --model gpt-5");
      expect(result).toEqual(["--provider", "openai", "--model", "gpt-5"]);
      expect(warn).not.toHaveBeenCalled();
    });

    it("returns an empty list for undefined/empty agentArgs", () => {
      expect(spliceAgentArgs("pi", undefined)).toEqual([]);
      expect(spliceAgentArgs("pi", "")).toEqual([]);
    });
  });

  describe("provider isolation — a denied list is scoped to its own provider", () => {
    it("does NOT strip Pi's --approve for a different provider (claude/codex/copilot)", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      for (const provider of ["claude", "codex", "copilot"]) {
        const result = spliceAgentArgs(provider, "--approve --model x");
        // Other providers have no denied list, so --approve passes through untouched.
        expect(result).toContain("--approve");
        expect(result).toEqual(["--approve", "--model", "x"]);
      }
      expect(warn).not.toHaveBeenCalled();
    });

    it("stripDeniedArgs is a no-op for a provider with no declared denied flags", () => {
      const tokens = ["--approve", "--foo"];
      expect(stripDeniedArgs("claude", tokens)).toBe(tokens);
    });
  });

  describe("PiProvider.buildLaunchConfig applies the strip in the spawn path", () => {
    it("never lets --approve reach Pi's argv even when passed via agentArgs", () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const config = new PiProvider().buildLaunchConfig({
        prompt: "Run",
        agentArgs: "--approve --provider openai",
      });
      expect(config.args).not.toContain("--approve");
      // The rest of the user args are preserved.
      expect(config.args).toContain("--provider");
      expect(config.args[config.args.indexOf("--provider") + 1]).toBe("openai");
    });
  });
});

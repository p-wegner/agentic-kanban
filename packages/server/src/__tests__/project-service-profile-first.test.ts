// #695 — the profile-first setup/verify script path had ZERO coverage.
//
// #521 changed both "generate script" buttons to consult the PERSISTED STACK PROFILE
// before asking a model. That mattered for two reasons at once: the button could
// otherwise hand back a different install command than registration had already written
// from the same repo, and it paid for an LLM call to produce the disagreement. Neither
// property was pinned by a test, so a refactor could restore either without anything
// going red.
//
// The load-bearing assertion in each case is the NEGATIVE one — that the AI generator is
// not called when the profile already answers. A test that only checked the returned
// string would still pass if the profile were consulted and then the model called anyway,
// which is precisely the regression worth catching.

import { beforeEach, describe, expect, it, vi } from "vitest";

const getProjectById = vi.fn();
const getStackProfile = vi.fn();
const deriveSetupScriptFromProfile = vi.fn();
const deriveVerifyScriptFromProfile = vi.fn();
const generateSetupScriptAI = vi.fn();
const generateVerifyScriptAI = vi.fn();

vi.mock("../repositories/project.repository.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getProjectById: (...args: unknown[]) => getProjectById(...args),
}));

vi.mock("../services/stack-profile.service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getStackProfile: (...args: unknown[]) => getStackProfile(...args),
  deriveSetupScriptFromProfile: (...args: unknown[]) => deriveSetupScriptFromProfile(...args),
  deriveVerifyScriptFromProfile: (...args: unknown[]) => deriveVerifyScriptFromProfile(...args),
}));

vi.mock("../services/project-setup.service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  generateSetupScript: (...args: unknown[]) => generateSetupScriptAI(...args),
  generateVerifyScript: (...args: unknown[]) => generateVerifyScriptAI(...args),
}));

const { createProjectService } = await import("../services/project.service.js");

const PROJECT_ID = "p-1";
const service = () => createProjectService({ database: {} as never });

beforeEach(() => {
  vi.clearAllMocks();
  getProjectById.mockResolvedValue({ id: PROJECT_ID, repoPath: "C:/repo", repoName: "repo" });
  getStackProfile.mockResolvedValue({ stack: "node" });
});

describe("generateSetupScript consults the stack profile before any model (#521/#695)", () => {
  it("returns the profile-derived command and never calls the AI generator", async () => {
    deriveSetupScriptFromProfile.mockReturnValue("pnpm install -r");

    await expect(service().generateSetupScript(PROJECT_ID)).resolves.toBe("pnpm install -r");

    expect(generateSetupScriptAI).not.toHaveBeenCalled();
  });

  it("trims the derived command, so trailing whitespace is not mistaken for an answer", async () => {
    deriveSetupScriptFromProfile.mockReturnValue("  cargo fetch\n");

    await expect(service().generateSetupScript(PROJECT_ID)).resolves.toBe("cargo fetch");
    expect(generateSetupScriptAI).not.toHaveBeenCalled();
  });

  it("falls back to the AI generator when the profile derives nothing", async () => {
    deriveSetupScriptFromProfile.mockReturnValue("   ");
    generateSetupScriptAI.mockResolvedValue("some ai answer");

    await expect(service().generateSetupScript(PROJECT_ID)).resolves.toBe("some ai answer");
    expect(generateSetupScriptAI).toHaveBeenCalledTimes(1);
  });

  it("reports an unknown project as NOT_FOUND rather than reaching the profile", async () => {
    getProjectById.mockResolvedValue(undefined);

    await expect(service().generateSetupScript(PROJECT_ID)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(getStackProfile).not.toHaveBeenCalled();
    expect(generateSetupScriptAI).not.toHaveBeenCalled();
  });
});

describe("generateVerifyScript consults the stack profile before any model (#521/#695)", () => {
  it("returns the profile-derived command and never calls the AI generator", async () => {
    deriveVerifyScriptFromProfile.mockReturnValue("pnpm test");

    await expect(service().generateVerifyScript(PROJECT_ID)).resolves.toBe("pnpm test");

    expect(generateVerifyScriptAI).not.toHaveBeenCalled();
  });

  it("falls back to the AI generator when the profile derives nothing", async () => {
    deriveVerifyScriptFromProfile.mockReturnValue("");
    generateVerifyScriptAI.mockResolvedValue("ai verify");

    await expect(service().generateVerifyScript(PROJECT_ID)).resolves.toBe("ai verify");
    expect(generateVerifyScriptAI).toHaveBeenCalledTimes(1);
  });

  it("reports an unknown project as NOT_FOUND rather than reaching the profile", async () => {
    getProjectById.mockResolvedValue(undefined);

    await expect(service().generateVerifyScript(PROJECT_ID)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(getStackProfile).not.toHaveBeenCalled();
  });

  it("derives setup and verify from the SAME persisted profile, which is the point of #521", async () => {
    deriveSetupScriptFromProfile.mockReturnValue("pnpm install -r");
    deriveVerifyScriptFromProfile.mockReturnValue("pnpm test");

    await service().generateSetupScript(PROJECT_ID);
    await service().generateVerifyScript(PROJECT_ID);

    // Both read the profile for this project; neither invents its own detection.
    expect(getStackProfile).toHaveBeenCalledTimes(2);
    for (const call of getStackProfile.mock.calls) expect(call[0]).toBe(PROJECT_ID);
  });
});

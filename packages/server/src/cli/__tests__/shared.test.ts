import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const runMigrationsMock = vi.fn(async () => {});
vi.mock("../../db/manual-migrate.js", () => ({
  runMigrations: runMigrationsMock,
}));

const getPreferenceMock = vi.fn(async (_key: string): Promise<string | null> => null);
vi.mock("../../repositories/preferences.repository.js", () => ({
  getPreference: getPreferenceMock,
}));

const findProjectsWithIssueNumberMock = vi.fn();
const getIssueByNumberOrIdMock = vi.fn();
vi.mock("../../repositories/issue/cli-commands.repository.js", () => ({
  findProjectsWithIssueNumber: findProjectsWithIssueNumberMock,
  getIssueByNumberOrId: getIssueByNumberOrIdMock,
}));

const getIssueIdByNumberInProjectMock = vi.fn();
vi.mock("../../repositories/issue.repository.js", () => ({
  getIssueIdByNumberInProject: getIssueIdByNumberInProjectMock,
}));

const getAllProjectsMock = vi.fn();
vi.mock("../../repositories/project.repository.js", () => ({
  getAllProjects: getAllProjectsMock,
}));

const {
  cliAction,
  resolveIssueNumberArg,
  resolveIssueArg,
  describeIssueNumberMiss,
  resolveProjectIdArg,
  getActiveProjectId,
} = await import("../shared.js");

describe("cliAction", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    runMigrationsMock.mockClear();
    runMigrationsMock.mockResolvedValue(undefined);
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("runs the migration bootstrap before invoking the handler", async () => {
    const order: string[] = [];
    runMigrationsMock.mockImplementation(async () => {
      order.push("migrate");
    });
    const handler = cliAction(async () => {
      order.push("handler");
    });

    await handler();

    expect(order).toEqual(["migrate", "handler"]);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("passes arguments through to the wrapped handler", async () => {
    const fn = vi.fn(async (_a: string, _b: number) => {});
    const handler = cliAction(fn);

    await handler("x", 42);

    expect(fn).toHaveBeenCalledWith("x", 42);
  });

  it("does not exit when the handler resolves with void", async () => {
    const handler = cliAction(async () => {});

    await handler();

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("does not exit when the handler resolves with 0", async () => {
    const handler = cliAction(async () => 0);

    await handler();

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("exits with the handler's returned code when non-zero", async () => {
    const handler = cliAction(async () => 3);

    await handler();

    expect(exitSpy).toHaveBeenCalledWith(3);
  });

  it("logs the error and exits 1 when the handler throws", async () => {
    const handler = cliAction(async () => {
      throw new Error("boom");
    });

    await handler();

    expect(errorSpy).toHaveBeenCalledWith("Error:", "boom");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("logs the error and exits 1 when the migration bootstrap itself throws, without calling the handler", async () => {
    runMigrationsMock.mockRejectedValueOnce(new Error("migration failed"));
    const fn = vi.fn(async () => {});
    const handler = cliAction(fn);

    await handler();

    expect(fn).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith("Error:", "migration failed");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("stringifies a non-Error throw via errorMessage", async () => {
    const handler = cliAction(async () => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw "plain string failure";
    });

    await handler();

    expect(errorSpy).toHaveBeenCalledWith("Error:", "plain string failure");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe("resolveProjectIdArg", () => {
  beforeEach(() => {
    getPreferenceMock.mockReset();
    getAllProjectsMock.mockReset();
  });

  it("falls back to the active project when no arg is given", async () => {
    getPreferenceMock.mockResolvedValue("active-id");

    await expect(resolveProjectIdArg(undefined)).resolves.toBe("active-id");
  });

  it("throws when no arg is given and there is no active project", async () => {
    getPreferenceMock.mockResolvedValue(null);

    await expect(getActiveProjectId()).rejects.toThrow("No active project");
  });

  it("resolves an exact id match", async () => {
    getAllProjectsMock.mockResolvedValue([
      { id: "p1", name: "Pantry" },
      { id: "p2", name: "Other" },
    ]);

    await expect(resolveProjectIdArg("p2")).resolves.toBe("p2");
  });

  it("resolves an exact (case-sensitive) name match", async () => {
    getAllProjectsMock.mockResolvedValue([{ id: "p1", name: "Pantry" }]);

    await expect(resolveProjectIdArg("Pantry")).resolves.toBe("p1");
  });

  it("resolves a single case-insensitive name match", async () => {
    getAllProjectsMock.mockResolvedValue([{ id: "p1", name: "Pantry" }]);

    await expect(resolveProjectIdArg("pantry")).resolves.toBe("p1");
  });

  it("throws when several projects share a case-insensitive name", async () => {
    getAllProjectsMock.mockResolvedValue([
      { id: "p1", name: "Pantry" },
      { id: "p2", name: "PANTRY" },
    ]);

    await expect(resolveProjectIdArg("pantry")).rejects.toThrow(
      /Several projects are named/,
    );
  });

  it("throws when no project matches", async () => {
    getAllProjectsMock.mockResolvedValue([{ id: "p1", name: "Pantry" }]);

    await expect(resolveProjectIdArg("nope")).rejects.toThrow(
      /No project named "nope"/,
    );
  });
});

describe("describeIssueNumberMiss", () => {
  beforeEach(() => {
    findProjectsWithIssueNumberMock.mockReset();
  });

  it("reports the plain not-found line when the number exists nowhere", async () => {
    findProjectsWithIssueNumberMock.mockResolvedValue([]);

    await expect(describeIssueNumberMiss(42, "active-id")).resolves.toBe(
      "Issue #42 not found in any project.",
    );
  });

  it("names the owning project(s) when the number exists elsewhere", async () => {
    findProjectsWithIssueNumberMock.mockResolvedValue([
      { projectId: "other-id", projectName: "Pantry" },
    ]);

    const message = await describeIssueNumberMiss(42, "active-id");

    expect(message).toContain("belongs to 'Pantry'");
    expect(message).toContain('--project "Pantry"');
  });

  it("falls back to the active-project not-found line when the lookup itself throws", async () => {
    findProjectsWithIssueNumberMock.mockRejectedValue(new Error("db down"));

    await expect(describeIssueNumberMiss(42, "active-id")).resolves.toBe(
      "Issue #42 not found in the active project.",
    );
  });

  it("excludes the active project's own ownership from the elsewhere list", async () => {
    findProjectsWithIssueNumberMock.mockResolvedValue([
      { projectId: "active-id", projectName: "Self" },
    ]);

    await expect(describeIssueNumberMiss(42, "active-id")).resolves.toBe(
      "Issue #42 not found in any project.",
    );
  });
});

describe("resolveIssueNumberArg", () => {
  beforeEach(() => {
    getPreferenceMock.mockReset();
    getAllProjectsMock.mockReset();
    getIssueIdByNumberInProjectMock.mockReset();
    findProjectsWithIssueNumberMock.mockReset();
  });

  it("rejects a non-numeric argument", async () => {
    await expect(resolveIssueNumberArg("abc")).resolves.toEqual({
      ok: false,
      message: "Invalid issue number: abc",
    });
  });

  it("rejects a non-positive integer", async () => {
    await expect(resolveIssueNumberArg("0")).resolves.toEqual({
      ok: false,
      message: "Invalid issue number: 0",
    });
    await expect(resolveIssueNumberArg("-1")).resolves.toEqual({
      ok: false,
      message: "Invalid issue number: -1",
    });
    await expect(resolveIssueNumberArg("1.5")).resolves.toEqual({
      ok: false,
      message: "Invalid issue number: 1.5",
    });
  });

  it("resolves the active project's issue when found", async () => {
    getPreferenceMock.mockResolvedValue("active-id");
    getIssueIdByNumberInProjectMock.mockResolvedValue("issue-1");

    await expect(resolveIssueNumberArg("42")).resolves.toEqual({
      ok: true,
      projectId: "active-id",
      issueNumber: 42,
      issueId: "issue-1",
    });
  });

  it("honors an explicit --project override instead of the active project", async () => {
    getAllProjectsMock.mockResolvedValue([{ id: "explicit-id", name: "Explicit" }]);
    getIssueIdByNumberInProjectMock.mockResolvedValue("issue-9");

    const result = await resolveIssueNumberArg("9", { project: "Explicit" });

    expect(result).toEqual({
      ok: true,
      projectId: "explicit-id",
      issueNumber: 9,
      issueId: "issue-9",
    });
    expect(getIssueIdByNumberInProjectMock).toHaveBeenCalledWith(9, "explicit-id");
  });

  it("returns the #467 cross-project explanation on a miss", async () => {
    getPreferenceMock.mockResolvedValue("active-id");
    getIssueIdByNumberInProjectMock.mockResolvedValue(null);
    findProjectsWithIssueNumberMock.mockResolvedValue([
      { projectId: "other-id", projectName: "Elsewhere" },
    ]);

    const result = await resolveIssueNumberArg("42");

    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("belongs to 'Elsewhere'");
  });
});

describe("resolveIssueArg", () => {
  beforeEach(() => {
    getPreferenceMock.mockReset();
    getAllProjectsMock.mockReset();
    getIssueByNumberOrIdMock.mockReset();
    findProjectsWithIssueNumberMock.mockReset();
  });

  it("returns the issue when a numeric ref resolves in the active project", async () => {
    getPreferenceMock.mockResolvedValue("active-id");
    const issue = { id: "issue-1", issueNumber: 42 };
    getIssueByNumberOrIdMock.mockResolvedValue(issue);

    await expect(resolveIssueArg("42")).resolves.toEqual({ ok: true, issue });
    expect(getIssueByNumberOrIdMock).toHaveBeenCalledWith("42", "active-id");
  });

  it("returns the #467 cross-project explanation for a numeric ref miss", async () => {
    getPreferenceMock.mockResolvedValue("active-id");
    getIssueByNumberOrIdMock.mockResolvedValue(null);
    findProjectsWithIssueNumberMock.mockResolvedValue([
      { projectId: "other-id", projectName: "Elsewhere" },
    ]);

    const result = await resolveIssueArg("42");

    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("belongs to 'Elsewhere'");
    expect(!result.ok && result.message).not.toBe("Issue '42' not found.");
  });

  it("returns the bare not-found message for a non-numeric ref miss (no project scoping)", async () => {
    getIssueByNumberOrIdMock.mockResolvedValue(null);

    const result = await resolveIssueArg("some-uuid-id");

    expect(result).toEqual({ ok: false, message: "Issue 'some-uuid-id' not found." });
    expect(getIssueByNumberOrIdMock).toHaveBeenCalledWith("some-uuid-id", undefined);
    expect(getPreferenceMock).not.toHaveBeenCalled();
  });

  it("returns the issue when a non-numeric ref resolves", async () => {
    const issue = { id: "some-uuid-id", issueNumber: 7 };
    getIssueByNumberOrIdMock.mockResolvedValue(issue);

    await expect(resolveIssueArg("some-uuid-id")).resolves.toEqual({ ok: true, issue });
  });

  it("resolves the project for a numeric ref via --project before lookup", async () => {
    getAllProjectsMock.mockResolvedValue([{ id: "explicit-id", name: "Explicit" }]);
    const issue = { id: "issue-9", issueNumber: 9 };
    getIssueByNumberOrIdMock.mockResolvedValue(issue);

    await expect(resolveIssueArg("9", { project: "Explicit" })).resolves.toEqual({
      ok: true,
      issue,
    });
    expect(getIssueByNumberOrIdMock).toHaveBeenCalledWith("9", "explicit-id");
  });
});

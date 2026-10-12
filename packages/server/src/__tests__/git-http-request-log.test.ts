import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { logGitHttpRequest, __resetGitHttpRequestLogForTests } from "../services/git-http.service.js";

describe("git-http request log (#1383)", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    __resetGitHttpRequestLogForTests();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it("logs a 401 with method, service, project and reason", () => {
    const now = Date.now();
    expect(logGitHttpRequest({ method: "GET", service: "info/refs?service=git-receive-pack", projectId: "p1", status: 401, reason: "token unknown or expired" }, now)).toBe(true);
    const line = String(warn.mock.calls[0]![0]);
    expect(line).toContain("GET");
    expect(line).toContain("git-receive-pack");
    expect(line).toContain("p1");
    expect(line).toContain("401");
    expect(line).toContain("token unknown or expired");
  });

  it("rate-limits repeats and reports the suppressed count", () => {
    const now = Date.now();
    const req = { method: "POST", service: "git-receive-pack", projectId: "p1", status: 403, reason: "ref not allowed" };
    expect(logGitHttpRequest(req, now)).toBe(true);
    expect(logGitHttpRequest(req, now + 1)).toBe(false);
    expect(logGitHttpRequest(req, now + 2)).toBe(false);
    expect(logGitHttpRequest(req, now + 60_000)).toBe(true);
    expect(String(warn.mock.calls[1]![0])).toContain("2 similar suppressed");
  });

  it("does not log successes", () => {
    expect(logGitHttpRequest({ method: "POST", service: "git-receive-pack", projectId: "p1", status: 200 })).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});

// The worker's git credential must not become durable state on its disk.
//
// The clone URL used to embed the assignment token
// (`http://x-token:<token>@host:port/git/<id>`), which (a) put it on the
// `git clone` command line — readable in any process listing on that machine —
// and (b) persisted it in the clone's `.git/config` origin URL, long after the
// assignment ended. The token now travels per invocation through git's ENV-based
// config instead.

import { describe, it, expect } from "vitest";
import { composeGitUrl, describeGitTransportFailure, gitAuthEnv } from "../worker/worker-repo.js";
import type { WorkerRepoTransport } from "@agentic-kanban/shared/lib/worker-protocol";

const repo: WorkerRepoTransport = {
  projectId: "proj-1",
  gitPort: 4321,
  gitToken: "s3cret-assignment-token",
  branch: "feature/ak-1-x",
  baseBranch: "master",
  incomingRef: "refs/kanban/incoming/feature/ak-1-x",
};

describe("worker git credentials", () => {
  it("keeps the token out of the URL (and therefore out of .git/config and argv)", () => {
    const url = composeGitUrl("http://board.local:3001", repo);
    expect(url).toBe("http://board.local:4321/git/proj-1");
    expect(url).not.toContain(repo.gitToken);
    expect(url).not.toContain("x-token");
  });

  it("carries the token as an Authorization header via git's env config", () => {
    const env = gitAuthEnv(repo);
    expect(env.GIT_CONFIG_COUNT).toBe("3");
    expect(env.GIT_CONFIG_KEY_0).toBe("http.extraHeader");
    const expected = Buffer.from(`x-token:${repo.gitToken}`).toString("base64");
    expect(env.GIT_CONFIG_VALUE_0).toBe(`Authorization: Basic ${expected}`);
  });

  it("never lets git wait for input: no GCM, no askpass, no terminal prompt (#1383)", () => {
    const env = gitAuthEnv(repo);
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GCM_INTERACTIVE).toBe("never");
    expect(env.GIT_CONFIG_KEY_1).toBe("credential.helper");
    expect(env.GIT_CONFIG_VALUE_1).toBe("");
    expect(env.GIT_CONFIG_KEY_2).toBe("core.askPass");
    expect(env.GIT_CONFIG_VALUE_2).toBe("");
  });

  it("names the HTTP status of a failed transport (#1383)", () => {
    expect(describeGitTransportFailure("fatal: unable to access 'x': The requested URL returned error: 401")).toContain("HTTP 401");
    expect(describeGitTransportFailure("remote: HTTP 403 forbidden")).toContain("HTTP 403");
    expect(describeGitTransportFailure("fatal: could not read Username for 'http://h': terminal prompts disabled")).toContain("authentication failed");
  });

  it("preserves https for an https board", () => {
    expect(composeGitUrl("https://board.example", repo)).toBe("https://board.example:4321/git/proj-1");
  });
});

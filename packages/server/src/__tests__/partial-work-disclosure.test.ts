import { describe, expect, it } from "vitest";
import {
  checkPartialWorkDisclosure,
  describePartialWorkWithhold,
  scanCommitsForDisclosure,
} from "../services/partial-work-disclosure.js";
import { BUILTIN_SKILLS } from "../builtin-skills.js";

const B83AEEF = {
  sha: "b83aeeff5aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  subject: "feat(#1428): verify placement policy, worker allowlist and sha-pinned verdict trust",
  body: "Adds a pure verify-placement module.\nRemote execution transport and gate wiring remain to be done.\n\nCo-Authored-By: Claude <noreply@anthropic.com>",
};

describe("scanCommitsForDisclosure (#1438)", () => {
  it("flags #1428's commit", () => {
    const found = scanCommitsForDisclosure([B83AEEF], 1428);
    expect(found).toHaveLength(1);
    expect(found[0].phrase).toContain("remain to be done");
    expect(found[0].referencedTickets).toEqual([]);
  });

  it.each([
    "The worker transport (setVerifyWorkerRunner) is not registered yet, so behaviour is unchanged until #1428's runner lands.",
    "Wiring is a follow-up.",
    "The route is not wired up.",
    "Left for a follow-up.",
    "Tracked as a follow-up ticket.",
    "Will do this in a follow-up.",
    "The rest is follow-up work.",
  ])("flags %s", (body) => {
    expect(scanCommitsForDisclosure([{ sha: "abc12345", subject: "feat(#1430): x", body }], 1430)).toHaveLength(1);
  });

  it.each([
    "feat(#1545): a delivered follow-up turn clears readyForMerge",
    "fix(#1): queue the follow-up message after the session ends",
    "fix(#1): resume the follow-up session",
  ])("does not flag follow-up as a noun phrase: %s", (subject) => {
    expect(scanCommitsForDisclosure([{ sha: "abc12345", subject, body: "" }], 1545)).toEqual([]);
  });

  it("ignores a clean commit and the Co-Authored-By trailer", () => {
    expect(scanCommitsForDisclosure([{ sha: "a", subject: "fix(#1): y", body: "Done.\n\nCo-Authored-By: Follow-up Bot <x@y>" }], 1)).toEqual([]);
  });

  it("does not count the commit's own ticket as a follow-up reference", () => {
    const [d] = scanCommitsForDisclosure([B83AEEF], 1428);
    expect(d.referencedTickets).not.toContain(1428);
  });
});

describe("checkPartialWorkDisclosure (#1438)", () => {
  const base = { workingDir: "/w", baseBranch: "master", projectId: "p", issueNumber: 1428 };

  it("withholds #1428's branch with a reason naming the sha", async () => {
    const r = await checkPartialWorkDisclosure({ ...base, listCommits: async () => [B83AEEF], isOpenTicket: async () => false });
    expect(r.passed).toBe(false);
    expect(r.message).toContain("partial work disclosed in b83aeeff");
    expect(r.message).toContain("without a follow-up ticket");
  });

  it("passes when the commit references an OPEN follow-up ticket", async () => {
    const commit = { ...B83AEEF, body: `${B83AEEF.body}\nFollow-up: #1440` };
    const r = await checkPartialWorkDisclosure({ ...base, listCommits: async () => [commit], isOpenTicket: async (_p, n) => n === 1440 });
    expect(r.passed).toBe(true);
  });

  it("does not accept a reference to a closed ticket (#1430 citing #1428)", async () => {
    const commit = { sha: "c0ffee00", subject: "feat(#1430): x", body: "Not registered yet, so unchanged until #1428's runner lands." };
    const r = await checkPartialWorkDisclosure({ ...base, issueNumber: 1430, listCommits: async () => [commit], isOpenTicket: async () => false });
    expect(r.passed).toBe(false);
  });

  it("fails open when the commits cannot be read", async () => {
    const r = await checkPartialWorkDisclosure({ ...base, listCommits: async () => { throw new Error("boom"); } });
    expect(r.passed).toBe(true);
    expect(r.message).toContain("boom");
  });

  it("describes several commits", () => {
    expect(describePartialWorkWithhold([
      { sha: "aaaaaaaa11", phrase: "p", referencedTickets: [] },
      { sha: "bbbbbbbb22", phrase: "q", referencedTickets: [] },
    ])).toContain("+1 more");
  });
});

describe("review prompts check acceptance against the diff and commits (#1438)", () => {
  it.each(["code-review", "code-review-thorough"])("%s carries the acceptance section", (name) => {
    const skill = BUILTIN_SKILLS.find((s) => s.name === name)!;
    expect(skill.prompt).toContain("CRITICAL ACCEPTANCE");
    expect(skill.prompt).toContain("remain to be done");
    expect(skill.prompt).toContain("follow-up ticket");
  });
});

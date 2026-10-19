import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { isAncestor, revParse } from "@agentic-kanban/shared/lib/git-service";
import { assembleMergeTrain, landMergeTrain } from "../services/merge-train.service.js";
import { commitFile, git, repo, setupTrainRepo } from "./helpers/merge-train-repo.js";

setupTrainRepo();

async function assembled() {
  await git(["branch", "f1"]);
  await commitFile("f1", "a.txt", "a\n");
  await git(["checkout", "-q", "main"]);
  await commitFile("main", "tracked.txt", "one\ntwo\n");
  const members = [{ workspaceId: "w1", branch: "f1" }];
  const asm = await assembleMergeTrain({ repoPath: repo, baseBranch: "main", members, label: "t-1621" });
  return { asm, members };
}

const landArgs = (asm: Awaited<ReturnType<typeof assembled>>["asm"]) => ({
  repoPath: repo, baseBranch: "main", trainRef: asm.trainRef, trainSha: asm.trainSha!, baseSha: asm.baseSha, included: asm.included,
});

describe("landing with a dirty main checkout (#1621)", () => {
  it("holds, announces once, and lands once the checkout is clean", async () => {
    const { asm } = await assembled();
    writeFileSync(join(repo, "tracked.txt"), "one\nCHANGED\n", "utf8");
    const logs: string[] = [];
    let sleeps = 0;
    const { mergeSha } = await landMergeTrain({
      ...landArgs(asm),
      dirtyBase: {
        pollMs: 1000, attentionAfterMs: 1000, maxWaitMs: 10_000, log: (m) => logs.push(m),
        sleep: async () => { if (++sleeps === 3) await git(["checkout", "--", "tracked.txt"]); },
      },
    });
    expect(sleeps).toBe(3);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("landing held: main checkout has uncommitted tracked.txt");
    expect(await isAncestor(repo, asm.trainSha!, "main")).toBe(true);
    expect(mergeSha).toBe(await revParse(repo, "main"));
  });

  it("gives up with a held error (train ref untouched) when the checkout never cleans", async () => {
    const { asm } = await assembled();
    writeFileSync(join(repo, "tracked.txt"), "one\nCHANGED\n", "utf8");
    await expect(landMergeTrain({ ...landArgs(asm), dirtyBase: { pollMs: 1, maxWaitMs: 2, attentionAfterMs: 1, sleep: async () => {}, log: () => {} } }))
      .rejects.toThrow(/landing held: main checkout has uncommitted tracked\.txt/);
    expect(await revParse(repo, asm.trainRef)).toBe(asm.trainSha);
  });

  it("does not count a line-ending-only change as dirty", async () => {
    const { asm } = await assembled();
    writeFileSync(join(repo, "tracked.txt"), "one\r\ntwo\r\n", "utf8");
    const { mergeSha } = await landMergeTrain({ ...landArgs(asm), dirtyBase: { sleep: async () => { throw new Error("must not wait"); } } });
    expect(mergeSha).toBe(await revParse(repo, "main"));
  });
});

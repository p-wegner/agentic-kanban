import { describe, it, expect } from "vitest";
import { taskkillTree } from "../services/process-exec.js";

const failing = (stderr: string) => async (): Promise<{ stdout: string; stderr: string }> => {
  throw Object.assign(new Error("Command failed: taskkill"), { code: 128, stdout: "", stderr });
};

describe("taskkillTree (#1491)", () => {
  it("treats a non-zero exit as success when every named pid is gone (grandchild exited first)", async () => {
    const exec = failing('FEHLER: Der Prozess "24604" wurde nicht gefunden. keine Instanz');
    await expect(taskkillTree(21972, { exec, isAlive: () => false })).resolves.toBeUndefined();
  });

  it("still throws when a pid of the tree survives", async () => {
    const exec = failing('ERROR: The process "24604" not found.');
    await expect(taskkillTree(21972, { exec, isAlive: (p) => p === 24604 })).rejects.toThrow(/taskkill/);
  });

  it("still throws when the root survives", async () => {
    const exec = failing("ERROR: Access is denied.");
    await expect(taskkillTree(21972, { exec, isAlive: (p) => p === 21972 })).rejects.toThrow();
  });
});

// Toolchain suggestions for a project's repo (#1382): list its root and let the pure rules in
// `worker-toolchains.ts` say what the files imply. Read-only; a missing/unreadable repo suggests nothing.
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { suggestToolchains, type ToolchainRequirement } from "@agentic-kanban/shared/lib/worker-toolchains";

export async function suggestToolchainsForRepo(repoPath: string): Promise<ToolchainRequirement[]> {
  try {
    const files = await readdir(repoPath);
    const goMod = files.includes("go.mod") ? await readFile(join(repoPath, "go.mod"), "utf8").catch(() => "") : "";
    return suggestToolchains(files, { goMod });
  } catch {
    return [];
  }
}

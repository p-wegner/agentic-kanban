// The project's committer identity, for a remote worker's assignment (#1369).
//
// A worker machine with no global `user.name`/`user.email` cannot commit for the agent. The
// board checkout's EFFECTIVE identity (local, then global - whatever `git config` resolves in
// that directory) is not a secret, so it travels in the assignment and the worker applies it
// per checkout. Absent when the board checkout has neither half: half an identity is no
// identity, and inventing one would put a made-up author on the project's history.
import { gitExec } from "@agentic-kanban/shared/lib/git-exec";
import { execSucceeded } from "@agentic-kanban/shared/lib/exec-result";
import type { WorkerCommitterIdentity } from "@agentic-kanban/shared/lib/worker-protocol";

async function readConfig(repoPath: string, key: string): Promise<string> {
  const res = await gitExec(["config", key], { cwd: repoPath });
  return execSucceeded(res) ? res.stdout.trim() : "";
}

/** The board checkout's effective committer identity, or undefined when it has no complete one. */
export async function resolveProjectCommitterIdentity(repoPath: string): Promise<WorkerCommitterIdentity | undefined> {
  try {
    const [name, email] = await Promise.all([readConfig(repoPath, "user.name"), readConfig(repoPath, "user.email")]);
    return name && email ? { name, email } : undefined;
  } catch {
    return undefined;
  }
}

// What the board's git transport can and cannot carry to a fleet worker (#748).
//
// A worker on another machine gets its repository over the board's git smart-HTTP
// transport: ONE `/git/:projectId` route, ONE `Placement.repo`, ONE checkout on the
// worker. Three real project shapes do not fit through that, and the defect was
// never that they are unsupported — it was that they were dispatched anyway:
//
//  - **Multi-repo projects.** A project with `workspace-repos` siblings gives the
//    builder a worktree per repo on the board. Remotely it gets the LEADING repo
//    only, so a sibling-only ticket runs against a checkout that does not contain
//    the code it was asked to change, finds nothing to do, and pushes nothing — and
//    the session exits 0. A result that looks legitimate is worse than a refusal.
//  - **Git LFS.** The transport serves no `/info/lfs` endpoint, so pointer files
//    arrive as pointer files. Discovered in a build on another machine, if at all.
//  - **Submodules.** The worker clones without `--recurse-submodules`, so submodule
//    paths are empty directories. (Recursing would be worse than not until the
//    worker's credential header is host-scoped — see the note in #748.)
//
// So detect them HERE, before placement commits, and refuse: fall back to the board
// host, which can serve every one of these shapes, or — for a project that forbids
// the host fallback — hold with the reason. Same rule and same shape as the profile
// allowlist (#651): the board cannot enforce this remotely, so it does not go
// remote.
//
// A filesystem-sharing worker is exempt by construction and never reaches here: it
// reads the board's own worktrees, siblings and LFS objects included.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { gitExec } from "@agentic-kanban/shared/lib/git-exec";
import { execSucceeded } from "@agentic-kanban/shared/lib/exec-result";
import { db as realDb } from "../db/index.js";
import type { Database } from "../db/index.js";
import { listProjectRepos } from "../repositories/repo.repository.js";

export type TransportVerdict = { blocked: false } | { blocked: true; reason: string };

/**
 * Outcome of inspecting a repo for features the transport cannot carry.
 *
 * `not-a-repo` is deliberately NOT the same answer as `unknown`, and the difference
 * decides whether dispatch is refused. This check exists to stop SILENT partials —
 * a worker that clones successfully and then builds against content that is not
 * there. A path that is not a git work tree cannot produce one: the worker's clone
 * fails immediately and loudly, which is the pre-existing contract (the resolver has
 * never validated `repoPath`). Refusing it here would only convert a clear error
 * into a quiet host fallback. `unknown` — a real repo that would not answer — IS a
 * refusal, because an LFS filter could be hiding behind it.
 */
export type TransportFeatureScan =
  | { kind: "ok"; unsupported: string[] }
  | { kind: "not-a-repo" }
  | { kind: "unknown"; detail: string };

/** Only the working tree is inspected, and only for these — one git spawn each. */
const DETECT_TIMEOUT_MS = 15_000;

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

async function listTrackedFiles(repoPath: string, patterns: string[]): Promise<string[] | null> {
  const result = await gitExec(["ls-files", "-z", "--", ...patterns], {
    cwd: repoPath,
    timeout: DETECT_TIMEOUT_MS,
  });
  if (!execSucceeded(result)) return null;
  return unique(result.stdout.split("\0").map((entry) => entry.trim()));
}

/** LFS and submodules in the repo the worker would clone. */
export async function scanTransportFeatures(repoPath: string): Promise<TransportFeatureScan> {
  const isRepo = await gitExec(["rev-parse", "--is-inside-work-tree"], {
    cwd: repoPath,
    timeout: DETECT_TIMEOUT_MS,
  });
  if (!execSucceeded(isRepo) || isRepo.stdout.trim() !== "true") return { kind: "not-a-repo" };

  const [gitmodules, gitattributes] = await Promise.all([
    listTrackedFiles(repoPath, [".gitmodules", "*/.gitmodules"]),
    listTrackedFiles(repoPath, [".gitattributes", "*/.gitattributes"]),
  ]);
  if (gitmodules === null || gitattributes === null) {
    return { kind: "unknown", detail: "git could not list the repository's tracked attribute files" };
  }

  const unsupported: string[] = [];
  if (gitmodules.length > 0) {
    unsupported.push(
      `git submodules (${gitmodules.join(", ")}) — the worker clones without --recurse-submodules`,
    );
  }
  // A tracked `.gitattributes` is not itself a problem; an LFS FILTER in one is.
  const lfsFiles: string[] = [];
  for (const relative of gitattributes) {
    try {
      const content = await readFile(path.join(repoPath, relative), "utf8");
      if (/filter\s*=\s*lfs/i.test(content)) lfsFiles.push(relative);
    } catch {
      // Tracked but not on disk (sparse checkout, or a race with a branch switch).
      // Not knowing is only a refusal when it could HIDE an LFS filter, and a
      // missing file cannot: git would not check it out for the worker either.
    }
  }
  if (lfsFiles.length > 0) {
    unsupported.push(
      `git LFS filters (${lfsFiles.join(", ")}) — the board's git transport serves no /info/lfs endpoint`,
    );
  }
  return { kind: "ok", unsupported };
}

/**
 * Can this project's repository go over the git transport at all?
 *
 * Checked after a worker is selected but BEFORE the placement is returned, because
 * the answer is about the repo and not about the worker — except that a
 * filesystem-sharing worker needs no transport at all, which is why the caller only
 * asks on the true-remote path.
 */
export async function remoteDispatchBlockedByRepoShape(opts: {
  projectId: string;
  repoPath: string;
  database?: Database;
  /** Test seam: an `unknown` scan is otherwise only reachable from a broken git. */
  scan?: (repoPath: string) => Promise<TransportFeatureScan>;
}): Promise<TransportVerdict> {
  const { projectId, repoPath, scan = scanTransportFeatures } = opts;
  // `opts.database ?? realDb` is one of the two sanctioned injection spellings (#604). The
  // destructure-with-default form this replaced is grandfathered shrink-only, so a new one
  // fails the wiring ratchet. (Spelling it out here would ALSO fail it — that regex counts
  // prose as an instance, see #779.)
  const database = opts.database ?? realDb;

  let siblings: Array<{ name: string | null; path: string }>;
  try {
    siblings = await listProjectRepos(projectId, database);
  } catch (err) {
    // Fail closed: the host can run a multi-repo project, so "we could not check"
    // costs a host launch, while guessing "single repo" costs a wrong result that
    // looks right.
    return {
      blocked: true,
      reason:
        `its repository layout could not be read (${err instanceof Error ? err.message : String(err)}), ` +
        "and a multi-repo project cannot be served over the single-repo git transport",
    };
  }
  if (siblings.length > 0) {
    const named = siblings.map((r) => r.name ?? path.basename(r.path)).join(", ");
    return {
      blocked: true,
      reason:
        `it is a multi-repo project (${siblings.length} additional repo(s): ${named}) and the board's git ` +
        "transport carries exactly one repository per assignment, so a worker would build against a checkout " +
        "that is missing the siblings — including for a sibling-only ticket, which would push nothing and " +
        "still look successful",
    };
  }

  const scanned = await scan(repoPath);
  if (scanned.kind === "not-a-repo") {
    // Not this check's business — see TransportFeatureScan. The clone fails loudly.
    return { blocked: false };
  }
  if (scanned.kind === "unknown") {
    return {
      blocked: true,
      reason:
        `its repository at ${repoPath} could not be inspected for LFS/submodule use (${scanned.detail}), and ` +
        "both of those fail on the worker rather than here",
    };
  }
  if (scanned.unsupported.length > 0) {
    return { blocked: true, reason: `its repository uses ${scanned.unsupported.join("; ")}` };
  }
  return { blocked: false };
}

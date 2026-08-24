// @gate:always-run — spawns the live cross-worktree hook script outside src/; imports nothing it checks (#538).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Behavioural test of the cross-worktree guard hook (#369).
 *
 * This runs the real hook script as a subprocess against a real git repo with a real linked
 * worktree, because the two gaps the ticket is about are both in the script's *runtime*
 * behaviour, not in any TypeScript we could unit-test:
 *   (i)  shell commands were not inspected at all, so `cd <main>; git commit` bypassed it;
 *   (ii) the authorized root was derived from the process's own cwd, so an agent in the
 *        wrong tree authorized itself.
 *
 * The first case below is the LITERAL command shape from the incident transcript
 * (subagent agent-a58fcaaa5 under ak-91): `cd <main checkout>` + `git commit -F <msg file>`.
 */

/**
 * The DEPLOYED copy, not `src/scaffold/`: the canonical source lives under `packages/server`,
 * whose package.json is `"type": "module"`, so node refuses to run that CommonJS file in
 * place. `scaffold-hook-sources.test.ts` asserts the two are byte-identical, so exercising
 * the deployed copy exercises the shipped one.
 */
const HOOK = join(__dirname, "../../../../.claude/hooks/prevent-cross-worktree-writes.js");

let root: string;
let mainCheckout: string;
let worktree: string;

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "ignore", windowsHide: true });
}

interface HookResult {
  blocked: boolean;
  reason: string;
}

/** Run the hook with a PreToolUse payload. `env` overrides are merged over process.env. */
function runHook(
  payload: Record<string, unknown>,
  env: Record<string, string | undefined> = {},
): HookResult {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    windowsHide: true,
    // CLAUDE_PROJECT_DIR is inherited from whatever session runs the suite and would point the
    // guard at THIS repo instead of the temp fixture; clear it so `cwd` in the payload decides.
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: undefined,
      KANBAN_WORKTREE_DIR: undefined,
      ALLOW_CROSS_WORKTREE_WRITE: undefined,
      ...env,
    },
  });
  return { blocked: res.status === 2, reason: res.stdout ?? "" };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ak-guard-"));
  mainCheckout = join(root, "repo");
  worktree = join(root, "wt-ak-91");
  mkdirSync(mainCheckout, { recursive: true });
  git(["init", "-b", "master"], mainCheckout);
  git(["config", "user.email", "t@example.com"], mainCheckout);
  git(["config", "user.name", "T"], mainCheckout);
  writeFileSync(join(mainCheckout, "seed.md"), "seed\n", "utf8");
  git(["add", "seed.md"], mainCheckout);
  git(["commit", "-m", "seed"], mainCheckout);
  git(["worktree", "add", "-b", "feature/ak-91", worktree], mainCheckout);
});

afterAll(() => {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe("cross-worktree guard — shell vector (#369 gap i)", () => {
  it("BLOCKS the exact incident command: cd into the main checkout, then git commit -F", () => {
    const res = runHook({
      tool_name: "PowerShell",
      tool_input: {
        command: `cd ${mainCheckout}\ngit commit -F .git-commit-msg-ak91.txt\nRemove-Item .git-commit-msg-ak91.txt`,
      },
      cwd: worktree,
    });
    expect(res.blocked).toBe(true);
    expect(res.reason).toContain("Cross-worktree shell command blocked");
  });

  it("BLOCKS a Bash redirect writing a file into the main checkout", () => {
    const res = runHook({
      tool_name: "Bash",
      tool_input: { command: `echo hi > ${mainCheckout.replace(/\\/g, "/")}/docs.md` },
      cwd: worktree,
    });
    expect(res.blocked).toBe(true);
  });

  it("BLOCKS a relative path that escapes into the main checkout", () => {
    const res = runHook({
      tool_name: "Bash",
      tool_input: { command: "git -C ../repo commit -m x" },
      cwd: worktree,
    });
    expect(res.blocked).toBe(true);
  });

  it("ALLOWS read-only inspection of the main checkout (no mutating verb)", () => {
    const res = runHook({
      tool_name: "Bash",
      tool_input: { command: `cd ${mainCheckout} && git log --oneline -5 && git status --short` },
      cwd: worktree,
    });
    expect(res.blocked).toBe(false);
  });

  it("ALLOWS a mutating command inside the agent's OWN worktree", () => {
    const res = runHook({
      tool_name: "Bash",
      tool_input: { command: `cd ${worktree} && git commit -m mine` },
      cwd: worktree,
    });
    expect(res.blocked).toBe(false);
  });

  it("respects the explicit ALLOW_CROSS_WORKTREE_WRITE escape hatch", () => {
    const res = runHook(
      {
        tool_name: "PowerShell",
        tool_input: { command: `cd ${mainCheckout}\ngit commit -F msg.txt` },
        cwd: worktree,
      },
      { ALLOW_CROSS_WORKTREE_WRITE: "1" },
    );
    expect(res.blocked).toBe(false);
  });
});

describe("cross-worktree guard — self-authorization (#369 gap ii)", () => {
  it("BLOCKS an Edit into the main checkout when the board declares the worktree, even though cwd says otherwise", () => {
    // The self-authorizing case: the process claims the main checkout as its own cwd. Before
    // the fix, currentRoot became the main checkout and the write was allowed.
    const res = runHook(
      {
        tool_name: "Edit",
        tool_input: { file_path: join(mainCheckout, "docs", "stray.md") },
        cwd: mainCheckout,
      },
      { KANBAN_WORKTREE_DIR: worktree },
    );
    expect(res.blocked).toBe(true);
    expect(res.reason).toContain("KANBAN_WORKTREE_DIR");
  });

  it("BLOCKS a shell commit in the main checkout when the board declares the worktree", () => {
    const res = runHook(
      {
        tool_name: "Bash",
        tool_input: { command: `cd ${mainCheckout} && git add -A && git commit -m stray` },
        cwd: mainCheckout,
      },
      { KANBAN_WORKTREE_DIR: worktree },
    );
    expect(res.blocked).toBe(true);
  });

  /**
   * #472 — the CWD itself is the violation, and nothing was checking it.
   *
   * MEASURED: a background subagent launched for a ticket in `.worktrees/ak-111` committed to the
   * SHARED `eventhub-backend` checkout on master (`fe83a33`), and a later unrelated merge carried
   * that stray commit forward. The guard was fully wired in that project — both matchers — and
   * still allowed it, because `shellViolation` only inspects PATH TOKENS IN THE COMMAND and a
   * bare `git commit -am "…"` names no path. The guard was implicitly trusting that the process's
   * cwd WAS the authorized worktree.
   */
  it("BLOCKS a bare commit whose CWD is another worktree, though it names no path", () => {
    const res = runHook(
      {
        tool_name: "Bash",
        // No path anywhere in the command — this is the whole point.
        tool_input: { command: `git commit -am "stray finding"` },
        cwd: mainCheckout,
      },
      { KANBAN_WORKTREE_DIR: worktree },
    );
    expect(res.blocked).toBe(true);
  });

  it("keeps allowing a bare commit issued from the authorized worktree", () => {
    const res = runHook(
      { tool_name: "Bash", tool_input: { command: `git commit -am "mine"` }, cwd: worktree },
      { KANBAN_WORKTREE_DIR: worktree },
    );
    expect(res.blocked).toBe(false);
  });

  it("keeps allowing a READ from another worktree — the promise the guard already made", () => {
    // "Reading another worktree is fine; mutating it is not." Gating the cwd check on a mutating
    // command is what keeps that true; without it this became a new restriction, not a fix.
    const res = runHook(
      { tool_name: "Bash", tool_input: { command: `git log -1` }, cwd: mainCheckout },
      { KANBAN_WORKTREE_DIR: worktree },
    );
    expect(res.blocked).toBe(false);
  });

  it("does not fire when the board declared NO worktree — cwd is then the authority itself", () => {
    // Without KANBAN_WORKTREE_DIR the authorized root is DERIVED from cwd, so comparing the two
    // would compare a value to itself.
    const res = runHook({ tool_name: "Bash", tool_input: { command: `git commit -am "hand-run"` }, cwd: mainCheckout });
    expect(res.blocked).toBe(false);
  });

  it("still ALLOWS writes inside the board-declared worktree", () => {
    const res = runHook(
      {
        tool_name: "Write",
        tool_input: { file_path: join(worktree, "notes.md") },
        cwd: mainCheckout,
      },
      { KANBAN_WORKTREE_DIR: worktree },
    );
    expect(res.blocked).toBe(false);
  });
});

/**
 * #890 — the guard matches WRITE TARGETS, not mentions.
 *
 * The old shell detection blocked any command whose TEXT contained another worktree's path once
 * a mutating verb appeared anywhere — a path quoted in a heredoc body, a data string, or a
 * `git -C <wt> config` READ all counted, and the documented escape
 * (ALLOW_CROSS_WORKTREE_WRITE=1) disables the whole guard, which is disproportionate. Heredoc
 * bodies are now stripped (data, never commands), and for classifiable shapes only the resolved
 * write targets — plus the cd-tracked effective cwd — are matched. Ambiguous mutating shapes
 * still fail closed.
 */
describe("cross-worktree guard — write targets, not mentions (#890)", () => {
  it("ALLOWS a heredoc whose BODY merely mentions the main checkout (data, not a write)", () => {
    const res = runHook({
      tool_name: "Bash",
      tool_input: {
        command: `cat > notes.txt <<'EOF'\nsee ${mainCheckout.replace(/\\/g, "/")}/seed.md and run git commit -m x there\nEOF`,
      },
      cwd: worktree,
    });
    expect(res.blocked).toBe(false);
  });

  it("BLOCKS a redirect INTO the main checkout even when it feeds a heredoc", () => {
    const res = runHook({
      tool_name: "Bash",
      tool_input: {
        command: `cat > ${mainCheckout.replace(/\\/g, "/")}/x.txt <<'EOF'\nhello\nEOF`,
      },
      cwd: worktree,
    });
    expect(res.blocked).toBe(true);
  });

  it("ALLOWS `git -C <foreign> config` — a READ of another worktree", () => {
    const res = runHook({
      tool_name: "Bash",
      tool_input: { command: `git -C ${mainCheckout.replace(/\\/g, "/")} config user.name` },
      cwd: worktree,
    });
    expect(res.blocked).toBe(false);
  });

  it("BLOCKS `git -C <foreign> commit` — a MUTATION of another worktree", () => {
    const res = runHook({
      tool_name: "Bash",
      tool_input: { command: `git -C ${mainCheckout.replace(/\\/g, "/")} commit -m x` },
      cwd: worktree,
    });
    expect(res.blocked).toBe(true);
    expect(res.reason).toContain("Cross-worktree shell command blocked");
  });

  it("ALLOWS a foreign path quoted as DATA in a commit message", () => {
    const res = runHook({
      tool_name: "Bash",
      tool_input: {
        command: `git commit -m "refs ${mainCheckout.replace(/\\/g, "/")}/seed.md in the main tree"`,
      },
      cwd: worktree,
    });
    expect(res.blocked).toBe(false);
  });

  it("ALLOWS copying FROM the main checkout (a read), BLOCKS copying INTO it (the write)", () => {
    const fwd = mainCheckout.replace(/\\/g, "/");
    expect(
      runHook(
        { tool_name: "Bash", tool_input: { command: `cp ${fwd}/seed.md ./copy.md` }, cwd: worktree },
      ).blocked,
    ).toBe(false);
    expect(
      runHook(
        { tool_name: "Bash", tool_input: { command: `cp ./copy.md ${fwd}/seed.md` }, cwd: worktree },
      ).blocked,
    ).toBe(true);
  });

  it("keeps failing CLOSED for a mutating shape it cannot classify", () => {
    // `install` mutates (it is in the POSIX pattern) but its arg roles are not resolved — the
    // old whole-segment mention match still applies to that segment.
    const res = runHook({
      tool_name: "Bash",
      tool_input: { command: `install -m 644 x ${mainCheckout.replace(/\\/g, "/")}/y` },
      cwd: worktree,
    });
    expect(res.blocked).toBe(true);
  });

  it("still handles the Codex shell input shape (tool_input.command on `shell`)", () => {
    const res = runHook({
      tool_name: "shell",
      tool_input: { command: `git -C ${mainCheckout.replace(/\\/g, "/")} commit -m x` },
      cwd: worktree,
    });
    expect(res.blocked).toBe(true);
  });
});

describe("cross-worktree guard — structured writes still guarded", () => {
  it("BLOCKS an Edit targeting the main checkout from the worktree", () => {
    const res = runHook({
      tool_name: "Edit",
      tool_input: { file_path: join(mainCheckout, "seed.md") },
      cwd: worktree,
    });
    expect(res.blocked).toBe(true);
    expect(res.reason).toContain("Cross-worktree write blocked");
  });

  it("ALLOWS a write outside every worktree (temp, home)", () => {
    const res = runHook({
      tool_name: "Write",
      tool_input: { file_path: join(tmpdir(), "ak-guard-scratch.txt") },
      cwd: worktree,
    });
    expect(res.blocked).toBe(false);
  });
});

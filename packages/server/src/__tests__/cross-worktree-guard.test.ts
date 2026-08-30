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
/** An unrelated repo, not a worktree of the fixture repo — the #959 subject. */
let foreignRepo: string;
/** A multi-repo project's SIBLING worktree, peer of `worktree` under the same `.worktrees/`. */
let siblingWorktree: string;

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

/** `git init` + one commit, so the directory is a real repository with a toplevel. */
function seedRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(["init", "-b", "master"], dir);
  git(["config", "user.email", "t@example.com"], dir);
  git(["config", "user.name", "T"], dir);
  writeFileSync(join(dir, "seed.md"), "seed\n", "utf8");
  git(["add", "seed.md"], dir);
  git(["commit", "-m", "seed"], dir);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ak-guard-"));
  mainCheckout = join(root, "repo");
  // The board's real on-disk layout: `<parent>/.worktrees/<repoDirName>/<leaf>` (#385,
  // `worktreesDirFor`). The #959 sibling rule keys on exactly this shape, so the fixture has
  // to use it rather than a flat `wt-ak-91` directory.
  worktree = join(root, ".worktrees", "repo", "ak-91");
  siblingWorktree = join(root, ".worktrees", "repo-frontend", "ak-91");
  foreignRepo = join(root, "unrelated-skill");

  seedRepo(mainCheckout);
  mkdirSync(join(root, ".worktrees", "repo"), { recursive: true });
  git(["worktree", "add", "-b", "feature/ak-91", worktree], mainCheckout);

  // A multi-repo project's second repo, with its own worktree beside the leading one.
  const siblingRepo = join(root, "repo-frontend");
  seedRepo(siblingRepo);
  mkdirSync(join(root, ".worktrees", "repo-frontend"), { recursive: true });
  git(["worktree", "add", "-b", "feature/ak-91", siblingWorktree], siblingRepo);

  // The unrelated checkout — a different repo entirely, NOT under `.worktrees/`. This is
  // `C:\projects\andrena\test-impact-skill` in the incident.
  seedRepo(foreignRepo);
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
      // Relative to `<root>/.worktrees/repo/ak-91`, the main checkout is three levels up.
      tool_input: { command: "git -C ../../../repo commit -m x" },
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

/**
 * #959 — HARD BLOCK on writes into an UNRELATED checkout.
 *
 * Everything above guards other worktrees OF THE SAME REPO. A foreign repo is neither the main
 * checkout nor a linked worktree, so it was not covered at all — and a builder for #954, scoped
 * to `.worktrees/agentic-kanban/ak-954`, edited and COMMITTED into `test-impact-skill`. Another
 * session pushed that commit to its origin believing it was its own work; nothing on the board
 * surfaced it.
 *
 * The two doors the incident used are the first two tests here. The rest pin the three
 * properties that keep the block from being over-broad: it needs a board-declared root, it only
 * fires inside a repository, and a multi-repo project's sibling worktrees stay writable.
 */
describe("foreign-checkout hard block (#959)", () => {
  const board = () => ({ KANBAN_WORKTREE_DIR: worktree });

  it("BLOCKS door 1 — a tool write into an unrelated checkout", () => {
    const res = runHook(
      {
        tool_name: "Edit",
        tool_input: { file_path: join(foreignRepo, "cli.mjs") },
        cwd: worktree,
      },
      board(),
    );
    expect(res.blocked).toBe(true);
    expect(res.reason).toContain("UNRELATED git checkout");
  });

  it("BLOCKS door 2 — a shell `git -C <foreign repo> commit`, the exact incident shape", () => {
    const res = runHook(
      {
        tool_name: "Bash",
        tool_input: { command: `git -C ${foreignRepo.replace(/\\/g, "/")} commit -m "feat: ..."` },
        cwd: worktree,
      },
      board(),
    );
    expect(res.blocked).toBe(true);
    expect(res.reason).toContain("UNRELATED git checkout");
  });

  it("names the alternative — file a ticket there, or hand it to the owning session", () => {
    const res = runHook(
      { tool_name: "Write", tool_input: { file_path: join(foreignRepo, "new.md") }, cwd: worktree },
      board(),
    );
    expect(res.blocked).toBe(true);
    expect(res.reason).toContain("file a ticket");
    expect(res.reason).toContain("hand it to the session that owns");
  });

  it("BLOCKS a write to an EXISTING file in the foreign repo", () => {
    // The incident EDITED a file that was already there, and this is where the first
    // implementation leaked: `git rev-parse --show-toplevel` needs a DIRECTORY as its cwd, so
    // asking about the file itself returned "no repo" and the write sailed through — i.e. the
    // guard would have allowed every edit to an existing file, which is most of them.
    const res = runHook(
      { tool_name: "Edit", tool_input: { file_path: join(foreignRepo, "seed.md") }, cwd: worktree },
      board(),
    );
    expect(res.blocked).toBe(true);
  });

  it("BLOCKS a write to a path that does not exist yet inside the foreign repo", () => {
    // The write CREATES the file, so `git rev-parse` on it fails — the guard must walk up to
    // the nearest existing ancestor instead of concluding "not in a repo".
    const res = runHook(
      {
        tool_name: "Write",
        tool_input: { file_path: join(foreignRepo, "src", "deeply", "nested.ts") },
        cwd: worktree,
      },
      board(),
    );
    expect(res.blocked).toBe(true);
  });

  it("BLOCKS a bare commit whose CWD is the foreign repo, though it names no path", () => {
    // The #472 shape, one repo further out: `others` holds only worktrees of THIS repo, so the
    // existing cwd check could not see it.
    const res = runHook(
      { tool_name: "Bash", tool_input: { command: `git commit -am "stray"` }, cwd: foreignRepo },
      board(),
    );
    expect(res.blocked).toBe(true);
    expect(res.reason).toContain("UNRELATED git checkout");
  });

  it("BLOCKS a redirect writing a file into the foreign repo", () => {
    const res = runHook(
      {
        tool_name: "Bash",
        tool_input: { command: `echo hi > ${foreignRepo.replace(/\\/g, "/")}/notes.md` },
        cwd: worktree,
      },
      board(),
    );
    expect(res.blocked).toBe(true);
  });

  it("ALLOWS READING the foreign repo — the promise the guard already made", () => {
    const fwd = foreignRepo.replace(/\\/g, "/");
    expect(
      runHook({ tool_name: "Bash", tool_input: { command: `git -C ${fwd} log --oneline -5` }, cwd: worktree }, board())
        .blocked,
    ).toBe(false);
    expect(
      runHook({ tool_name: "Bash", tool_input: { command: `cat ${fwd}/seed.md` }, cwd: worktree }, board()).blocked,
    ).toBe(false);
    expect(
      runHook({ tool_name: "Bash", tool_input: { command: `cp ${fwd}/seed.md ./copy.md` }, cwd: worktree }, board())
        .blocked,
    ).toBe(false);
  });

  it("ALLOWS writes into a SIBLING worktree of the same multi-repo workspace", () => {
    // A multi-repo project provisions one worktree per repo as peers under `.worktrees/`.
    // Blocking those would break every multi-repo builder.
    expect(
      runHook(
        { tool_name: "Write", tool_input: { file_path: join(siblingWorktree, "app.ts") }, cwd: worktree },
        board(),
      ).blocked,
    ).toBe(false);
    expect(
      runHook(
        {
          tool_name: "Bash",
          tool_input: { command: `git -C ${siblingWorktree.replace(/\\/g, "/")} commit -m x` },
          cwd: worktree,
        },
        board(),
      ).blocked,
    ).toBe(false);
  });

  /**
   * The sibling carve-out must not pin the DEPTH under `.worktrees/`.
   *
   * `worktreesDirFor` emits three depths that are ALL live at once, and the first
   * implementation of `isSiblingWorkspaceWorktree` required exactly the middle one:
   *   - `<repoDirName>/<leaf>`             — today's default (two segments);
   *   - `<repoDirName>/<namespace>/<leaf>` — `opts.pathNamespace`, e.g. the merge-queue
   *                                          train's `train` namespace (three segments);
   *   - `<leaf>`                           — OLD-LAYOUT worktrees created before #385, which
   *                                          `createWorktree` documents as still supported and
   *                                          explicitly NOT migrated (one segment).
   * Requiring two hard-blocked a legitimate sibling write in the other two, i.e. it wedged the
   * very multi-repo builder the carve-out exists to keep working. Containment under the shared
   * `.worktrees/` root is the property that separates a workspace peer from a foreign checkout.
   */
  describe("sibling carve-out does not pin depth under .worktrees/", () => {
    /** `<root>/.worktrees/<...segments>/<leaf>` worktrees of two repos, plus a foreign repo. */
    function layout(name: string, segments: string[]) {
      const base = mkdtempSync(join(tmpdir(), `ak-guard-${name}-`));
      const lead = join(base, "app");
      const sib = join(base, "lib");
      seedRepo(lead);
      seedRepo(sib);
      // One segment = the pre-#385 flat layout (`.worktrees/<leaf>`, no repo-name segment);
      // otherwise `.worktrees/<repoDirName>/<...extra namespace>/<leaf>`.
      const flat = segments.length === 0;
      const leadWt = flat
        ? join(base, ".worktrees", "ak-1")
        : join(base, ".worktrees", "app", ...segments, "ak-1");
      const sibWt = flat
        ? join(base, ".worktrees", "ak-1-lib")
        : join(base, ".worktrees", "lib", ...segments, "ak-1");
      mkdirSync(join(leadWt, ".."), { recursive: true });
      mkdirSync(join(sibWt, ".."), { recursive: true });
      git(["worktree", "add", "-b", "feature/ak-1", leadWt], lead);
      git(["worktree", "add", "-b", "feature/ak-1", sibWt], sib);
      const foreign = join(base, "unrelated-skill");
      seedRepo(foreign);
      return { base, leadWt, sibWt, foreign };
    }

    // The default two-segment layout is already covered by the fixture-wide `siblingWorktree`
    // test above; these are the two depths the old exactly-two rule rejected.
    const depthCases: Array<[string, string[]]> = [
      ["old layout (one segment, pre-#385)", []],
      ["pathNamespace layout (three segments)", ["train"]],
    ];

    for (const [label, segments] of depthCases) {
      it(`ALLOWS a sibling write and still BLOCKS a foreign repo — ${label}`, () => {
        const { base, leadWt, sibWt, foreign } = layout(label.replace(/\W+/g, "-"), segments);
        try {
          expect(
            runHook(
              { tool_name: "Write", tool_input: { file_path: join(sibWt, "app.ts") }, cwd: leadWt },
              { KANBAN_WORKTREE_DIR: leadWt },
            ).blocked,
          ).toBe(false);
          // The carve-out must not have widened into "anything outside my worktree is fine".
          const foreignRes = runHook(
            { tool_name: "Write", tool_input: { file_path: join(foreign, "cli.mjs") }, cwd: leadWt },
            { KANBAN_WORKTREE_DIR: leadWt },
          );
          expect(foreignRes.blocked).toBe(true);
          expect(foreignRes.reason).toContain("UNRELATED git checkout");
        } finally {
          rmSync(base, { recursive: true, force: true });
        }
      });
    }
  });

  it("ALLOWS writes outside every repository (temp, caches) — unchanged", () => {
    const res = runHook(
      {
        tool_name: "Write",
        tool_input: { file_path: join(tmpdir(), "ak-959-scratch.txt") },
        cwd: worktree,
      },
      board(),
    );
    expect(res.blocked).toBe(false);
  });

  it("still ALLOWS writes inside the agent's own worktree", () => {
    expect(
      runHook({ tool_name: "Write", tool_input: { file_path: join(worktree, "mine.ts") }, cwd: worktree }, board())
        .blocked,
    ).toBe(false);
    expect(
      runHook({ tool_name: "Bash", tool_input: { command: `git commit -am mine` }, cwd: worktree }, board()).blocked,
    ).toBe(false);
  });

  it("does NOT fire without a board-declared root — cwd would then be judged against itself", () => {
    // A hand-run session derives its root from cwd, so blocking every write outside it would
    // wedge ordinary use. Same gate as the #472 cwd check.
    expect(
      runHook({ tool_name: "Edit", tool_input: { file_path: join(foreignRepo, "cli.mjs") }, cwd: worktree }).blocked,
    ).toBe(false);
  });

  it("respects the explicit override for a foreign-repo write", () => {
    const res = runHook(
      {
        tool_name: "Bash",
        tool_input: { command: `ALLOW_CROSS_WORKTREE_WRITE=1 git -C ${foreignRepo.replace(/\\/g, "/")} commit -m x` },
        cwd: worktree,
      },
      board(),
    );
    expect(res.blocked).toBe(false);
  });

  it("holds for the Codex/Pi shell input shape too", () => {
    // Codex routes shell through the same script (`.codex/hooks.json` → smart-hooks-runner),
    // and the Pi adapter delegates to it as well, so provider parity is this one assertion.
    const res = runHook(
      {
        tool_name: "shell",
        tool_input: { command: `cd ${foreignRepo.replace(/\\/g, "/")} && git commit -m x` },
        cwd: worktree,
      },
      board(),
    );
    expect(res.blocked).toBe(true);
  });

  it("holds for the Codex apply_patch tool shape", () => {
    const res = runHook(
      {
        tool_name: "apply_patch",
        tool_input: {
          patch: `*** Begin Patch\n*** Update File: ${foreignRepo.replace(/\\/g, "/")}/seed.md\n@@\n-seed\n+edited\n*** End Patch`,
        },
        cwd: worktree,
      },
      board(),
    );
    expect(res.blocked).toBe(true);
  });
});

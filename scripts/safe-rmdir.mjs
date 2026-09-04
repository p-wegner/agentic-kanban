#!/usr/bin/env node
/**
 * safe-rmdir — delete a directory tree, but REFUSE if it contains a reparse point
 * (junction / symlink) whose target lies OUTSIDE the tree (#1033).
 *
 * Why: agents clean up finished worktrees (`.claude/worktrees/agent-*`, `%TEMP%/ak-*`)
 * with whatever purge tool is at hand — `robocopy /MIR`, `Remove-Item -Recurse`,
 * `rm -rf`. A tree that holds a junction pointing into the LIVE checkout (the
 * boot-dist smoke's borrowed `node_modules`, an ad-hoc `mklink /J` into main) is one
 * where a purge that follows links destroys the target. Measured on this box
 * (2026-09-04, Windows 11, git 2.55, node 24): none of node `rmSync`, `robocopy /MIR`,
 * `Remove-Item -Recurse -Force`, `git worktree remove --force`, `rm -rf`, `rmdir /s /q`
 * follows a junction — but that is a property of today's tool versions, not a
 * guarantee, and the cost of being wrong once is every agent on the machine. So this
 * script makes the check explicit: it walks the tree first, lists every outbound link,
 * and deletes nothing when it finds one.
 *
 * Usage:
 *   node scripts/safe-rmdir.mjs <dir> [--dry-run] [--unlink-outbound] [--json]
 *
 *   --dry-run          walk and report, delete nothing (exit 0 = would delete, 2 = would refuse)
 *   --unlink-outbound  remove the outbound links THEMSELVES first (link only, never the
 *                      target), then delete the tree. Use it when the links are known to be
 *                      borrowed directories (the boot-dist smoke's case).
 *   --json             one machine-readable result line
 *
 * Exit codes: 0 deleted (or would delete), 2 refused (outbound reparse point found),
 * 1 usage / IO error. Links whose target is INSIDE the tree (pnpm's own
 * `.pnpm/<pkg>/node_modules/<dep>` junctions) are fine and never reported.
 *
 * Plain node, no package resolution — it must work in a tree whose node_modules is the
 * thing being deleted.
 */
import { lstatSync, readdirSync, readlinkSync, realpathSync, rmSync, rmdirSync, unlinkSync, existsSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";

function normKey(p) {
  const s = resolve(p).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? s.toLowerCase() : s;
}

function isInside(child, root) {
  const c = normKey(child);
  const r = normKey(root);
  return c === r || c.startsWith(r + sep);
}

/** Resolve a reparse point's target without following further links when possible. */
function linkTarget(p) {
  try {
    const raw = readlinkSync(p);
    // Windows junction targets come back absolute (sometimes with a \\?\ prefix); a
    // relative symlink target is relative to the link's parent.
    const cleaned = String(raw).replace(/^\\\\\?\\/, "");
    return isAbsolute(cleaned) ? cleaned : resolve(dirname(p), cleaned);
  } catch {
    try { return realpathSync(p); } catch { return null; }
  }
}

/**
 * Walk `root` and classify every reparse point. Never descends INTO a link.
 * Returns { outbound: [{path, target}], inbound: number, entries: number }.
 */
export function scanReparsePoints(root) {
  const result = { outbound: [], inbound: 0, entries: 0 };
  const stack = [resolve(root)];
  while (stack.length) {
    const dir = stack.pop();
    let ents;
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = resolve(dir, e.name);
      result.entries++;
      let st;
      try { st = lstatSync(p); } catch { continue; }
      if (st.isSymbolicLink()) {
        const target = linkTarget(p);
        if (target && isInside(target, root)) result.inbound++;
        else result.outbound.push({ path: p, target: target ?? "<unresolvable>" });
        continue; // never descend into a link
      }
      if (st.isDirectory()) stack.push(p);
    }
  }
  return result;
}

/** Remove a link WITHOUT touching its target. */
export function removeLinkOnly(p) {
  try { unlinkSync(p); return true; } catch { /* junctions want rmdir */ }
  try { rmdirSync(p); return true; } catch { return false; }
}

/**
 * The library entry point (the CLI below is a thin wrapper, so tests can drive both).
 * Returns { ok, refused, outbound, removedLinks, deleted }.
 */
export function safeRmdir(root, { dryRun = false, unlinkOutbound = false } = {}) {
  const abs = resolve(root);
  if (!existsSync(abs)) return { ok: true, refused: false, outbound: [], removedLinks: 0, deleted: false, note: "absent" };
  const st = lstatSync(abs);
  if (st.isSymbolicLink()) {
    // The root itself is a link: remove the link, never what it points at.
    if (dryRun) return { ok: true, refused: false, outbound: [], removedLinks: 0, deleted: false, note: "root-is-link" };
    return { ok: removeLinkOnly(abs), refused: false, outbound: [], removedLinks: 1, deleted: false, note: "root-is-link" };
  }
  if (!st.isDirectory()) throw new Error(`${abs} is not a directory`);

  const scan = scanReparsePoints(abs);
  let removedLinks = 0;
  if (scan.outbound.length > 0) {
    if (!unlinkOutbound) {
      return { ok: false, refused: true, outbound: scan.outbound, removedLinks: 0, deleted: false, inbound: scan.inbound };
    }
    if (!dryRun) {
      for (const o of scan.outbound) if (removeLinkOnly(o.path)) removedLinks++;
      const again = scanReparsePoints(abs);
      if (again.outbound.length > 0) {
        return { ok: false, refused: true, outbound: again.outbound, removedLinks, deleted: false, inbound: again.inbound };
      }
    }
  }
  if (dryRun) return { ok: true, refused: false, outbound: scan.outbound, removedLinks: 0, deleted: false, inbound: scan.inbound };
  rmSync(abs, { recursive: true, force: true, maxRetries: 3 });
  return { ok: !existsSync(abs), refused: false, outbound: scan.outbound, removedLinks, deleted: !existsSync(abs), inbound: scan.inbound };
}

function main(argv) {
  const args = argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const dirs = args.filter((a) => !a.startsWith("--"));
  if (dirs.length !== 1) {
    console.error("usage: node scripts/safe-rmdir.mjs <dir> [--dry-run] [--unlink-outbound] [--json]");
    return 1;
  }
  const json = flags.has("--json");
  let res;
  try {
    res = safeRmdir(dirs[0], { dryRun: flags.has("--dry-run"), unlinkOutbound: flags.has("--unlink-outbound") });
  } catch (err) {
    if (json) console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    else console.error(`safe-rmdir: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  if (json) console.log(JSON.stringify({ dir: resolve(dirs[0]), ...res }));
  else if (res.refused) {
    console.error(`safe-rmdir: REFUSED to delete ${resolve(dirs[0])} — ${res.outbound.length} reparse point(s) point OUTSIDE the tree:`);
    for (const o of res.outbound) console.error(`  ${o.path}  ->  ${o.target}`);
    console.error("Remove the links first (they may borrow a live checkout's directories), or re-run with --unlink-outbound to drop the LINKS only.");
  } else if (flags.has("--dry-run")) {
    console.log(`safe-rmdir: would delete ${resolve(dirs[0])} (${res.inbound ?? 0} in-tree link(s), ${res.outbound.length} outbound)`);
  } else {
    console.log(`safe-rmdir: deleted ${resolve(dirs[0])}${res.removedLinks ? ` (unlinked ${res.removedLinks} outbound link(s) first)` : ""}`);
  }
  return res.refused ? 2 : res.ok ? 0 : 1;
}

if (process.argv[1] && /safe-rmdir\.mjs$/i.test(process.argv[1])) {
  process.exit(main(process.argv));
}

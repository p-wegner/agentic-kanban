// Jira issue links <-> board dependencies (#1700). Pure helpers plus the pull half.
//   Jira `Blocks` (A blocks B)  <->  board dependency "B depends_on A"
//   Jira `Relates`              <->  board `related_to`
// A link is identified by `linkKey` (kind + Jira keys), never by a Jira link id, so both
// sides and both halves (pull, push snapshot) agree on identity. Pull records every link it
// tracks in the plugin state (`links`), marking the board dependencies the PLUGIN created:
// only those are removed again when the link disappears in Jira.

import { pullsField } from "./sync-direction.mjs";

const BLOCKING_TYPES = new Set(["depends_on", "blocked_by"]);

/** Stable identity of a link; `relates` is symmetric so its ends are sorted. */
export function linkKey(kind, from, to) {
  return kind === "relates" ? `relates:${[from, to].sort().join("<>")}` : `${kind}:${from}>${to}`;
}

/** Inverse of linkKey: `{ kind, from, to }` (relates ends are in sorted order). */
export function parseLinkKey(key) {
  const [kind, rest] = key.split(/:(.*)/s);
  const [from, to] = rest.split(kind === "relates" ? "<>" : ">");
  return { kind, from, to };
}

/** Jira link type name -> the kinds we sync; anything else is `other`. */
function kindOfJiraType(name) {
  const n = String(name ?? "").trim().toLowerCase();
  return n === "blocks" ? "blocks" : n === "relates" ? "relates" : "other";
}

/** The issue's `issuelinks`, normalized to `{ id, kind, from, to }` (from blocks to). */
export function jiraLinksOf(jiraIssue) {
  const out = [];
  for (const l of jiraIssue?.fields?.issuelinks ?? []) {
    const kind = kindOfJiraType(l?.type?.name);
    if (l?.outwardIssue?.key) out.push({ id: l.id, kind, from: jiraIssue.key, to: l.outwardIssue.key });
    if (l?.inwardIssue?.key) out.push({ id: l.id, kind, from: l.inwardIssue.key, to: jiraIssue.key });
  }
  return out;
}

/** Board dependency edges -> `{ key, kind, from, to, dep }` over Jira keys; edges to untracked issues are dropped. */
export function boardLinksOf(deps, keyById) {
  const out = [];
  for (const d of deps) {
    const blocker = keyById.get(d.dependsOnId);
    const blocked = keyById.get(d.issueId);
    if (!blocker || !blocked) continue;
    if (BLOCKING_TYPES.has(d.type)) out.push({ key: linkKey("blocks", blocker, blocked), kind: "blocks", from: blocker, to: blocked, dep: d });
    else if (d.type === "related_to") out.push({ key: linkKey("relates", blocker, blocked), kind: "relates", from: blocker, to: blocked, dep: d });
  }
  return out;
}

/** The board's refusal text, trimmed to the reason ("Adding this dependency would create a cycle" -> "would create a cycle"). */
function linkRefusalReason(err) {
  const m = String(err?.message ?? err ?? "refused").replace(/^sync:\s*/i, "");
  return m.replace(/^Adding this dependency\s+/i, "");
}

export const uniqueByDepId = (deps) => [...new Map(deps.map((d) => [d.id, d])).values()];

/**
 * The pull half. `idByKey`: Jira key -> board issue id for every synced issue (incl. ones created this run).
 * @returns {{ nextLinks, details, created, removed, skipped, unsupported, conflicted, snapshotAdjust }}
 *   `snapshotAdjust`: push-snapshot link keys to `add` (pull wrote them, do not echo), `drop` (pull removed them) and
 *   `forget`/`extra` (board-owned: make the next push restore the Jira side from the board).
 */
export async function runLinkPull(boardClient, { jiraIssues, idByKey, knownLinks = {}, directions, dryRun = false }) {
  const pulls = pullsField(directions, "links");
  const seen = new Set(jiraIssues.map((i) => i.key));
  const details = [];
  const adjust = { add: [], drop: [], forget: [], extra: [] };
  const nextLinks = { ...knownLinks };
  let unsupported = 0;
  let skipped = 0;
  let created = 0;
  let removed = 0;
  let conflicted = 0;

  const desired = new Map();
  for (const issue of jiraIssues) {
    for (const l of jiraLinksOf(issue)) {
      if (l.kind === "other") unsupported++;
      else desired.set(linkKey(l.kind, l.from, l.to), l);
    }
  }
  const synced = (k) => idByKey.has(k) || seen.has(k);
  const inScope = new Map();
  const outOfScope = new Set();
  for (const [k, l] of desired) {
    const outside = [l.from, l.to].filter((x) => !synced(x));
    if (outside.length > 0) {
      skipped++;
      outOfScope.add(k);
      details.push({ key: k, action: "skip", reason: `other end ${outside.join(", ")} is outside the synced scope` });
    } else inScope.set(k, l);
  }

  const depsCache = new Map();
  const depsOf = async (issueId) => {
    if (!depsCache.has(issueId)) depsCache.set(issueId, uniqueByDepId((await boardClient.getDependencies(issueId)).dependencies ?? []));
    return depsCache.get(issueId);
  };
  const keyById = new Map([...idByKey].map(([k, id]) => [id, k]));

  for (const [k, l] of inScope) {
    if (nextLinks[k]) continue;
    const fromId = idByKey.get(l.from);
    const toId = idByKey.get(l.to);
    const existing = fromId && toId ? boardLinksOf(await depsOf(toId), keyById).find((b) => b.key === k) : undefined;
    if (existing) {
      nextLinks[k] = { kind: l.kind, from: l.from, to: l.to, pluginCreated: false, boardDependencyId: existing.dep.id };
      continue;
    }
    if (!pulls) {
      // Jira has a link the board (which owns links) does not: the next push removes it from Jira.
      adjust.extra.push(k);
      details.push({ key: k, action: "drift", reason: "Jira link missing on the board; board-to-jira will remove it" });
      continue;
    }
    let boardDependencyId;
    if (!dryRun) {
      // A dependency the board refuses (a cycle, a missing end) is skipped and reported; the pull goes on (#1718).
      let dep;
      try {
        dep = await boardClient.addDependency(toId, fromId, l.kind === "blocks" ? "depends_on" : "related_to");
      } catch (err) {
        skipped++;
        details.push({ key: k, action: "skip", from: l.from, to: l.to, reason: `skipped ${l.from}→${l.to}: ${linkRefusalReason(err)}` });
        continue;
      }
      boardDependencyId = dep?.id;
      nextLinks[k] = { kind: l.kind, from: l.from, to: l.to, pluginCreated: true, boardDependencyId };
      adjust.add.push(k);
    }
    created++;
    details.push({ key: k, action: "link-create", from: l.from, to: l.to, kind: l.kind });
  }

  for (const [k, known] of Object.entries(knownLinks)) {
    if (desired.has(k) || outOfScope.has(k)) continue;
    // A missing link only counts as removed when Jira was actually asked about both ends.
    if (!seen.has(known.from) || !seen.has(known.to)) continue;
    if (!pulls) {
      delete nextLinks[k];
      adjust.forget.push(k);
      continue;
    }
    if (known.pluginCreated) {
      const toId = idByKey.get(known.to);
      const present = toId ? (await depsOf(toId)).some((d) => d.id === known.boardDependencyId) : false;
      if (!dryRun) {
        if (present) await boardClient.removeDependency(toId, known.boardDependencyId);
        delete nextLinks[k];
        adjust.drop.push(k);
      }
      removed++;
      details.push({ key: k, action: "link-remove", from: known.from, to: known.to, kind: known.kind });
    } else {
      conflicted++;
      if (!dryRun) delete nextLinks[k];
      details.push({
        key: `link:${k}`,
        action: "conflict",
        reason: "link removed in Jira, but its board dependency was not created by the plugin; kept",
      });
    }
  }

  if (!pulls) {
    // Board-owned links that Jira lacks are restored from the board by the next push.
    for (const issue of jiraIssues) {
      const id = idByKey.get(issue.key);
      if (!id) continue;
      for (const b of boardLinksOf(await depsOf(id), keyById)) {
        if (!desired.has(b.key) && seen.has(b.from) && seen.has(b.to) && !adjust.forget.includes(b.key)) adjust.forget.push(b.key);
      }
    }
  }

  return { nextLinks, details, created, removed, skipped, unsupported, conflicted, snapshotAdjust: adjust };
}

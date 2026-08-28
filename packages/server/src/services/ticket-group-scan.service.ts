/**
 * Ticket-group scan (#661): consolidate an EXISTING backlog of too-granular tickets.
 *
 * One AI pass over a project's open Backlog/Todo tickets proposes GROUPS — sets of
 * tickets that share a code surface and are cheaper implemented together in one
 * workspace (one agent, one review, one merge-gate run). Applying a proposal writes
 * `coupled_with` edges (star topology from the lowest-numbered member — the coupled
 * COMPONENT is what matters, per `resolveCoupledComponent`), which is the same signal
 * the monitor's auto-group start (`resolveAutoStartGroupMembers`) and the destructive
 * `contract_coupled_issues` both consume. Nothing is merged, renamed, or cancelled —
 * every ticket keeps its identity; this is purely "declare what belongs together".
 *
 * Preview-first like backlog import: the default returns proposals without writing;
 * `apply: true` (or per-proposal confirmation from the caller) creates the edges.
 */
import { randomUUID } from "node:crypto";
import { extractModelJson } from "@agentic-kanban/shared/lib/model-json";
import type { TouchedFile } from "@agentic-kanban/shared";
import { isRegistrationFile, normalizeContentionPath } from "@agentic-kanban/shared/lib/file-contention";
import { MAX_TICKET_GROUP_SIZE } from "@agentic-kanban/shared/lib/ticket-group";
import type { Database } from "../db/index.js";
import { invokeClaudePrompt } from "./claude-cli.service.js";
import {
  getCoupledEdges,
  getOpenIssuesWithNode,
  getProjectDependencyEdges,
  getTerminalStatusIds,
  insertIssueDependencySafe,
} from "../repositories/issue-ai.repository.js";
import { getProjectIssuesTouchedFilesWithStatus } from "../repositories/issue/touched-files.repository.js";
import { getStatusIdsByName } from "../repositories/project-status.repository.js";

export interface TicketGroupProposal {
  /** Issue numbers, lowest first (the monitor would pick the lowest as group lead). */
  issueNumbers: number[];
  issueIds: string[];
  titles: string[];
  rationale: string;
  /** Pairs inside the proposal that ALREADY carry a coupled_with edge (informational). */
  alreadyCoupledPairs: number;
}

export interface TicketGroupScanResult {
  proposals: TicketGroupProposal[];
  /** Proposals the scan dropped, with the reason — surfaced so a preview is honest. */
  rejected: Array<{ issueNumbers: number[]; reason: string }>;
  scannedCount: number;
  /** Only set when apply=true: number of coupled_with edges actually created. */
  createdEdges?: number;
}

const MAX_PROPOSAL_SIZE = 8;
const DESCRIPTION_SNIPPET_LENGTH = 600;

/**
 * Timeout budget for the one model call (#665). Base + per-candidate, capped: a 17-ticket
 * backlog gets ~2.5 min and a 100-ticket one the 10-minute ceiling, instead of every size
 * sharing `invokeClaudePrompt`'s 60s default and the big ones always failing.
 */
const GROUP_SCAN_BASE_TIMEOUT_MS = 90_000;
const GROUP_SCAN_MS_PER_TICKET = 4_000;
const GROUP_SCAN_TIMEOUT_CAP_MS = 600_000;

export async function scanForTicketGroups(
  projectId: string,
  database: Database,
  opts: { apply?: boolean } = {},
): Promise<TicketGroupScanResult> {
  const candidateStatusIds = new Set(await getStatusIdsByName(projectId, ["Backlog", "Todo"], database));
  if (candidateStatusIds.size === 0) {
    return { proposals: [], rejected: [], scannedCount: 0 };
  }
  const all = await getOpenIssuesWithNode(projectId, database);
  const candidates = all.filter((i) => i.statusId != null && candidateStatusIds.has(i.statusId) && i.issueNumber != null);
  if (candidates.length < 2) {
    return { proposals: [], rejected: [], scannedCount: candidates.length };
  }

  const byNumber = new Map(candidates.map((i) => [i.issueNumber as number, i]));
  const edges = await getProjectDependencyEdges(projectId, database);
  const coupled = await getCoupledEdges(projectId, database);
  const coupledPairs = new Set(coupled.map((e) => pairKey(e.issueId, e.dependsOnId)));
  // A pre-existing sequential edge means the pair is ORDERED — grouping it into one
  // parallel workspace contradicts the declared ordering (same guard as the analyzer's
  // coupling rule, #916).
  const sequentialPairs = new Set(
    edges.filter((e) => e.type === "depends_on" || e.type === "blocked_by").map((e) => pairKey(e.from, e.to)),
  );

  const listing = candidates
    .map((i) => {
      const desc = (i.description ?? "").replace(/\s+/g, " ").slice(0, DESCRIPTION_SNIPPET_LENGTH);
      return `#${i.issueNumber}: ${i.title}\n  ${desc || "(no description)"}`;
    })
    .join("\n");

  const prompt = `You are consolidating a kanban backlog whose tickets are too granular: adjacent tickets that touch the same code cost one full agent worktree + review + merge-gate run EACH, when a group of them could share one.

Below are the open backlog tickets of one project. Propose GROUPS of 2-${MAX_PROPOSAL_SIZE} tickets that should be implemented together in ONE workspace because they touch the same files/subsystem, follow the same mechanical pattern, or one's change surface subsumes another's.

Rules:
- Group by shared CODE SURFACE or shared mechanical pattern, never by mere topical similarity.
- Never put two tickets in one group when one clearly must land before the other can start (that is a sequential dependency, not a group).
- Prefer several small confident groups over one sprawling one. A ticket appears in at most one group.
- Do not force it: leave tickets ungrouped when unsure.

Tickets:
${listing}

Respond with JSON only:
{"groups": [{"issueNumbers": [12, 14, 15], "rationale": "one sentence naming the shared surface"}]}`;

  // #665 — the 60s default is far too short for THIS operation. The prompt embeds every open
  // backlog ticket with a description snippet, and the feature exists for backlogs that are
  // "too granular", i.e. long ones — 17 tickets already timed the call out on this board.
  // Nobody watches a spinner for a batch consolidation, so scale the budget with the input
  // rather than making the operator retry into the same wall.
  const timeout = Math.min(GROUP_SCAN_TIMEOUT_CAP_MS, GROUP_SCAN_BASE_TIMEOUT_MS + candidates.length * GROUP_SCAN_MS_PER_TICKET);
  const stdout = await invokeClaudePrompt(prompt, { database, timeout });
  const parsed = extractModelJson(stdout, { shape: "object" }) as {
    groups?: Array<{ issueNumbers?: unknown; rationale?: unknown }>;
  };

  const proposals: TicketGroupProposal[] = [];
  const rejected: Array<{ issueNumbers: number[]; reason: string }> = [];
  const claimed = new Set<number>();
  for (const raw of parsed.groups ?? []) {
    const numbers = Array.isArray(raw.issueNumbers)
      ? [...new Set(raw.issueNumbers.filter((n): n is number => typeof n === "number"))].sort((a, b) => a - b)
      : [];
    const rationale = typeof raw.rationale === "string" ? raw.rationale : "";
    if (numbers.length < 2) {
      if (numbers.length > 0) rejected.push({ issueNumbers: numbers, reason: "fewer than 2 valid members" });
      continue;
    }
    if (numbers.length > MAX_PROPOSAL_SIZE) {
      rejected.push({ issueNumbers: numbers, reason: `larger than the ${MAX_PROPOSAL_SIZE}-ticket cap` });
      continue;
    }
    const unknown = numbers.filter((n) => !byNumber.has(n));
    if (unknown.length > 0) {
      rejected.push({ issueNumbers: numbers, reason: `not open backlog tickets: #${unknown.join(", #")}` });
      continue;
    }
    const overlapping = numbers.filter((n) => claimed.has(n));
    if (overlapping.length > 0) {
      rejected.push({ issueNumbers: numbers, reason: `already claimed by an earlier group: #${overlapping.join(", #")}` });
      continue;
    }
    const members = numbers.map((n) => byNumber.get(n)!);
    const sequentialInside = pairsOf(members.map((m) => m.id)).filter((p) => sequentialPairs.has(p));
    if (sequentialInside.length > 0) {
      rejected.push({ issueNumbers: numbers, reason: "members carry a sequential (depends_on/blocked_by) edge between them" });
      continue;
    }
    numbers.forEach((n) => claimed.add(n));
    proposals.push({
      issueNumbers: numbers,
      issueIds: members.map((m) => m.id),
      titles: members.map((m) => m.title),
      rationale,
      alreadyCoupledPairs: pairsOf(members.map((m) => m.id)).filter((p) => coupledPairs.has(p)).length,
    });
  }

  const result: TicketGroupScanResult = { proposals, rejected, scannedCount: candidates.length };

  if (opts.apply && proposals.length > 0) {
    result.createdEdges = await applyTicketGroupProposals(proposals, coupledPairs, database);
  }
  return result;
}

/**
 * Write the coupled_with edges for accepted proposals: a star from the lowest-numbered
 * member. `coupled_with` is symmetric and the consumers resolve the CONNECTED COMPONENT,
 * so a star declares the same group as a full clique at N-1 edges instead of N*(N-1)/2.
 */
export async function applyTicketGroupProposals(
  proposals: TicketGroupProposal[],
  existingCoupledPairs: Set<string>,
  database: Database,
): Promise<number> {
  const now = new Date().toISOString();
  let created = 0;
  for (const proposal of proposals) {
    const [anchor, ...rest] = proposal.issueIds;
    for (const other of rest) {
      if (existingCoupledPairs.has(pairKey(anchor, other))) continue;
      await insertIssueDependencySafe(
        { id: randomUUID(), issueId: anchor, dependsOnId: other, type: "coupled_with", createdAt: now },
        database,
      );
      existingCoupledPairs.add(pairKey(anchor, other));
      created++;
    }
  }
  return created;
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function pairsOf(ids: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) out.push(pairKey(ids[i], ids[j]));
  }
  return out;
}

/**
 * #918: seed `coupled_with` from `issues.touchedFilesJson` — a DETERMINISTIC grouping
 * signal (no LLM call) so a cold backlog (freshly decomposed/imported/enhanced, zero
 * `coupled_with` edges yet) still forms ticket groups. `scanForTicketGroups` above needs
 * an AI pass and is the tool for consolidating an established backlog; this is the seed
 * that gives auto_group_coupled something to work with the moment tickets exist.
 *
 * Two tickets are proposed as coupled when they share at least `minSharedFiles` predicted
 * files — EXCLUDING hot/registration files (`isRegistrationFile`, #119's contention
 * vocabulary): a shared `app.ts`/`routes.ts` means CONTENTION (two tickets will conflict
 * editing the same wiring file), not COUPLING (these tickets belong in one workspace). A
 * shared narrow, non-hot file (a specific model/component/service) is the actual signal.
 *
 * Sequential (`depends_on`/`blocked_by`) pairs are excluded — same rule as
 * `scanForTicketGroups` and the monitor's own auto-group start: grouping declares "start
 * together", which contradicts a declared ordering.
 *
 * Connected components are computed over the qualifying pairs and capped at
 * `MAX_TICKET_GROUP_SIZE` — an oversized component is split into that many
 * lowest-numbered-first chunks rather than dropped, so a hot subsystem still yields
 * usable (smaller) groups instead of nothing.
 */
export async function scanTouchedFilesForTicketGroups(
  projectId: string,
  database: Database,
  opts: { apply?: boolean; minSharedFiles?: number } = {},
): Promise<TicketGroupScanResult> {
  const minSharedFiles = Math.max(1, opts.minSharedFiles ?? 2);
  const candidateStatusIds = new Set(await getStatusIdsByName(projectId, ["Backlog", "Todo"], database));
  if (candidateStatusIds.size === 0) {
    return { proposals: [], rejected: [], scannedCount: 0 };
  }
  const all = await getProjectIssuesTouchedFilesWithStatus(projectId, database);
  const candidates = all.filter((i) => i.statusId != null && candidateStatusIds.has(i.statusId) && i.issueNumber != null);
  if (candidates.length < 2) {
    return { proposals: [], rejected: [], scannedCount: candidates.length };
  }

  const byId = new Map(candidates.map((i) => [i.id, i]));
  const filesByIssue = new Map<string, Set<string>>();
  for (const issue of candidates) {
    if (!issue.touchedFilesJson) continue;
    let parsed: TouchedFile[];
    try { parsed = JSON.parse(issue.touchedFilesJson) as TouchedFile[]; } catch { continue; }
    const paths = new Set(
      parsed
        .map((f) => normalizeContentionPath(f.path))
        .filter((p) => p && !isRegistrationFile(p)),
    );
    if (paths.size > 0) filesByIssue.set(issue.id, paths);
  }
  if (filesByIssue.size < 2) {
    return { proposals: [], rejected: [], scannedCount: candidates.length };
  }

  const edges = await getProjectDependencyEdges(projectId, database);
  const coupled = await getCoupledEdges(projectId, database);
  const coupledPairs = new Set(coupled.map((e) => pairKey(e.issueId, e.dependsOnId)));
  const sequentialPairs = new Set(
    edges.filter((e) => e.type === "depends_on" || e.type === "blocked_by").map((e) => pairKey(e.from, e.to)),
  );

  const qualifyingIds = [...filesByIssue.keys()];
  const adjacency = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    let s = adjacency.get(a);
    if (!s) { s = new Set(); adjacency.set(a, s); }
    s.add(b);
  };
  for (let i = 0; i < qualifyingIds.length; i++) {
    for (let j = i + 1; j < qualifyingIds.length; j++) {
      const a = qualifyingIds[i];
      const b = qualifyingIds[j];
      if (sequentialPairs.has(pairKey(a, b))) continue;
      const shared = [...filesByIssue.get(a)!].filter((f) => filesByIssue.get(b)!.has(f));
      if (shared.length >= minSharedFiles) link(a, b);
    }
  }

  // Connected components over the qualifying-pair graph.
  const visited = new Set<string>();
  const components: string[][] = [];
  for (const id of qualifyingIds) {
    if (visited.has(id) || !adjacency.has(id)) continue;
    const component: string[] = [];
    const stack = [id];
    visited.add(id);
    while (stack.length > 0) {
      const cur = stack.pop()!;
      component.push(cur);
      for (const next of adjacency.get(cur) ?? []) {
        if (visited.has(next)) continue;
        visited.add(next);
        stack.push(next);
      }
    }
    if (component.length >= 2) components.push(component);
  }

  const proposals: TicketGroupProposal[] = [];
  const rejected: Array<{ issueNumbers: number[]; reason: string }> = [];
  for (const component of components) {
    const sortedIds = component
      .map((id) => byId.get(id)!)
      .sort((a, b) => (a.issueNumber as number) - (b.issueNumber as number))
      .map((i) => i.id);
    for (let start = 0; start < sortedIds.length; start += MAX_TICKET_GROUP_SIZE) {
      const chunkIds = sortedIds.slice(start, start + MAX_TICKET_GROUP_SIZE);
      if (chunkIds.length < 2) continue;
      const members = chunkIds.map((id) => byId.get(id)!);
      const numbers = members.map((m) => m.issueNumber as number);
      proposals.push({
        issueNumbers: numbers,
        issueIds: chunkIds,
        titles: members.map((m) => m.title),
        rationale: `Share >= ${minSharedFiles} predicted file(s) outside registration/hot files`,
        alreadyCoupledPairs: pairsOf(chunkIds).filter((p) => coupledPairs.has(p)).length,
      });
    }
    if (sortedIds.length > MAX_TICKET_GROUP_SIZE) {
      rejected.push({
        issueNumbers: sortedIds.map((id) => byId.get(id)!.issueNumber as number),
        reason: `component larger than the ${MAX_TICKET_GROUP_SIZE}-ticket cap; split into smaller groups`,
      });
    }
  }

  const result: TicketGroupScanResult = { proposals, rejected, scannedCount: candidates.length };
  if (opts.apply && proposals.length > 0) {
    result.createdEdges = await applyTicketGroupProposals(proposals, coupledPairs, database);
  }
  return result;
}

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitExec } from "@agentic-kanban/shared/lib/git-exec";
import {
  countScaffoldPlaceholders,
  pluginSkillName,
  type PluginManifest,
} from "@agentic-kanban/shared/lib/plugin-manifest";
import type { Database } from "../db/index.js";
import { PluginError } from "./plugin-errors.js";
import { looksLikeGitUrl, readManifestFromDir, resolveInside, commitPathWithRetry } from "./plugin-fs.js";
import { parseScaffoldFields, applyScaffoldValues } from "./plugin-scaffold.js";
import { listPluginLoopSessionStats } from "../repositories/plugins.repository.js";
import type { PluginRow } from "../repositories/plugins.repository.js";
import type { PluginLoopEngine } from "./plugin-loop.service.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

/**
 * The plugin service's LOOP-ADJACENT reads and writes added for #286–#295 —
 * gate resolution, the audit timeline + cost rollup, artifact reads, the
 * scaffold form, and offline manifest validation. Extracted from
 * `plugin.service.ts` when it crossed the 1000-line god-module ceiling; the
 * service composes this with its own closures (same pattern as
 * `plugin-scaffold.ts` / `plugin-views.service.ts`).
 */

type PluginWithManifest = PluginRow & { manifest: PluginManifest };

export interface PluginLoopExtrasCtx {
  database: Database;
  loops: PluginLoopEngine;
  requirePlugin: (id: string) => Promise<PluginWithManifest>;
  requireProject: (projectId: string) => Promise<{ id: string; name: string; repoPath: string }>;
  resolveOutputRepoPath: (plugin: PluginWithManifest, project: { id: string; repoPath: string }) => Promise<string>;
  resolveWorkflowTemplateId: (projectId: string, workflow: string | undefined) => Promise<string | null>;
}

/** Cap on artifact bytes returned to the panel — a doc, not a data dump. */
const ARTIFACT_CONTENT_CAP = 256 * 1024;

export function createPluginLoopExtras(ctx: PluginLoopExtrasCtx) {
  const { database, loops, requirePlugin, requireProject, resolveOutputRepoPath, resolveWorkflowTemplateId } = ctx;

  /** Apply a human's gate decision (#286), then re-plan. See plugin-loop.service. */
  async function resolveLoopGate(
    pluginRowId: string,
    loopName: string,
    projectId: string,
    body: { gateId: string; actionId: string; input?: string },
  ) {
    const plugin = await requirePlugin(pluginRowId);
    const project = await requireProject(projectId);
    const outputRepoPath = await resolveOutputRepoPath(plugin, project);
    const loopDef = (plugin.manifest.loops ?? []).find((l) => l.name === loopName);
    const skillDef = (plugin.manifest.skills ?? []).find((s) => pluginSkillName(s.dir) === loopDef?.skill);
    const workflowTemplateId = await resolveWorkflowTemplateId(projectId, loopDef?.workflow ?? skillDef?.workflow);
    return loops.resolveGate({
      manifest: plugin.manifest,
      pluginSlug: plugin.pluginId,
      pluginName: plugin.name,
      pluginRowId: plugin.id,
      pluginLocalPath: plugin.localPath,
      loopName,
      projectId,
      projectName: project.name,
      repoPath: outputRepoPath,
      leadingRepoPath: project.repoPath,
      workflowTemplateId,
      gateId: body.gateId,
      actionId: body.actionId,
      input: body.input,
    });
  }

  /**
   * The loop's audit timeline (#292) plus the per-unit cost rollup (#294) — one
   * read for the timeline pane. Costs fold each session's persisted
   * `stats.totalCostUsd`/token counts, keyed back to unit ids via `external_key`.
   */
  async function listLoopEvents(pluginRowId: string, loopName: string, projectId: string, limit = 100) {
    const plugin = await requirePlugin(pluginRowId);
    await requireProject(projectId);
    const events = await loops.loopEvents(plugin.pluginId, loopName, projectId, limit);
    const prefix = `plugin-loop:${plugin.pluginId}:${loopName}:`;
    const statRows = await listPluginLoopSessionStats(projectId, prefix, database);
    const unitCosts = new Map<string, { unitId: string; costUsd: number; sessions: number }>();
    let totalCostUsd = 0;
    for (const row of statRows) {
      const unitId = row.externalKey.slice(prefix.length);
      let costUsd = 0;
      try {
        costUsd = Number((JSON.parse(row.stats ?? "{}") as { totalCostUsd?: unknown }).totalCostUsd ?? 0) || 0;
      } catch { /* unparseable stats row — count the session, not the cost */ }
      const entry = unitCosts.get(unitId) ?? { unitId, costUsd: 0, sessions: 0 };
      entry.costUsd += costUsd;
      entry.sessions += 1;
      unitCosts.set(unitId, entry);
      totalCostUsd += costUsd;
    }
    return {
      events: events.map((e) => ({
        id: e.id,
        type: e.type,
        payload: e.payloadJson ? (JSON.parse(e.payloadJson) as unknown) : null,
        createdAt: e.createdAt,
      })),
      cost: {
        totalUsd: totalCostUsd,
        byUnit: [...unitCosts.values()].sort((a, b) => b.costUsd - a.costUsd),
      },
    };
  }

  /**
   * Read one declared loop artifact from the OUTPUT repo (#288): current content,
   * its last two commits, and — only when asked for — the v(N-1)→vN diff. Content is
   * read fresh per request — the artifact is the plugin's file, the board only renders it.
   *
   * `withDiff` is the #421 fix. The viewer opens on the Rendered tab and shows the diff
   * only once the user selects the Diff tab, but this function used to compute the diff
   * on EVERY open. Reading the file is sub-millisecond; each `git` spawn is tens of
   * milliseconds, and it dominated the endpoint (a flat ~65ms regardless of file size,
   * versus 11-15ms for its sibling plugin endpoints). The `git log` stays eager because
   * its result decides whether a Diff tab is offered at all; the `git diff` is deferred
   * to the request that actually renders it.
   */
  async function getLoopArtifact(
    pluginRowId: string,
    projectId: string,
    relPath: string,
    opts: { withDiff?: boolean } = {},
  ) {
    const plugin = await requirePlugin(pluginRowId);
    const project = await requireProject(projectId);
    const repoPath = await resolveOutputRepoPath(plugin, project);
    // Same containment rule as every manifest path — no absolute paths, no `..` escapes.
    const abs = resolveInside(repoPath, relPath, `artifact path "${relPath}"`);
    if (!existsSync(abs)) {
      return {
        path: relPath,
        exists: false as const,
        content: null,
        truncated: false,
        commits: [],
        diff: null,
        hasPreviousVersion: false,
      };
    }
    const raw = readFileSync(abs, "utf8");
    const truncated = raw.length > ARTIFACT_CONTENT_CAP;

    // Last two commits touching the file → the v(N-1)→vN diff (#288). Best-effort:
    // an artifact in a repo with no history is still renderable.
    let commits: Array<{ sha: string; date: string }> = [];
    let diff: string | null = null;
    try {
      const log = await gitExec(["log", "-n", "2", "--format=%H|%cI", "--", relPath], { cwd: repoPath });
      commits = log.stdout.trim().split("\n").filter(Boolean).map((line) => {
        const [sha, date] = line.split("|");
        return { sha, date };
      });
      if (commits.length === 2 && opts.withDiff) {
        const d = await gitExec(["diff", commits[1].sha, commits[0].sha, "--", relPath], { cwd: repoPath });
        diff = d.stdout.slice(0, ARTIFACT_CONTENT_CAP) || null;
      }
    } catch { /* not a git repo / git unavailable — content alone is still useful */ }

    return {
      path: relPath,
      exists: true as const,
      content: truncated ? raw.slice(0, ARTIFACT_CONTENT_CAP) : raw,
      truncated,
      commits,
      diff,
      // Whether a diff EXISTS to be fetched — the client offers the Diff tab on this,
      // then re-requests with `withDiff=1`. Without it a deferred diff would be
      // indistinguishable from "this artifact has no previous version".
      hasPreviousVersion: commits.length === 2,
    };
  }

  /** The scaffold file as a form (#291): its unresolved TODO fields + full content. */
  async function getScaffoldForm(pluginRowId: string, projectId: string) {
    const plugin = await requirePlugin(pluginRowId);
    const project = await requireProject(projectId);
    const scaffold = plugin.manifest.scaffold;
    // #658: "this plugin declares no scaffold" is a legitimate ANSWER to a read, not an
    // error. Throwing NOT_FOUND made every Plugins-panel poll a 404 — dozens a minute of
    // console noise for a plugin that is behaving exactly as designed, and noise like that is
    // what trains people to ignore the console. The write paths below still refuse: acting on
    // a scaffold that does not exist IS an error. `targetPath: null` is the discriminator.
    if (!scaffold) {
      return { targetPath: null, exists: false as const, content: null, fields: [] };
    }
    const repoPath = await resolveOutputRepoPath(plugin, project);
    const target = resolveInside(repoPath, scaffold.targetPath, `scaffold targetPath "${scaffold.targetPath}"`);
    if (!existsSync(target)) {
      return { targetPath: scaffold.targetPath, exists: false as const, content: null, fields: [] };
    }
    const content = readFileSync(target, "utf8");
    return { targetPath: scaffold.targetPath, exists: true as const, content, fields: parseScaffoldFields(content) };
  }

  /** Write form values into the scaffold's TODO markers in place (#291). */
  async function fillScaffoldForm(
    pluginRowId: string,
    projectId: string,
    values: Array<{ index: number; value: string }>,
  ) {
    const plugin = await requirePlugin(pluginRowId);
    const project = await requireProject(projectId);
    const scaffold = plugin.manifest.scaffold;
    if (!scaffold) throw new PluginError("This plugin declares no scaffold", "NOT_FOUND");
    const repoPath = await resolveOutputRepoPath(plugin, project);
    const target = resolveInside(repoPath, scaffold.targetPath, `scaffold targetPath "${scaffold.targetPath}"`);
    if (!existsSync(target)) throw new PluginError(`Scaffold file not found: ${scaffold.targetPath}`, "NOT_FOUND");
    const { content, remaining } = applyScaffoldValues(readFileSync(target, "utf8"), values);
    writeFileSync(target, content, "utf8");
    // #324: COMMIT the filled scaffold. Loop step agents run in worktrees branched
    // from the base branch, so an uncommitted profile is invisible to them — the
    // planner (main checkout) passes its TODO check while every step ticket halts
    // on a missing profile. Best-effort: a non-git output repo still gets the file.
    const committed = await commitPathWithRetry(
      repoPath,
      scaffold.targetPath,
      `plugin: fill ${plugin.pluginId} scaffold ${scaffold.targetPath}`,
    );
    return { targetPath: scaffold.targetPath, remaining, fields: parseScaffoldFields(content), committed };
  }

  /**
   * Overwrite the scaffold file wholesale (#438).
   *
   * `fillScaffoldForm` addresses `TODO:` markers by index, so once the profile is
   * complete it has no markers left and therefore no way to change anything. That
   * made a mis-filled profile PERMANENT from the board's side — and the profile is
   * the scope contract every step agent reads first. Live cost: the `mealplan`
   * pipeline diagnosed its own mislabeled profile at step 1, could not act on it,
   * and re-explained it in steps 2-5, stamping a caveat block into every artifact.
   *
   * Commits for the same reason `fillScaffoldForm` does (#324): step tickets run in
   * worktrees branched from the base branch, so an uncommitted profile is invisible
   * to them and they halt on a profile that looks unfilled.
   */
  async function saveScaffoldContent(pluginRowId: string, projectId: string, newContent: string) {
    const plugin = await requirePlugin(pluginRowId);
    const project = await requireProject(projectId);
    const scaffold = plugin.manifest.scaffold;
    if (!scaffold) throw new PluginError("This plugin declares no scaffold", "NOT_FOUND");
    if (!newContent.trim()) {
      throw new PluginError("Refusing to write an empty scaffold — the profile is the plugin's scope contract", "BAD_REQUEST");
    }
    const repoPath = await resolveOutputRepoPath(plugin, project);
    const target = resolveInside(repoPath, scaffold.targetPath, `scaffold targetPath "${scaffold.targetPath}"`);
    if (!existsSync(target)) throw new PluginError(`Scaffold file not found: ${scaffold.targetPath}`, "NOT_FOUND");
    writeFileSync(target, newContent, "utf8");
    const committed = await commitPathWithRetry(
      repoPath,
      scaffold.targetPath,
      `plugin: edit ${plugin.pluginId} scaffold ${scaffold.targetPath}`,
    );
    return {
      targetPath: scaffold.targetPath,
      remaining: countScaffoldPlaceholders(newContent),
      fields: parseScaffoldFields(newContent),
      content: newContent,
      committed,
    };
  }

  /** The loop's CURRENT gate + the context the concierge endpoints need. */
  async function requireCurrentGate(pluginRowId: string, loopName: string, projectId: string) {
    const plugin = await requirePlugin(pluginRowId);
    const project = await requireProject(projectId);
    const repoPath = await resolveOutputRepoPath(plugin, project);
    const statuses = await loops.loopStatuses(plugin.manifest, plugin.pluginId, projectId);
    const status = statuses.find((s) => s.name === loopName);
    if (!status) throw new PluginError(`Loop "${loopName}" not found`, "NOT_FOUND");
    if (!status.gate) throw new PluginError(`Loop "${loopName}" is not blocked on a gate`, "BAD_REQUEST");
    return { plugin, project, repoPath, status, gate: status.gate };
  }

  /**
   * Edit-then-approve (#305): overwrite ONE of the current gate's artifacts with the
   * human's edited content and commit it pathspec-limited (retried — the board's own
   * merge jobs contend on `.git/index.lock`, the #296 failure class). Restricted to
   * the gate's declared artifacts: this endpoint is a review-time red pen, not a
   * general file-write API.
   */
  async function saveLoopArtifact(
    pluginRowId: string,
    loopName: string,
    projectId: string,
    body: { gateId: string; path: string; content: string },
  ) {
    const { repoPath, gate } = await requireCurrentGate(pluginRowId, loopName, projectId);
    if (gate.id !== body.gateId) {
      throw new PluginError(`Gate "${body.gateId}" is stale — the loop's current gate is "${gate.id}"`, "BAD_REQUEST");
    }
    if (!(gate.artifacts ?? []).includes(body.path)) {
      throw new PluginError(`"${body.path}" is not one of this gate's artifacts`, "BAD_REQUEST");
    }
    const abs = resolveInside(repoPath, body.path, `artifact path "${body.path}"`);
    writeFileSync(abs, body.content, "utf8");
    const committed = await commitPathWithRetry(
      repoPath, body.path, `plugin: human edit of ${body.path} at gate ${gate.id}`,
    );
    return { path: body.path, committed };
  }

  /** Draft-with-butler (#310): the human's rough notes → submit-ready revision feedback. */
  async function draftLoopGateFeedback(
    pluginRowId: string,
    loopName: string,
    projectId: string,
    body: { gateId: string; notes: string },
  ) {
    const { repoPath, gate, status } = await requireCurrentGate(pluginRowId, loopName, projectId);
    if (gate.id !== body.gateId) {
      throw new PluginError(`Gate "${body.gateId}" is stale — the loop's current gate is "${gate.id}"`, "BAD_REQUEST");
    }
    if (!body.notes?.trim()) throw new PluginError("notes are required", "BAD_REQUEST");
    const { draftGateFeedback } = await import("./plugin-gate-butler.service.js");
    const draft = await draftGateFeedback(
      { projectId, gate, checks: status.checks, notes: body.notes.trim(), repoPath },
      database,
    );
    return { draft };
  }

  /** Summarize-for-me (#330): one-click decision-ready digest of the current gate's artifacts. */
  async function summarizeLoopGate(
    pluginRowId: string,
    loopName: string,
    projectId: string,
    body: { gateId: string },
  ) {
    const { repoPath, gate, status } = await requireCurrentGate(pluginRowId, loopName, projectId);
    if (gate.id !== body.gateId) {
      throw new PluginError(`Gate "${body.gateId}" is stale — the loop's current gate is "${gate.id}"`, "BAD_REQUEST");
    }
    const { summarizeGateArtifacts } = await import("./plugin-gate-butler.service.js");
    const summary = await summarizeGateArtifacts(
      { projectId, gate, checks: status.checks, repoPath },
      database,
    );
    return { summary };
  }

  return { resolveLoopGate, listLoopEvents, getLoopArtifact, getScaffoldForm, fillScaffoldForm, saveScaffoldContent, saveLoopArtifact, draftLoopGateFeedback, summarizeLoopGate };
}

/**
 * Validate a plugin source WITHOUT installing (#295): parse the manifest and
 * check that every file it references exists. Local directories only — a git
 * URL would mean cloning, which is what install does. Pure module function: it
 * needs no service closure.
 */
// Stays `async` deliberately: every sibling validator here is async and callers `await` it,
// so making this one sync would be a breaking signature change for a purely local win.
// eslint-disable-next-line @typescript-eslint/require-await
export async function validatePluginSource(source: string) {
  const errors: string[] = [];
  const warnings: string[] = [];
  const dir = source.trim();
  if (!dir) return { ok: false, errors: ["source is required"], warnings };
  if (looksLikeGitUrl(dir)) {
    return { ok: false, errors: ["validate takes a local directory — install clones git sources"], warnings };
  }
  if (!existsSync(dir)) return { ok: false, errors: [`directory not found: ${dir}`], warnings };

  let manifest: PluginManifest;
  try {
    manifest = readManifestFromDir(dir).manifest;
  } catch (err) {
    return { ok: false, errors: [errorMessage(err)], warnings };
  }
  for (const skill of manifest.skills ?? []) {
    const skillDir = resolveInside(dir, skill.dir, `skill dir "${skill.dir}"`);
    if (!existsSync(skillDir)) errors.push(`skill dir not found: ${skill.dir}`);
    else if (!existsSync(join(skillDir, "SKILL.md"))) errors.push(`no SKILL.md in ${skill.dir}`);
  }
  if (manifest.butler?.promptFragment
    && !existsSync(resolveInside(dir, manifest.butler.promptFragment, "butler.promptFragment"))) {
    errors.push(`butler.promptFragment not found: ${manifest.butler.promptFragment}`);
  }
  if (manifest.scaffold
    && !existsSync(resolveInside(dir, manifest.scaffold.profileTemplate, "scaffold.profileTemplate"))) {
    errors.push(`scaffold.profileTemplate not found: ${manifest.scaffold.profileTemplate}`);
  }
  for (const loop of manifest.loops ?? []) {
    if (!loop.plan.command.trim()) errors.push(`loop "${loop.name}" has an empty plan command`);
  }
  if ((manifest.loops ?? []).length === 0 && (manifest.skills ?? []).length === 0
    && (manifest.views ?? []).length === 0 && (manifest.scripts ?? []).length === 0) {
    warnings.push("manifest declares no skills, views, scripts or loops — enabling it will do nothing");
  }
  return {
    ok: errors.length === 0,
    manifest: { id: manifest.id, name: manifest.name, version: manifest.version ?? null },
    errors,
    warnings,
  };
}

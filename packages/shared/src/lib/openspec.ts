import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, normalize, relative, sep } from "node:path";

export const OPENSPEC_DIR = "openspec";
export const OPENSPEC_SPECS_DIR = "openspec/specs";
export const OPENSPEC_CHANGES_DIR = "openspec/changes";

export interface OpenSpecSummary {
  domain: string;
  path: string;
}

export interface OpenSpecDetail extends OpenSpecSummary {
  content: string;
}

export interface OpenSpecDelta {
  changeId: string;
  domain: string;
  path: string;
  added: string;
  modified: string;
  removed: string;
}

export interface OpenSpecValidation {
  valid: boolean;
  deltas: OpenSpecDelta[];
  warnings: string[];
  errors: string[];
}

export interface OpenSpecApplyResult extends OpenSpecValidation {
  applied: { domain: string; path: string; actions: string[] }[];
}

const DELTA_SECTION_RE = /^##\s+(ADDED|MODIFIED|REMOVED)\b.*$/gim;
const REQUIREMENT_HEADING_RE = /^###\s+.+$/gm;

function repoRelative(path: string): string {
  return path.split(sep).join("/");
}

function assertSafeDomain(domain: string): string {
  const trimmed = domain.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(trimmed)) {
    throw new Error(`Invalid spec domain '${domain}'. Use letters, numbers, dots, underscores, or dashes.`);
  }
  return trimmed;
}

function resolveInside(root: string, relativePath: string): string {
  const full = normalize(join(root, ...relativePath.split("/")));
  const rel = relative(root, full);
  if (rel.startsWith("..") || rel === "" || normalize(rel).startsWith(`..${sep}`)) {
    throw new Error(`Path escapes repo root: ${relativePath}`);
  }
  return full;
}

function specPath(repoPath: string, domain: string): string {
  return resolveInside(repoPath, `${OPENSPEC_SPECS_DIR}/${assertSafeDomain(domain)}/spec.md`);
}

async function safeRead(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return "";
  }
}

async function walk(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

function parseDelta(content: string): Pick<OpenSpecDelta, "added" | "modified" | "removed"> {
  const sections: Pick<OpenSpecDelta, "added" | "modified" | "removed"> = {
    added: "",
    modified: "",
    removed: "",
  };
  const matches = [...content.matchAll(DELTA_SECTION_RE)];
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const next = matches[i + 1];
    const key = match[1].toLowerCase() as keyof typeof sections;
    sections[key] = content.slice((match.index ?? 0) + match[0].length, next?.index ?? content.length).trim();
  }
  return sections;
}

function deltaInfo(repoPath: string, filePath: string): { changeId: string; domain: string; rel: string } | null {
  const rel = repoRelative(relative(repoPath, filePath));
  const parts = rel.split("/");
  if (parts.length !== 6) return null;
  if (parts[0] !== "openspec" || parts[1] !== "changes" || parts[3] !== "specs" || parts[5] !== "spec.md") {
    return null;
  }
  return { changeId: parts[2], domain: parts[4], rel };
}

function splitRequirementBlocks(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const matches = [...trimmed.matchAll(REQUIREMENT_HEADING_RE)];
  if (matches.length === 0) return [trimmed];
  const blocks: string[] = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index ?? 0;
    const end = matches[i + 1]?.index ?? trimmed.length;
    blocks.push(trimmed.slice(start, end).trim());
  }
  return blocks.filter(Boolean);
}

function blockHeading(block: string): string | null {
  const first = block.split(/\r?\n/, 1)[0]?.trim();
  return first?.startsWith("### ") ? first : null;
}

function replaceRequirementBlock(spec: string, block: string): { text: string; replaced: boolean } {
  const heading = blockHeading(block);
  if (!heading) return { text: appendBlock(spec, block), replaced: false };
  const range = findRequirementRange(spec, heading);
  if (!range) return { text: appendBlock(spec, block), replaced: false };
  return {
    text: spec.slice(0, range.start) + block.trim() + "\n\n" + spec.slice(range.end),
    replaced: true,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function appendBlock(spec: string, block: string): string {
  const prefix = spec.trimEnd();
  return `${prefix}${prefix ? "\n\n" : ""}${block.trim()}\n`;
}

function removeBlock(spec: string, block: string): { text: string; removed: boolean } {
  const trimmed = block.trim();
  if (!trimmed) return { text: spec, removed: false };
  if (spec.includes(trimmed)) {
    return { text: spec.replace(trimmed, "").replace(/\n{3,}/g, "\n\n"), removed: true };
  }
  const heading = blockHeading(trimmed);
  if (heading) {
    const range = findRequirementRange(spec, heading);
    if (range) {
      return { text: (spec.slice(0, range.start) + spec.slice(range.end)).replace(/\n{3,}/g, "\n\n"), removed: true };
    }
  }
  return { text: spec, removed: false };
}

function findRequirementRange(spec: string, heading: string): { start: number; end: number } | null {
  const startRe = new RegExp(`^${escapeRegExp(heading)}\\s*$`, "m");
  const startMatch = startRe.exec(spec);
  if (!startMatch || startMatch.index === undefined) return null;
  const start = startMatch.index;
  const restStart = start + startMatch[0].length;
  const rest = spec.slice(restStart);
  const nextMatch = /^###\s+.+$/m.exec(rest);
  return { start, end: nextMatch?.index === undefined ? spec.length : restStart + nextMatch.index };
}

export async function ensureOpenSpecRoot(repoPath: string): Promise<void> {
  await mkdir(resolveInside(repoPath, OPENSPEC_SPECS_DIR), { recursive: true });
}

export async function listOpenSpecs(repoPath: string): Promise<OpenSpecSummary[]> {
  const specsDir = resolveInside(repoPath, OPENSPEC_SPECS_DIR);
  if (!existsSync(specsDir)) return [];
  const entries = await readdir(specsDir, { withFileTypes: true });
  const specs: OpenSpecSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = join(specsDir, entry.name, "spec.md");
    if (existsSync(file)) {
      specs.push({ domain: entry.name, path: repoRelative(relative(repoPath, file)) });
    }
  }
  return specs.sort((a, b) => a.domain.localeCompare(b.domain));
}

export async function showOpenSpec(repoPath: string, domain: string): Promise<OpenSpecDetail> {
  const file = specPath(repoPath, domain);
  const content = await readFile(file, "utf-8");
  return { domain: assertSafeDomain(domain), path: repoRelative(relative(repoPath, file)), content };
}

export async function findOpenSpecDeltas(repoPath: string, changeId?: string): Promise<OpenSpecDelta[]> {
  const root = resolveInside(repoPath, changeId ? `${OPENSPEC_CHANGES_DIR}/${changeId}/specs` : OPENSPEC_CHANGES_DIR);
  const files = (await walk(root)).filter((file) => basename(file) === "spec.md");
  const deltas: OpenSpecDelta[] = [];
  for (const file of files) {
    const info = deltaInfo(repoPath, file);
    if (!info) continue;
    const parsed = parseDelta(await readFile(file, "utf-8"));
    deltas.push({ changeId: info.changeId, domain: info.domain, path: info.rel, ...parsed });
  }
  return deltas.sort((a, b) => a.path.localeCompare(b.path));
}

export async function validateOpenSpecChange(repoPath: string, changeId?: string): Promise<OpenSpecValidation> {
  const deltas = await findOpenSpecDeltas(repoPath, changeId);
  const errors: string[] = [];
  const warnings: string[] = [];
  if (deltas.length === 0) {
    errors.push(changeId ? `No OpenSpec deltas found for change '${changeId}'.` : "No OpenSpec deltas found.");
  }
  const byDomain = new Map<string, OpenSpecDelta[]>();
  for (const delta of deltas) {
    try {
      assertSafeDomain(delta.domain);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
    if (!delta.added && !delta.modified && !delta.removed) {
      errors.push(`${delta.path} must contain at least one non-empty ## ADDED, ## MODIFIED, or ## REMOVED section.`);
    }
    const sameDomain = byDomain.get(delta.domain) ?? [];
    sameDomain.push(delta);
    byDomain.set(delta.domain, sameDomain);
  }
  for (const [domain, items] of byDomain) {
    if (items.length > 1) {
      warnings.push(`Multiple deltas touch '${domain}'. Keep one change scoped to one domain spec to reduce merge collisions.`);
    }
  }
  return { valid: errors.length === 0, deltas, warnings, errors };
}

export async function applyOpenSpecDeltas(
  repoPath: string,
  changeId?: string,
  options: { removeAppliedDeltas?: boolean } = {},
): Promise<OpenSpecApplyResult> {
  await ensureOpenSpecRoot(repoPath);
  const validation = await validateOpenSpecChange(repoPath, changeId);
  if (!validation.valid) return { ...validation, applied: [] };

  const applied: OpenSpecApplyResult["applied"] = [];
  for (const delta of validation.deltas) {
    const file = specPath(repoPath, delta.domain);
    let spec = await safeRead(file);
    if (!spec.trim()) {
      spec = `# ${delta.domain}\n\n## Requirements\n`;
    }
    const actions: string[] = [];
    for (const block of splitRequirementBlocks(delta.removed)) {
      const result = removeBlock(spec, block);
      spec = result.text;
      actions.push(result.removed ? "removed" : "remove-not-found");
    }
    for (const block of splitRequirementBlocks(delta.modified)) {
      const result = replaceRequirementBlock(spec, block);
      spec = result.text;
      actions.push(result.replaced ? "modified" : "modified-appended");
    }
    for (const block of splitRequirementBlocks(delta.added)) {
      if (spec.includes(block.trim())) {
        actions.push("added-already-present");
      } else {
        spec = appendBlock(spec, block);
        actions.push("added");
      }
    }
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, spec.trimEnd() + "\n", "utf-8");
    applied.push({ domain: delta.domain, path: repoRelative(relative(repoPath, file)), actions });
  }
  if (options.removeAppliedDeltas) {
    for (const id of new Set(validation.deltas.map((delta) => delta.changeId))) {
      await rm(resolveInside(repoPath, `${OPENSPEC_CHANGES_DIR}/${id}`), { recursive: true, force: true });
    }
  }
  return { ...validation, applied };
}

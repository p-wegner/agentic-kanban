// Pure requirement-block text helpers for OpenSpec delta application (split out of openspec.ts).
const REQUIREMENT_HEADING_RE = /^###\s+.+$/gm;

export function splitRequirementBlocks(text: string): string[] {
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

export function replaceRequirementBlock(spec: string, block: string): { text: string; replaced: boolean } {
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

export function appendBlock(spec: string, block: string): string {
  const prefix = spec.trimEnd();
  return `${prefix}${prefix ? "\n\n" : ""}${block.trim()}\n`;
}

export function removeBlock(spec: string, block: string): { text: string; removed: boolean } {
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

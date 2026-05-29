import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { extractKeywords } from "@agentic-kanban/shared";
import type { ToolDeps } from "./deps.js";
import { prodDeps } from "./deps.js";

function overlapScore(patternKw: string[], querySet: Set<string>): { score: number; matched: string[] } {
  const matched = patternKw.filter(k => querySet.has(k));
  if (patternKw.length === 0 && querySet.size === 0) return { score: 0, matched: [] };
  const union = new Set([...patternKw, ...querySet]);
  return { score: union.size > 0 ? matched.length / union.size : 0, matched };
}

export function registerFindSimilarFailures(server: McpServer, deps: ToolDeps = prodDeps) {
  const { db: toolDb, schema: s } = deps;
  server.tool(
    "find_similar_failures",
    "Search the failure-pattern memory for past incidents similar to a given error text. Returns top matches with root-cause and fix information. Use this when an agent session fails or encounters errors to find known solutions.",
    {
      errorText: z.string().describe("Error text, stderr output, or description of the failure to match against stored patterns"),
      limit: z.number().optional().describe("Maximum number of matches to return (default: 3, max: 10)"),
    },
    async ({ errorText, limit = 3 }) => {
      try {
        const effectiveLimit = Math.min(limit, 10);
        const queryKw = extractKeywords(errorText);

        if (queryKw.length === 0) {
          return { content: [{ type: "text" as const, text: "No meaningful keywords found in the error text." }] };
        }

        const all = await toolDb.select().from(s.failurePatterns);
        if (all.length === 0) {
          return { content: [{ type: "text" as const, text: "No failure patterns stored yet. Patterns are ingested from docs/learnings/ on startup." }] };
        }

        const querySet = new Set(queryKw);
        const scored = all.map(p => {
          const patternKw = p.keywords ? p.keywords.split(" ").filter(Boolean) : [];
          const { score, matched } = overlapScore(patternKw, querySet);
          return { pattern: p, score, matchedKeywords: matched };
        })
          .filter(m => m.score > 0.05)
          .sort((a, b) => b.score - a.score)
          .slice(0, effectiveLimit);

        if (scored.length === 0) {
          return { content: [{ type: "text" as const, text: "No similar failures found. This may be a new class of error." }] };
        }

        const lines = [
          `Found ${scored.length} similar failure(s):`,
          "",
          ...scored.map((m, i) => {
            const p = m.pattern;
            const parts = [
              `## ${i + 1}. ${p.title} (${Math.round(m.score * 100)}% match)`,
              `**Matched keywords**: ${m.matchedKeywords.slice(0, 8).join(", ")}`,
            ];
            if (p.errorClass) parts.push(`**Error class**: ${p.errorClass}`);
            if (p.description) parts.push(`**Description**: ${p.description.slice(0, 300)}`);
            if (p.rootCause) parts.push(`**Root cause**: ${p.rootCause.slice(0, 400)}`);
            if (p.fix) parts.push(`**Fix**: ${p.fix.slice(0, 400)}`);
            if (p.sourceRef) parts.push(`**Source**: ${p.sourceRef}`);
            return parts.join("\n");
          }),
        ];

        return { content: [{ type: "text" as const, text: lines.join("\n\n") }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
      }
    },
  );
}

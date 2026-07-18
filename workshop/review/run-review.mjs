/**
 * Workshop CI Review Runner
 *
 * Always reviews the example PR defined by REVIEW_MR_IID (default: 1).
 * Fetches MR metadata + linked issue via GitLab API, builds the diff via git,
 * then calls Claude and writes findings.json as a CI artifact.
 *
 * Required CI variables (automatic):
 *   CI_API_V4_URL    – GitLab API base URL
 *   CI_PROJECT_ID    – current project ID
 *   CI_JOB_TOKEN     – short-lived job token (set automatically)
 *
 * Required CI variables (manual):
 *   GITLAB_READ_TOKEN   – project access token with read_api scope (masked)
 *   ANTHROPIC_BASE_URL  – API gateway base URL
 *   GATEWAY_API_KEY     – gateway API key (masked)
 *
 * Optional:
 *   REVIEW_MR_IID    – which MR to review (default: 1)
 */

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const GITLAB_API = process.env.CI_API_V4_URL ?? "https://code.andrena.de/api/v4";
const PROJECT_ID = process.env.CI_PROJECT_ID;
const GITLAB_READ_TOKEN = process.env.GITLAB_READ_TOKEN;
const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY;
const BASE_URL = process.env.ANTHROPIC_BASE_URL;
const REVIEW_MR_IID = process.env.REVIEW_MR_IID ?? "1";

if (!PROJECT_ID) {
  console.error("CI_PROJECT_ID is not set.");
  process.exit(1);
}
if (!GITLAB_READ_TOKEN) {
  console.error("GITLAB_READ_TOKEN is not set. Add a project access token (read_api) as a masked CI variable.");
  process.exit(1);
}
if (!GATEWAY_API_KEY) {
  console.error("GATEWAY_API_KEY is not set. Add it as a masked CI variable in GitLab.");
  process.exit(1);
}

async function fetchGitlab(path) {
  const res = await fetch(`${GITLAB_API}${path}`, {
    headers: { "PRIVATE-TOKEN": GITLAB_READ_TOKEN },
  });
  if (!res.ok) throw new Error(`GitLab API ${res.status}: GET ${path}`);
  return res.json();
}

// --- Fetch example MR metadata ---
console.log(`Reviewing MR !${REVIEW_MR_IID} …`);
const mr = await fetchGitlab(`/projects/${PROJECT_ID}/merge_requests/${REVIEW_MR_IID}`);
console.log(`MR: "${mr.title}" (${mr.source_branch} → ${mr.target_branch})`);

// --- Fetch MR diff ---
const mrChanges = await fetchGitlab(`/projects/${PROJECT_ID}/merge_requests/${REVIEW_MR_IID}/changes`);
const diffText = mrChanges.changes
  .map((d) => `--- ${d.old_path}\n+++ ${d.new_path}\n${d.diff}`)
  .join("\n\n");
console.log(`Diff: ${mrChanges.changes.length} file(s), ${diffText.length} chars`);

// --- Fetch linked issue via GitLab API ---
let issueSection = "";
const issueMatch = mr.description?.match(/(?:closes|fixes|resolves)\s+#(\d+)/i);
if (issueMatch) {
  const issue = await fetchGitlab(`/projects/${PROJECT_ID}/issues/${issueMatch[1]}`);
  issueSection = `## Linked Issue #${issue.iid}: ${issue.title}\n\n${issue.description ?? ""}\n\n`;
  console.log(`Issue: #${issue.iid} "${issue.title}"`);
}

// --- Load participant's skill prompt ---
const skillPrompt = readFileSync(join(__dirname, "skill.md"), "utf-8").trim();
if (!skillPrompt) {
  console.error("skill.md is empty.");
  process.exit(1);
}

// --- Build prompt ---
const userMessage = `${issueSection}## MR: ${mr.title}

${mr.description ?? ""}

## Diff

\`\`\`diff
${diffText}
\`\`\`

Respond with a JSON object in this exact format (no prose outside the JSON):

\`\`\`json
{
  "findings": [
    {
      "id": "F1",
      "severity": "high",
      "description": "...",
      "location": "filename.ts:line",
      "violated_ac": "AC2"
    }
  ]
}
\`\`\`
`;

// --- Call Claude via API Gateway ---
const client = new Anthropic({
  apiKey: "sk-ant-placeholder",
  baseURL: BASE_URL,
  defaultHeaders: { "x-api-key": GATEWAY_API_KEY },
});

console.log("Calling Claude …");
const response = await client.messages.create({
  model: "claude-opus-4-8",
  max_tokens: 4096,
  thinking: { type: "adaptive" },
  system: skillPrompt,
  messages: [{ role: "user", content: userMessage }],
});

// --- Parse findings ---
const raw = response.content.find((b) => b.type === "text")?.text ?? "";
let findings;
try {
  const jsonMatch = raw.match(/```json\s*([\s\S]*?)\s*```/);
  findings = JSON.parse(jsonMatch ? jsonMatch[1] : raw);
} catch {
  findings = { parse_error: true, raw, findings: [] };
}

findings.meta = {
  reviewed_mr: `!${REVIEW_MR_IID}`,
  mr_title: mr.title,
  model: response.model,
  input_tokens: response.usage.input_tokens,
  output_tokens: response.usage.output_tokens,
};

const outPath = join(__dirname, "findings.json");
writeFileSync(outPath, JSON.stringify(findings, null, 2));

console.log(`\n=== ${findings.findings?.length ?? 0} finding(s) ===`);
for (const f of findings.findings ?? []) {
  console.log(`[${f.severity?.toUpperCase()}] ${f.id} — ${f.description}`);
}
console.log(`\nArtifact: ${outPath}`);

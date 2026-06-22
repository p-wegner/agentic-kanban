/**
 * Workshop CI Review Runner
 *
 * Fetches the MR diff + linked GitLab issue, passes both to the participant's
 * skill prompt, and writes findings.json as a CI artifact.
 *
 * Required CI variables:
 *   CI_API_V4_URL        – set automatically by GitLab
 *   CI_PROJECT_ID        – set automatically by GitLab
 *   CI_MERGE_REQUEST_IID – set automatically by GitLab (MR pipelines only)
 *   CI_JOB_TOKEN         – set automatically by GitLab
 *   ANTHROPIC_BASE_URL   – the API gateway base URL
 *   GATEWAY_API_KEY      – the gateway API key (masked CI variable)
 */

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const GITLAB_API = process.env.CI_API_V4_URL ?? "https://code.andrena.de/api/v4";
const PROJECT_ID = process.env.CI_PROJECT_ID;
const MR_IID = process.env.CI_MERGE_REQUEST_IID;
const JOB_TOKEN = process.env.CI_JOB_TOKEN;
const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY;
const BASE_URL = process.env.ANTHROPIC_BASE_URL;

if (!PROJECT_ID || !MR_IID) {
  console.error("Must run inside a GitLab MR pipeline (CI_PROJECT_ID and CI_MERGE_REQUEST_IID required)");
  process.exit(1);
}
if (!GATEWAY_API_KEY) {
  console.error("GATEWAY_API_KEY is not set. Add it as a masked CI variable in GitLab.");
  process.exit(1);
}

async function fetchGitlab(path) {
  const res = await fetch(`${GITLAB_API}${path}`, {
    headers: { "JOB-TOKEN": JOB_TOKEN },
  });
  if (!res.ok) throw new Error(`GitLab API ${res.status}: GET ${path}`);
  return res.json();
}

// --- Fetch MR metadata + diff ---
const mr = await fetchGitlab(`/projects/${PROJECT_ID}/merge_requests/${MR_IID}`);
const diffs = await fetchGitlab(`/projects/${PROJECT_ID}/merge_requests/${MR_IID}/diffs`);

const diffText = diffs
  .map((d) => `--- ${d.old_path}\n+++ ${d.new_path}\n${d.diff}`)
  .join("\n\n");

// --- Fetch linked issue (parses "Closes #N" / "Fixes #N" from MR description) ---
let issueSection = "";
const issueMatch = mr.description?.match(/(?:closes|fixes|resolves)\s+#(\d+)/i);
if (issueMatch) {
  try {
    const issue = await fetchGitlab(`/projects/${PROJECT_ID}/issues/${issueMatch[1]}`);
    issueSection = `## Linked Issue #${issue.iid}: ${issue.title}\n\n${issue.description ?? ""}\n\n`;
    console.log(`Fetched linked issue #${issue.iid}`);
  } catch (e) {
    console.warn(`Could not fetch issue: ${e.message}`);
  }
}

// --- Load participant's skill prompt ---
const skillPath = join(__dirname, "skill.md");
const skillPrompt = readFileSync(skillPath, "utf-8").trim();

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
  defaultHeaders: {
    "x-api-key": GATEWAY_API_KEY,
  },
});

console.log(`Calling Claude (model: claude-opus-4-8) …`);
const response = await client.messages.create({
  model: "claude-opus-4-8",
  max_tokens: 4096,
  thinking: { type: "adaptive" },
  system: skillPrompt,
  messages: [{ role: "user", content: userMessage }],
});

// --- Parse findings ---
const textBlock = response.content.find((b) => b.type === "text");
const raw = textBlock?.text ?? "";

let findings;
try {
  const jsonMatch = raw.match(/```json\s*([\s\S]*?)\s*```/);
  findings = JSON.parse(jsonMatch ? jsonMatch[1] : raw);
} catch {
  findings = { parse_error: true, raw, findings: [] };
}

// Attach metadata
findings.meta = {
  mr_iid: MR_IID,
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
console.log(`\nArtifact written to ${outPath}`);

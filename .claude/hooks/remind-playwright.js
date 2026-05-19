#!/usr/bin/env node
/**
 * Stop hook: remind-playwright.js
 *
 * Blocks agent termination when client source files were edited,
 * reminding the agent to visually verify changes via playwright-cli.
 *
 * Receives edited file list via SMART_HOOKS_EDITED_FILES env var (set by
 * smart-hooks-runner.js). Falls back to reading .smart-hooks-state.json for
 * standalone invocation.
 *
 * Outputs a JSON block decision on stdout if client files need verification.
 * Exit code 2 = block, 0 = pass.
 */

const fs = require("fs");
const path = require("path");

function getProjectDir() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

function getStatePath() {
  return path.join(getProjectDir(), ".claude", "hooks", ".smart-hooks-state.json");
}

function hasClientEdits(files) {
  return files.some(
    (f) =>
      f.startsWith("packages/client/") &&
      /\.(tsx?|jsx?|css)$/.test(f)
  );
}

function main() {
  let editedFiles = [];
  if (process.env.SMART_HOOKS_EDITED_FILES) {
    try { editedFiles = JSON.parse(process.env.SMART_HOOKS_EDITED_FILES); } catch {}
  } else {
    try {
      const state = JSON.parse(fs.readFileSync(getStatePath(), "utf8"));
      editedFiles = state.editedFiles || [];
    } catch {}
  }
  const state = { editedFiles };

  if (!hasClientEdits(state.editedFiles)) process.exit(0);

  // Output block decision — the smart-hooks-runner will relay it
  process.stdout.write(
    JSON.stringify({
      decision: "block",
      reason: [
        "VISUAL VERIFICATION REQUIRED",
        "",
        "Client source files were modified. Before stopping, verify your changes",
        "in the browser using the playwright-cli skill:",
        "",
        "  /playwright-cli",
        "",
        "Then:",
        "  1. Open http://localhost:" + (process.env.VITE_PORT || "5173"),
        "  2. Take a snapshot to check the UI renders correctly",
        "  3. Screenshot only if debugging — clean up .png files after",
        "",
        "If the dev server is not running, start it with: pnpm dev",
        "Assume the server is running and only start it if navigation fails.",
        "",
        "After verification, you may stop.",
      ].join("\n"),
    }) + "\n"
  );
  process.exit(2);
}

main();

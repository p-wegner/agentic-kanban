// `worker pair` (#1370): mint a pairing token and print it with the node-only bootstrap for the worker's OS.
// Split from `worker.ts` to keep it under the god-module ceiling.
import { renderBootstrapSteps } from "./worker-setup-guide.js";

/** Mint a token on the board at `board` and print it with the bootstrap commands. Exits 1 when the mint fails. */
export async function runWorkerPair(options: { board: string; os: string }): Promise<void> {
  const res = await fetch(`${options.board.replace(/\/+$/, "")}/api/workers/pairing-token`, { method: "POST" });
  if (!res.ok) {
    console.error(`Failed to mint pairing token (${res.status}). Is the board running at ${options.board}?`);
    process.exit(1);
  }
  const body = await res.json() as { pairingToken: string; expiresAt: string; fleetUrl?: string | null; fleetNote?: string | null };
  console.log(`Pairing token (single-use, expires ${body.expiresAt}):`);
  console.log(`  ${body.pairingToken}`);
  const os = /^(unix|linux|macos)$/.test(options.os) ? "unix" : "windows";
  console.log(`\nOn the worker machine (already installed):\n  agentic-kanban-worker setup --board ${body.fleetUrl || "<board-url>"} --token ${body.pairingToken}`);
  console.log(`\n${renderBootstrapSteps(body.fleetUrl || "<board-url>", body.pairingToken, os)}\n(${os === "windows" ? "Linux/macOS worker? re-run with --os unix." : "Windows worker? re-run without --os."})`);
  if (body.fleetNote) console.log(`\nNote: ${body.fleetNote}`);
}

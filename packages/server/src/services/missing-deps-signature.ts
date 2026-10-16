// What a failed verify run looks like when its tooling never resolved (#169, #1092, #1493).
// cmd.exe's "command not found" is LOCALIZED (#1092). A German box prints
// `Der Befehl "depcruise" ist entweder falsch geschrieben oder\nkonnte nicht gefunden werden.` —
// split across two lines — and matching only the English wording meant #169's install retry
// never fired there: the gate went straight to `verify_infra_missing` and a 2h backoff.
// Anchor to real module-resolution errors (esbuild-style `Could not resolve "pkg"` with a quoted specifier is fine), never free-text "could not resolve" (#1512): a test
// printing `[services] reaper skipped — could not resolve this instance's id: db unavailable`
// triggered an install plus a full re-run of the train gate.
const MISSING_DEPS_SIGNATURE =
  /cannot find module|cannot find package|failed to resolve import|could not resolve ["'`][^"'`\s]+["'`]|err_module_not_found|module_not_found|unresolved_import|enoent.*node_modules|command not found|is not recognized as an internal or external command|ist entweder falsch geschrieben oder\s+konnte nicht gefunden werden/i;

/**
 * Drop text a TEST printed (#1543): vitest echoes captured console output as `stdout | <file> > <test>` /
 * `stderr | …` blocks (ending at the next blank line), and a board log line (`[pre-merge-gate] …`) is
 * our own logging, which may quote an earlier match. A test that mocks `Error: Could not resolve
 * 'vitest/config'` is not a run whose tooling failed to resolve.
 */
function stripTestLogOutput(output: string): string {
  const kept: string[] = [];
  let inCapturedBlock = false;
  for (const line of output.split("\n")) {
    if (/^\s*(stdout|stderr) \| /.test(line)) {
      inCapturedBlock = true;
      continue;
    }
    if (inCapturedBlock) {
      if (line.trim() === "") inCapturedBlock = false;
      continue;
    }
    if (/^\s*\[[a-z][\w-]*\]\s/i.test(line)) continue;
    kept.push(line);
  }
  return kept.join("\n");
}

export function looksLikeMissingDepsFailure(output: string): boolean {
  return MISSING_DEPS_SIGNATURE.test(stripTestLogOutput(output));
}

/**
 * The line of `output` that tripped the signature (#1493), trimmed and capped, so the gate log and
 * failure evidence NAME the module/command the run could not find. Null when nothing matches.
 */
export function missingDepsEvidence(raw: string): string | null {
  const output = stripTestLogOutput(raw);
  const m = MISSING_DEPS_SIGNATURE.exec(output);
  if (!m) return null;
  const start = output.lastIndexOf("\n", m.index) + 1;
  const end = output.indexOf("\n", m.index);
  return output.slice(start, end === -1 ? undefined : end).trim().slice(0, 300);
}

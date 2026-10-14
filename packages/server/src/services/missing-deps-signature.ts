// What a failed verify run looks like when its tooling never resolved (#169, #1092, #1493).
// cmd.exe's "command not found" is LOCALIZED (#1092). A German box prints
// `Der Befehl "depcruise" ist entweder falsch geschrieben oder\nkonnte nicht gefunden werden.` —
// split across two lines — and matching only the English wording meant #169's install retry
// never fired there: the gate went straight to `verify_infra_missing` and a 2h backoff.
const MISSING_DEPS_SIGNATURE =
  /cannot find module|could not resolve|err_module_not_found|module_not_found|unresolved_import|enoent.*node_modules|command not found|is not recognized as an internal or external command|ist entweder falsch geschrieben oder\s+konnte nicht gefunden werden/i;

export function looksLikeMissingDepsFailure(output: string): boolean {
  return MISSING_DEPS_SIGNATURE.test(output);
}

/**
 * The line of `output` that tripped the signature (#1493), trimmed and capped, so the gate log and
 * failure evidence NAME the module/command the run could not find. Null when nothing matches.
 */
export function missingDepsEvidence(output: string): string | null {
  const m = MISSING_DEPS_SIGNATURE.exec(output);
  if (!m) return null;
  const start = output.lastIndexOf("\n", m.index) + 1;
  const end = output.indexOf("\n", m.index);
  return output.slice(start, end === -1 ? undefined : end).trim().slice(0, 300);
}

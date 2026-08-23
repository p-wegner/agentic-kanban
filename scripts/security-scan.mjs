#!/usr/bin/env node
// Dependency security + licence scan for this repo (#741).
//
// Why this file exists: the board is published to npm with a real dependency
// tree and, until this script, NO advisory scan had ever run against it. The
// external metrics tooling reported `skipped:no_lockfile` because it only looks
// for `package-lock.json` / `Gemfile.lock` / a Python lock — this repo's lock is
// `pnpm-lock.yaml`. pnpm has a native audit, so nothing needed converting; it
// just needed to be wired up and given a policy.
//
// The same run answers the licence half: `pnpm licenses list` reads the actual
// installed packages, so "unknown licence" here means the package really ships
// no SPDX id — not "the reader could not resolve it offline".
//
// Usage:
//   pnpm security            human report, exits non-zero on a policy breach
//   pnpm security -- --json  machine-readable report on stdout
//
// THE POLICY OF RECORD IS THE `POLICY` OBJECT BELOW — one place, no env-var
// shadow config, no second copy in the CI workflow. The workflow runs this
// script and nothing else, so CI and a developer's laptop cannot disagree.

import { spawnSyncPnpm } from "./pnpm-exec.mjs";

// ---------------------------------------------------------------------------
// POLICY — the single source of truth. Rationale in docs/security-policy.md.
// ---------------------------------------------------------------------------
const POLICY = {
  // A gate that fails on every transitive `low` in a dev-only bundler is noise
  // and gets disabled within a week; a gate that cannot fail is decoration.
  // The line we draw: high/critical severity, in the PRODUCTION dependency
  // graph — i.e. the code that actually gets installed into someone else's repo
  // by `npm i agentic-kanban`. Dev-only advisories (vite/esbuild/vitest and
  // friends) are always REPORTED but never fail the build: they run on a
  // developer's machine against a checkout that machine already trusts.
  failOnSeverities: ["critical", "high"],

  // Advisories accepted in the production graph. Keyed by GHSA id (stable across
  // pnpm's own numeric re-issues). This makes the gate a RATCHET: "no NEW
  // high/critical in prod". Shrink-only — an entry whose advisory is no longer
  // reported FAILS the scan, so a fixed advisory cannot leave a stale exemption
  // behind for the next one to hide in.
  //
  // Do not add to this list to make a red build green. Fix the dependency, or
  // file a ticket and add the entry in the SAME commit that explains why not.
  //
  // EMPTY as of #760 (2026-08-23). The four entries this list was born with
  // (GHSA-mh99-v99m-4gvg + GHSA-rgw5-rvv9-x895 brace-expansion,
  // GHSA-7p8r-x3mc-p8w7 fast-uri, GHSA-mwp4-54f8-5fhr ip-address) were all
  // cleared by raising the override floors in pnpm-workspace.yaml, so keeping
  // them would now be exactly the stale exemption the ratchet exists to catch.
  // The one `low` that survived that round (body-parser GHSA-v422-hmwv-36x6)
  // was cleared the same way in #786. Measured 2026-08-23: production 289
  // packages, ZERO advisories of any severity. Nothing in the production graph
  // is currently unfixable, which is why nothing is accepted.
  acceptedProdAdvisories: {},

  // Licences. The board ships to npm, so the production graph is what matters
  // for redistribution; dev-only copyleft never leaves the developer's machine.
  // Strong copyleft in prod is a hard fail — it would change the licensing of
  // anything that installs us. Weak copyleft is reported for a human call.
  licences: {
    denyInProd: [/^AGPL/i, /^GPL-/i, /^SSPL/i, /^BUSL/i, /^CC-BY-NC/i, /^EUPL/i, /^OSL/i, /^CPAL/i],
    reportInProd: [/^MPL-/i, /^LGPL/i, /^EPL-/i, /^CDDL/i],
    // Packages in the production graph shipping no readable SPDX id. Shrink-only
    // ceiling, for the same reason as the advisory list: today's two are both the
    // Anthropic Claude Agent SDK (proprietary terms, deliberately depended on),
    // and a third arriving unnoticed is exactly what this number catches.
    prodUnknownCeiling: 2,
  },
};

const SEVERITY_ORDER = ["critical", "high", "moderate", "low", "info"];

function runPnpmJson(args) {
  const res = spawnSyncPnpm(args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  // `pnpm audit` exits non-zero WHEN IT FINDS THINGS, so the exit code alone
  // cannot distinguish "vulnerable" from "never ran". Parse-ability is the real
  // signal: no parseable JSON means the scan did not run, and a scan that did
  // not run must never be published as zero findings.
  let parsed = null;
  try {
    parsed = JSON.parse(res.stdout ?? "");
  } catch {
    parsed = null;
  }
  if (!parsed) {
    const detail = (res.stderr || res.stdout || res.error?.message || "")
      .trim()
      .split("\n")
      .slice(-6)
      .join("\n");
    console.error(
      `\n[security-scan] SCAN DID NOT RUN: 'pnpm ${args.join(" ")}' produced no parseable JSON (exit ${res.status}).\n${detail}`,
    );
    console.error("[security-scan] Refusing to report zero findings for a scan that did not run.");
    process.exit(2);
  }
  return parsed;
}

function severityCounts(audit) {
  const out = Object.fromEntries(SEVERITY_ORDER.map((s) => [s, 0]));
  for (const [sev, n] of Object.entries(audit?.metadata?.vulnerabilities ?? {})) {
    if (sev in out) out[sev] = n;
  }
  return out;
}

function advisories(audit) {
  return Object.values(audit?.advisories ?? {}).map((a) => ({
    ghsa: a.github_advisory_id ?? String(a.id),
    id: a.id,
    severity: a.severity,
    module: a.module_name,
    vulnerable: a.vulnerable_versions,
    patched: a.patched_versions,
    title: a.title,
    url: a.url,
    paths: (a.findings ?? []).flatMap((f) => f.paths ?? []),
  }));
}

function licenceSummary(raw) {
  const byLicence = new Map();
  let total = 0;
  for (const [licence, pkgs] of Object.entries(raw ?? {})) {
    byLicence.set(
      licence,
      (pkgs ?? []).map((p) => `${p.name}@${(p.versions ?? []).join("/")}`),
    );
    total += (pkgs ?? []).length;
  }
  return { total, byLicence };
}

function matchAny(patterns, value) {
  return patterns.some((re) => re.test(value));
}

function main() {
  const jsonOut = process.argv.includes("--json");

  const auditAll = runPnpmJson(["audit", "--json"]);
  const auditProd = runPnpmJson(["audit", "--prod", "--json"]);
  const licAll = runPnpmJson(["licenses", "list", "--json"]);
  const licProd = runPnpmJson(["licenses", "list", "--prod", "--json"]);

  const countsAll = severityCounts(auditAll);
  const countsProd = severityCounts(auditProd);
  const advProd = advisories(auditProd);
  const advAll = advisories(auditAll);

  const gating = advProd.filter((a) => POLICY.failOnSeverities.includes(a.severity));
  const isAccepted = (a) => a.ghsa in POLICY.acceptedProdAdvisories;
  const accepted = gating.filter(isAccepted);
  const breaches = gating.filter((a) => !isAccepted(a));
  const staleAcceptances = Object.keys(POLICY.acceptedProdAdvisories).filter(
    (ghsa) => !gating.some((a) => a.ghsa === ghsa),
  );

  const sumAll = licenceSummary(licAll);
  const sumProd = licenceSummary(licProd);
  const prodUnknown = sumProd.byLicence.get("Unknown") ?? [];
  const allUnknown = sumAll.byLicence.get("Unknown") ?? [];
  const prodDenied = [...sumProd.byLicence.entries()].filter(([l]) => matchAny(POLICY.licences.denyInProd, l));
  const prodWeak = [...sumProd.byLicence.entries()].filter(([l]) => matchAny(POLICY.licences.reportInProd, l));

  const failures = [];
  for (const a of breaches) {
    failures.push(
      `${a.severity.toUpperCase()} advisory in the production graph: ${a.module} ${a.vulnerable} — ${a.ghsa} (${a.title})`,
    );
  }
  for (const ghsa of staleAcceptances) {
    failures.push(
      `stale acceptance: ${ghsa} is no longer reported in the production graph — remove it from POLICY.acceptedProdAdvisories in scripts/security-scan.mjs`,
    );
  }
  for (const [licence, pkgs] of prodDenied) {
    failures.push(`denied licence in the production graph: ${licence} — ${pkgs.join(", ")}`);
  }
  if (prodUnknown.length > POLICY.licences.prodUnknownCeiling) {
    failures.push(
      `${prodUnknown.length} production packages have no readable licence, ceiling is ${POLICY.licences.prodUnknownCeiling}: ${prodUnknown.join(", ")}`,
    );
  }

  const report = {
    policy: {
      failOnSeverities: POLICY.failOnSeverities,
      scope: "production dependency graph",
      acceptedProdAdvisories: POLICY.acceptedProdAdvisories,
      prodUnknownLicenceCeiling: POLICY.licences.prodUnknownCeiling,
    },
    vulnerabilities: {
      wholeTree: {
        packages: auditAll?.metadata?.totalDependencies ?? null,
        counts: countsAll,
        advisories: advAll.length,
      },
      production: {
        packages: auditProd?.metadata?.totalDependencies ?? null,
        counts: countsProd,
        advisories: advProd.length,
      },
      gatingInProduction: gating.map((a) => ({ ...a, accepted: isAccepted(a) })),
    },
    licences: {
      wholeTree: { packages: sumAll.total, unknown: allUnknown.length },
      production: { packages: sumProd.total, unknown: prodUnknown.length, unknownPackages: prodUnknown },
      deniedInProduction: prodDenied.map(([l, p]) => ({ licence: l, packages: p })),
      weakCopyleftInProduction: prodWeak.map(([l, p]) => ({ licence: l, packages: p })),
      histogramWholeTree: Object.fromEntries([...sumAll.byLicence].map(([l, p]) => [l, p.length])),
    },
    failures,
    ok: failures.length === 0,
  };

  if (jsonOut) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const line = (s = "") => console.log(s);
    line("");
    line("Dependency security scan (pnpm audit + pnpm licenses, against this repo's pnpm-lock.yaml)");
    line("-".repeat(80));
    line(`policy: fail on ${POLICY.failOnSeverities.join("/")} in the PRODUCTION graph; everything else reports`);
    line("");
    line(
      `advisories, whole tree (${report.vulnerabilities.wholeTree.packages} pkgs): ` +
        SEVERITY_ORDER.map((s) => `${s} ${countsAll[s]}`).join("  ") +
        `  → ${advAll.length} advisories`,
    );
    line(
      `advisories, production (${report.vulnerabilities.production.packages} pkgs): ` +
        SEVERITY_ORDER.map((s) => `${s} ${countsProd[s]}`).join("  ") +
        `  → ${advProd.length} advisories`,
    );
    line("");
    line(`gating severities in production: ${gating.length} (${accepted.length} accepted, ${breaches.length} unaccepted)`);
    for (const a of gating) {
      line(
        `  ${isAccepted(a) ? "accepted" : "BREACH  "} ${a.severity.padEnd(8)} ${a.module} ${a.vulnerable} → ${a.patched}  ${a.ghsa}`,
      );
      line(`           ${a.paths[0] ?? "(no path reported)"}`);
    }
    line("");
    line(`licences, whole tree: ${sumAll.total} pkgs, ${allUnknown.length} with no readable licence`);
    line(
      `licences, production: ${sumProd.total} pkgs, ${prodUnknown.length} with no readable licence (ceiling ${POLICY.licences.prodUnknownCeiling})`,
    );
    for (const p of prodUnknown) line(`  unknown: ${p}`);
    for (const [l, pkgs] of prodWeak) line(`  weak copyleft: ${l} — ${pkgs.join(", ")}`);
    for (const [l, pkgs] of prodDenied) line(`  DENIED: ${l} — ${pkgs.join(", ")}`);
    line("");
    if (failures.length === 0) {
      line("PASS — no unaccepted high/critical advisory in the production graph, no denied or unexplained licence.");
    } else {
      line(`FAIL — ${failures.length} policy breach(es):`);
      for (const f of failures) line(`  - ${f}`);
      line("");
      line("Policy and the acceptance list live in scripts/security-scan.mjs (POLICY); rationale in docs/security-policy.md.");
    }
  }

  process.exit(failures.length === 0 ? 0 : 1);
}

main();

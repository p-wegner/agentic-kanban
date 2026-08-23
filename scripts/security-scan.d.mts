// Types for security-scan.mjs, so the policy can be imported by a test without
// `tsc` falling back to `any` (TS7016).
//
// Hand-written rather than generated: the script is deliberately a plain .mjs
// with no build step, because CI runs it directly and a compile step between
// the policy and the gate is one more thing that can disagree with itself.
// Only the exported surface is described here — `main()` is not exported and
// must not become importable, since it shells out to pnpm and calls
// `process.exit`.

/**
 * The policy of record for the dependency + licence scan. Rationale lives in
 * docs/security-policy.md.
 */
export declare const POLICY: {
  failOnSeverities: string[];
  acceptedProdAdvisories: Record<string, string>;
  licences: {
    denyInProd: RegExp[];
    reportInProd: RegExp[];
    /**
     * Production packages shipping no readable SPDX id, accepted by NAME with a
     * reason. Replaced a numeric ceiling, which could not tell a new supplier
     * from a new platform build of an existing one.
     */
    acceptedProdUnknownLicences: RegExp[];
    /**
     * The numeric ceiling this policy used to have. Declared as optional and
     * `never` so that reading it stays legal — the guard test asserts it is
     * gone — while any attempt to reintroduce a number here is a type error.
     */
    prodUnknownCeiling?: never;
  };
};

export declare function matchAny(patterns: RegExp[], value: string): boolean;

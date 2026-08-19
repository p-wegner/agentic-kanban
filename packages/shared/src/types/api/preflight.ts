/**
 * Ticket-preflight wire types (#569).
 *
 * The server declared a precise `PreflightVerdict` template-literal union; the client's
 * copy in `PreflightModal.tsx` was `type PreflightVerdict = string`, so its
 * `verdictLabel()` re-derived `duplicate-of-#N` with a `startsWith` test the union
 * already encodes. The client also carried `looksComplex` as optional (the server
 * always sends it) and owned `clarificationsBlock`, which the ROUTE adds — recorded
 * here as the response type so the two halves are visible in one place.
 */

export type PreflightVerdict =
  | "ready"
  | "needs-clarification"
  | `duplicate-of-#${number}`
  | `blocked-by-#${number}`;

export interface TicketPreflightResult {
  verdict: PreflightVerdict;
  /** Concrete questions to answer before the agent starts (when verdict = needs-clarification). */
  questions: string[];
  /** Human-readable summary of why the verdict was reached. */
  summary: string;
  /** Issue number this ticket duplicates (when verdict starts with duplicate-of-#). */
  duplicateOfNumber?: number;
  /** Issue number that blocks this ticket (when verdict starts with blocked-by-#). */
  blockedByNumber?: number;
  /** True when the ticket looks like a non-trivial / multi-file feature (not a tiny quick edit).
   *  Used to warn against running it in a direct workspace (which edits the main checkout). */
  looksComplex: boolean;
}

/** A question + the answer the user provided during preflight clarification. */
export interface PreflightClarification {
  question: string;
  answer: string;
}

/**
 * What `POST /api/issues/:id/preflight` actually returns: the service result plus the
 * markdown block the route builds when the re-check ran with clarifications. The caller
 * prepends it to the launching agent's context.
 */
export interface PreflightResponse extends TicketPreflightResult {
  clarificationsBlock?: string;
}

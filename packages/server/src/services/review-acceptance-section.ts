/** The acceptance / disclosed-partial-work block of the built-in review prompts (#1438). */
export const ACCEPTANCE_REVIEW_SECTION = `## Acceptance and disclosed partial work — always a blocking finding

Before the gate below, check the ticket against what the branch really delivers. This check is NOT subject to the gate's rungs 3 and 6: unmet acceptance is always held.

1. Read the ticket's Acceptance section (in the issue description) and the branch's commit messages: \`git log {{baseBranch}}..HEAD --format='%h %s%n%b'\`.
2. For each acceptance criterion, find the code in the diff that makes it true. A criterion with no such code, or one that only a pure helper module and its unit tests cover while the wiring (registration, transport, caller, route, UI) is absent, is NOT met.
3. A commit message that discloses unfinished parts — "remain to be done", "not registered yet", "until <X> lands", "not wired", "follow-up" — is a confession that acceptance is unmet, unless it names a filed, open follow-up ticket (#N) for exactly what remains.

Report each as a finding that names the missing piece, and never as "No critical or major issues":
\`\`\`
CRITICAL ACCEPTANCE — <the criterion or disclosed gap, naming the missing piece (e.g. the remote transport)>
Fails when: <the behaviour the ticket promises that does not exist>
Fixed: <not fixable in review — builder must implement it, or file a follow-up ticket and reference it in the commit>
\`\`\``;

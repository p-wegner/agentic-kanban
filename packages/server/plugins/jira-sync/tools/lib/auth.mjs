// Credential resolution. The board injects the settings form's values into the env:
// sync.secrets under their own names (JIRA_API_TOKEN, JIRA_EMAIL) and sync.config as
// SYNC_CONFIG_<KEY>. A hand-set JIRA_* variable still wins, so a headless setup keeps working.
// Never persist a credential to disk; never log one.

export class JiraAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = "JiraAuthError";
  }
}

/**
 * Reads site URL + credentials from the environment. Basic auth (email + API
 * token) is used for Jira Cloud when JIRA_EMAIL is set; otherwise the token is
 * sent as a bearer token, which is how Jira Server/Data Center Personal Access
 * Tokens authenticate.
 */
export function resolveCredentialsFromEnv(env = process.env) {
  const siteUrl = env.JIRA_SITE_URL || env.SYNC_CONFIG_SITEURL;
  const apiToken = env.JIRA_API_TOKEN;
  const email = env.JIRA_EMAIL || null;

  if (!siteUrl) throw new JiraAuthError("JIRA_SITE_URL is not set");
  if (!apiToken) throw new JiraAuthError("JIRA_API_TOKEN is not set");

  return { siteUrl: siteUrl.replace(/\/+$/, ""), email, apiToken };
}

/** Builds the Authorization header value for a request. */
export function buildAuthHeader({ email, apiToken }) {
  if (!apiToken) throw new JiraAuthError("apiToken is required to build an auth header");
  if (email) {
    const encoded = Buffer.from(`${email}:${apiToken}`, "utf8").toString("base64");
    return `Basic ${encoded}`;
  }
  return `Bearer ${apiToken}`;
}

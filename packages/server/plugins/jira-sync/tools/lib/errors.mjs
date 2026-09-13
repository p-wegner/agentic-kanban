// Normalizes any Jira REST API failure (HTTP error, malformed body, network
// failure) into one predictable shape, so callers never branch on Jira's own
// inconsistent error payloads (errorMessages[] vs errors{} vs a bare string).

export class JiraApiError extends Error {
  constructor({ message, status = null, code, retryable = false, body = null, cause = null }) {
    super(message);
    this.name = "JiraApiError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.body = body;
    if (cause) this.cause = cause;
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      status: this.status,
      code: this.code,
      retryable: this.retryable,
    };
  }
}

const STATUS_CODES = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  429: "rate_limited",
};

function codeForStatus(status) {
  if (STATUS_CODES[status]) return STATUS_CODES[status];
  if (status >= 500) return "server_error";
  return "unknown";
}

/** Turn a Jira HTTP response (status + parsed body, if any) into a JiraApiError. */
export function normalizeHttpError({ status, statusText, body }) {
  const messages = [];
  if (body && typeof body === "object") {
    if (Array.isArray(body.errorMessages)) messages.push(...body.errorMessages.filter(Boolean));
    if (body.errors && typeof body.errors === "object" && !Array.isArray(body.errors)) {
      for (const [field, msg] of Object.entries(body.errors)) messages.push(`${field}: ${msg}`);
    }
  } else if (typeof body === "string" && body.trim()) {
    messages.push(body.trim());
  }

  const message = messages.length > 0 ? messages.join("; ") : statusText || `HTTP ${status}`;
  const code = codeForStatus(status);
  const retryable = status === 429 || status >= 500;
  return new JiraApiError({ message, status, code, retryable, body });
}

/** A transport-level failure (DNS, connection refused, timeout) — never an HTTP status. */
export function normalizeNetworkError(cause) {
  return new JiraApiError({
    message: cause?.message ? `network error: ${cause.message}` : "network error",
    status: null,
    code: "network_error",
    retryable: true,
    cause,
  });
}

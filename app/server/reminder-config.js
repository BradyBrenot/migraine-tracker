// Environment-only ntfy reminder configuration.
//
// NTFY_URL / NTFY_TOKEN / PUBLIC_APP_URL are NEVER persisted, exported,
// backed up, sent to the browser, or logged. This module only validates them
// and returns a plain object for the startup wiring; callers must not
// serialize it. Reason strings are fixed and contain no env values.

const SECRET_QUERY_NAME = /^(auth|token|access[_-]?token|api[_-]?key|apikey|key|password|passwd)$/i;

function validPublicAppUrl(raw) {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Resolve reminder delivery configuration.
 * Returns { enabled, reason, ntfyUrl, ntfyToken, publicAppUrl }.
 * - Missing/invalid NTFY_URL => enabled:false with a fixed reason.
 * - Credentials in the URL (userinfo or query params) are rejected.
 * - A malformed PUBLIC_APP_URL only disables click links, never delivery.
 */
export function resolveReminderConfig(env = {}) {
  const rawUrl = typeof env.NTFY_URL === 'string' ? env.NTFY_URL.trim() : '';
  const rawToken = typeof env.NTFY_TOKEN === 'string' ? env.NTFY_TOKEN.trim() : '';
  const publicAppUrl = typeof env.PUBLIC_APP_URL === 'string'
    ? validPublicAppUrl(env.PUBLIC_APP_URL.trim())
    : null;

  if (!rawUrl) {
    return {
      enabled: false, reason: 'NTFY_URL is not set',
      ntfyUrl: null, ntfyToken: null, publicAppUrl,
    };
  }

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return {
      enabled: false, reason: 'NTFY_URL is not a valid URL',
      ntfyUrl: null, ntfyToken: null, publicAppUrl,
    };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      enabled: false, reason: 'NTFY_URL must use http or https',
      ntfyUrl: null, ntfyToken: null, publicAppUrl,
    };
  }
  if (url.username || url.password) {
    return {
      enabled: false, reason: 'NTFY_URL must not contain credentials',
      ntfyUrl: null, ntfyToken: null, publicAppUrl,
    };
  }
  for (const name of url.searchParams.keys()) {
    if (SECRET_QUERY_NAME.test(name)) {
      return {
        enabled: false, reason: 'NTFY_URL must not contain credentials in query parameters',
        ntfyUrl: null, ntfyToken: null, publicAppUrl,
      };
    }
  }
  if (rawToken && /[\s\u0000-\u001f\u007f]/.test(rawToken)) {
    return {
      enabled: false, reason: 'NTFY_TOKEN contains invalid characters',
      ntfyUrl: null, ntfyToken: null, publicAppUrl,
    };
  }

  return {
    enabled: true,
    reason: null,
    ntfyUrl: url.toString(),
    ntfyToken: rawToken || null,
    publicAppUrl,
  };
}

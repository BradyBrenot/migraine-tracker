// Environment-only ntfy reminder configuration.
//
// NTFY_URL / NTFY_TOKEN / NTFY_ATTACK_URL / NTFY_ATTACK_TOKEN / PUBLIC_APP_URL
// are NEVER persisted, exported, backed up, sent to the browser, or logged.
// This module only validates them and returns a plain object for the startup
// wiring; callers must not serialize it. Reason strings are fixed and contain
// no env values (only variable names).

const SECRET_QUERY_NAME = /^(auth|token|access[_-]?token|api[_-]?key|apikey|key|password|passwd)$/i;
const INVALID_TOKEN_CHARS = /[\s\u0000-\u001f\u007f]/;

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
 * Shared strict validation for one environment-only ntfy topic pair.
 * Returns { ok, reason, ntfyUrl, ntfyToken }; `reason` is a fixed sentence
 * naming the variable only (never its value). Personal and attack topics use
 * exactly the same rules, so a value valid for one is valid for the other.
 */
function resolveTopic(env, urlName, tokenName) {
  const rawUrl = typeof env[urlName] === 'string' ? env[urlName].trim() : '';
  const rawToken = typeof env[tokenName] === 'string' ? env[tokenName].trim() : '';
  const fail = (reason) => ({
    ok: false, reason, ntfyUrl: null, ntfyToken: null,
  });

  if (!rawUrl) return fail(`${urlName} is not set`);

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return fail(`${urlName} is not a valid URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return fail(`${urlName} must use http or https`);
  }
  if (url.username || url.password) {
    return fail(`${urlName} must not contain credentials`);
  }
  for (const name of url.searchParams.keys()) {
    if (SECRET_QUERY_NAME.test(name)) {
      return fail(`${urlName} must not contain credentials in query parameters`);
    }
  }
  if (rawToken && INVALID_TOKEN_CHARS.test(rawToken)) {
    return fail(`${tokenName} contains invalid characters`);
  }

  return {
    ok: true, reason: null, ntfyUrl: url.toString(), ntfyToken: rawToken || null,
  };
}

function publicAppUrlFrom(env) {
  return typeof env.PUBLIC_APP_URL === 'string'
    ? validPublicAppUrl(env.PUBLIC_APP_URL.trim())
    : null;
}

/**
 * Resolve personal reminder delivery configuration.
 * Returns { enabled, reason, ntfyUrl, ntfyToken, publicAppUrl }.
 * - Missing/invalid NTFY_URL => enabled:false with a fixed reason.
 * - Credentials in the URL (userinfo or query params) are rejected.
 * - A malformed PUBLIC_APP_URL only disables click links, never delivery.
 */
export function resolveReminderConfig(env = {}) {
  const topic = resolveTopic(env, 'NTFY_URL', 'NTFY_TOKEN');
  return {
    enabled: topic.ok,
    reason: topic.reason,
    ntfyUrl: topic.ntfyUrl,
    ntfyToken: topic.ntfyToken,
    publicAppUrl: publicAppUrlFrom(env),
  };
}

/**
 * Resolve attack start/end alert delivery configuration (a fully separate
 * topic from the personal reminders). Same shape, validation, and fixed
 * reason wording as resolveReminderConfig, applied to NTFY_ATTACK_URL /
 * NTFY_ATTACK_TOKEN.
 */
export function resolveAttackConfig(env = {}) {
  const topic = resolveTopic(env, 'NTFY_ATTACK_URL', 'NTFY_ATTACK_TOKEN');
  return {
    enabled: topic.ok,
    reason: topic.reason,
    ntfyUrl: topic.ntfyUrl,
    ntfyToken: topic.ntfyToken,
    publicAppUrl: publicAppUrlFrom(env),
  };
}

/**
 * Partner read-only view URL for notification click links. Attack alerts must
 * never link into the writer UI, so the click target is always `<base>/view`.
 * Null when no valid PUBLIC_APP_URL was configured (click link disabled), or
 * when the string cannot be parsed as a URL at all.
 */
export function attackViewUrl(publicAppUrl) {
  if (typeof publicAppUrl !== 'string' || publicAppUrl === '') return null;
  let url;
  try {
    url = new URL(publicAppUrl);
  } catch {
    return null;
  }
  url.search = '';
  url.hash = '';
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/view`;
  return url.toString();
}

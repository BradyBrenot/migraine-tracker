// Minimal ntfy publisher. POSTs plain text to the FULL topic URL from
// NTFY_URL; optional Title/Click headers; optional Bearer token header.
// No credentials ever go in query parameters, URLs, logs, or error messages.

export class DeliveryError extends Error {
  constructor(category, status = null) {
    // Fixed category text only: fetch errors can contain the URL/token and
    // response bodies are never read or surfaced.
    super(category);
    this.name = 'DeliveryError';
    this.category = category;
    this.status = Number.isInteger(status) ? status : null;
  }
}

/**
 * Build a transport: async ({ title, body }) => { status }.
 * `fetchImpl` is injectable so tests never touch the network.
 */
export function createNtfyTransport({
  ntfyUrl,
  ntfyToken = null,
  publicAppUrl = null,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10000,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('ntfy transport requires fetch');
  }
  return async function send({ title, body } = {}) {
    if (typeof title !== 'string' || typeof body !== 'string' || title.length === 0) {
      throw new DeliveryError('payload');
    }
    const headers = {
      Title: title,
      'Content-Type': 'text/plain; charset=utf-8',
    };
    if (publicAppUrl) headers.Click = publicAppUrl;
    if (ntfyToken) headers.Authorization = `Bearer ${ntfyToken}`;

    let response;
    try {
      response = await fetchImpl(ntfyUrl, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const name = err && typeof err.name === 'string' ? err.name : '';
      throw new DeliveryError(
        name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'fetch',
      );
    }
    if (!response || response.ok !== true) {
      throw new DeliveryError('http', response && response.status);
    }
    // Never read/forward the response body; only the status is meaningful.
    return { status: response.status };
  };
}

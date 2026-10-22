import { SECURITY_HEADERS } from './headers.js';

// Response helpers for Cloudflare Pages Functions.
export function send(code, body, headers = {}) {
  const isObj = body !== null && typeof body === 'object';
  return new Response(isObj ? JSON.stringify(body) : body || '', {
    status: code,
    headers: {
      ...SECURITY_HEADERS,
      'Content-Type': isObj ? 'application/json' : 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    },
  });
}
// Fallback for any method the route doesn't export a specific handler for.
export const methodNotAllowed = (method) => () => send(405, { error: 'Method not allowed' }, { Allow: method });

export const clientIp = (request) => request.headers.get('CF-Connecting-IP') || 'unknown';

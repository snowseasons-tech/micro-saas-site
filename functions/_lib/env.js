// The shared logic in api/_lib (store, auth, fulfil, mail) reads process.env. Pages Functions receive bindings
// as `env`, so copy the string ones across at the start of each request instead of relying on a compat flag.
export function useEnv(env) {
  for (const [k, v] of Object.entries(env || {})) if (typeof v === 'string') process.env[k] = v;
}

// Workers isolates don't share memory, so api/_lib/store.js's in-memory fallback would silently lose data.
export const storeConfigured = (env) => !!(env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN);

// api/_lib/auth.js reads the Node-style req.headers.cookie.
export const nodeReq = (request) => ({ headers: { cookie: request.headers.get('Cookie') || '' } });

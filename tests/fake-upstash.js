// Stands in for the Upstash Redis REST endpoint: just the commands api/_lib/store.js sends.
module.exports = function fakeUpstash(other) {
  const data = new Map();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url) !== 'https://redis.test') return other ? other(String(url), init) : realFetch(url, init);
    const [op, ...a] = JSON.parse(init.body);
    let result = null;
    if (op === 'GET') result = data.has(a[0]) ? data.get(a[0]) : null;
    else if (op === 'DEL') { data.delete(a[0]); result = 1; }
    else if (op === 'SET') {
      if (a.includes('NX') && data.has(a[0])) result = null;
      else { data.set(a[0], a[1]); result = 'OK'; }
    } else if (op === 'INCR' || op === 'EVAL') {
      const key = op === 'INCR' ? a[0] : a[2];
      result = Number(data.get(key) || 0) + 1;
      data.set(key, String(result));
    }
    return new Response(JSON.stringify({ result }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { data, restore: () => { globalThis.fetch = realFetch; } };
};

// api.js — thin client for the kbmcp REST interface (/files).
//
// list()  -> GET  /files/<dir>   (JSON directory listing)
// read()  -> GET  /files/<path>  (raw content + ETag)
// write() -> PUT  /files/<path>  (?message=…, optional If-Match; commits)

// Signals that the server rejected us for auth reasons and a (re)login is needed.
export class AuthError extends Error {
  constructor(msg = 'authentication required') {
    super(msg);
    this.name = 'AuthError';
  }
}

// Encode each path segment but keep the slashes. '' stays '' (the root).
function encodePath(path) {
  return String(path)
    .split('/')
    .filter((s) => s.length)
    .map(encodeURIComponent)
    .join('/');
}

// tokenProvider is an async function returning the current bearer token, or null
// for same-origin cookie mode.
export function KbClient(kbUrl, tokenProvider) {
  const base = String(kbUrl).replace(/\/+$/, '');

  // Build fetch options. With a bearer token (OAuth or manual) we authenticate
  // via the header and must NOT send credentials — sending them forces
  // credentialed-CORS mode, which needs Access-Control-Allow-Credentials:true and
  // a non-'*' origin. Only same-origin cookie mode (no token) uses 'include'.
  async function init(extraHeaders, rest) {
    const t = await tokenProvider();
    const h = { ...(extraHeaders || {}) };
    if (t) h.Authorization = `Bearer ${t}`;
    // Names us in the KB's request log. Self-declared, so it identifies the app
    // for a human reading logs — it proves nothing, and nothing depends on it.
    h['X-Client-Id'] = 'kb-editor';
    return {
      mode: 'cors',
      credentials: t ? 'omit' : 'include',
      headers: h,
      ...(rest || {}),
    };
  }

  // '/files/' + '' is the root dir; '/files/' + 'a/b' is a nested path.
  const filesUrl = (path) => `${base}/files/${encodePath(path)}`;

  return {
    base,

    async list(path = '') {
      const r = await fetch(filesUrl(path), await init());
      if (r.status === 401) throw new AuthError();
      if (!r.ok) throw new Error(`list "${path}": ${r.status}`);
      const data = await r.json();
      return data.entries || [];
    },

    async read(path) {
      const r = await fetch(filesUrl(path), await init());
      if (r.status === 401) throw new AuthError();
      if (!r.ok) throw new Error(`read "${path}": ${r.status}`);
      return { text: await r.text(), etag: r.headers.get('ETag') };
    },

    async write(path, content, message, opts = {}) {
      const extra = { 'Content-Type': 'text/markdown; charset=utf-8' };
      if (opts.ifMatch) extra['If-Match'] = opts.ifMatch;
      if (opts.ifNoneMatch) extra['If-None-Match'] = opts.ifNoneMatch;
      const url = `${filesUrl(path)}?message=${encodeURIComponent(message)}`;
      const r = await fetch(url, await init(extra, { method: 'PUT', body: content }));
      if (r.status === 401) throw new AuthError();
      // 412 means a preconditon failed; which one depends on what we sent.
      if (r.status === 412) {
        throw new Error(opts.ifNoneMatch
          ? 'a file already exists at that path'
          : 'the file changed on the server since you opened it — reload before saving');
      }
      if (!r.ok) throw new Error(`save "${path}": ${r.status}`);
      return { etag: r.headers.get('ETag'), created: r.status === 201 };
    },

    // Recent commits (newest first): [{hash, date, relative, author, subject}].
    async history({ max = 50, path = '' } = {}) {
      const q = new URLSearchParams();
      if (max) q.set('max', max);
      if (path) q.set('path', path);
      const r = await fetch(`${base}/history?${q}`, await init());
      if (r.status === 401) throw new AuthError();
      if (!r.ok) throw new Error(`history: ${r.status}`);
      const data = await r.json();
      return data.commits || [];
    },
  };
}

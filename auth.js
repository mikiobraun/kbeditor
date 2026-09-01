// auth.js — OAuth 2.1 (authorization code + PKCE) against volume-auth.
//
// This is a public SPA client: it discovers the authorization server from the
// knowledge base URL (RFC 9728 -> RFC 8414), self-registers a client
// (RFC 7591), runs the PKCE flow, and manages access/refresh tokens per KB.
// No secrets are involved; everything is stored in the browser.

const SCOPES = 'read write';
const enc = new TextEncoder();

// ---- small crypto/util helpers ----

function base64url(bytes) {
  const b = new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256(str) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(str)));
}

function randomString(len = 64) {
  return base64url(crypto.getRandomValues(new Uint8Array(len))).slice(0, len);
}

function trimSlash(u) {
  return String(u).trim().replace(/\/+$/, '');
}

// The redirect URI is this app's own URL, stripped of any query/hash.
function redirectUri() {
  return location.origin + location.pathname;
}

async function fetchJson(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`${(opts && opts.method) || 'GET'} ${url} -> ${r.status} ${body.slice(0, 200)}`);
  }
  return r.json();
}

// ---- discovery ----

async function discover(kbUrl) {
  const base = trimSlash(kbUrl);
  // The KB advertises which authorization server protects it (RFC 9728).
  const prm = await fetchJson(`${base}/.well-known/oauth-protected-resource`);
  const resource = prm.resource || `${base}/`;
  const issuer = trimSlash((prm.authorization_servers || [])[0] || '');
  if (!issuer) throw new Error('the knowledge base did not advertise an authorization server');
  // The AS describes its endpoints (RFC 8414).
  const asm = await fetchJson(`${issuer}/.well-known/oauth-authorization-server`);
  return {
    resource,
    issuer,
    authorizationEndpoint: asm.authorization_endpoint,
    tokenEndpoint: asm.token_endpoint,
    registrationEndpoint: asm.registration_endpoint,
  };
}

// ---- client registration (RFC 7591), cached per issuer ----

async function ensureClient(meta) {
  const key = `va_client_${meta.issuer}`;
  const cached = localStorage.getItem(key);
  if (cached) return cached;
  if (!meta.registrationEndpoint) {
    throw new Error('the authorization server has no registration endpoint');
  }
  const reg = await fetchJson(meta.registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'kb editor',
      redirect_uris: [redirectUri()],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none', // public client
      scope: SCOPES,
    }),
  });
  localStorage.setItem(key, reg.client_id);
  return reg.client_id;
}

// ---- login: redirect to the AS ----

export async function beginLogin(kbUrl) {
  const meta = await discover(kbUrl);
  const clientId = await ensureClient(meta);
  const verifier = randomString(64);
  const challenge = base64url(await sha256(verifier));
  const state = randomString(32);
  sessionStorage.setItem('va_flow', JSON.stringify({ verifier, state, kbUrl: trimSlash(kbUrl), meta, clientId }));

  const p = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri(),
    scope: SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: meta.resource, // bind the token audience to this KB (RFC 8707)
  });
  location.assign(`${meta.authorizationEndpoint}?${p}`);
}

// If we've just been redirected back with ?code, finish the exchange.
// Returns { kbUrl } on success, or null when this isn't an auth redirect.
export async function completeLoginIfReturning() {
  const url = new URL(location.href);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const err = url.searchParams.get('error');
  if (err) {
    cleanUrl();
    throw new Error(`authorization failed: ${err} ${url.searchParams.get('error_description') || ''}`);
  }
  if (!code) return null;

  const flow = JSON.parse(sessionStorage.getItem('va_flow') || 'null');
  cleanUrl();
  if (!flow || flow.state !== state) throw new Error('state mismatch (possible CSRF) — please try connecting again');

  const tok = await fetchJson(flow.meta.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(),
      client_id: flow.clientId,
      code_verifier: flow.verifier,
      resource: flow.meta.resource,
    }),
  });
  storeToken(flow.kbUrl, flow.meta, flow.clientId, tok);
  sessionStorage.removeItem('va_flow');
  return { kbUrl: flow.kbUrl };
}

function cleanUrl() {
  history.replaceState({}, '', location.origin + location.pathname);
}

// ---- token store, keyed by KB URL ----

function tokenKey(kbUrl) {
  return `va_token_${trimSlash(kbUrl)}`;
}

function storeToken(kbUrl, meta, clientId, tok) {
  localStorage.setItem(tokenKey(kbUrl), JSON.stringify({
    access_token: tok.access_token,
    refresh_token: tok.refresh_token || null,
    expires_at: Date.now() + (tok.expires_in || 3600) * 1000,
    meta,
    clientId,
  }));
}

// Return a valid access token for kbUrl, refreshing if it's about to expire.
// Returns null if there's no usable token (caller should start a login).
export async function getAccessToken(kbUrl) {
  const raw = localStorage.getItem(tokenKey(kbUrl));
  if (!raw) return null;
  const b = JSON.parse(raw);
  if (Date.now() < b.expires_at - 30_000) return b.access_token;
  if (!b.refresh_token || !b.meta) { logout(kbUrl); return null; }
  try {
    const tok = await fetchJson(b.meta.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: b.refresh_token,
        client_id: b.clientId,
        resource: b.meta.resource,
        scope: SCOPES,
      }),
    });
    storeToken(kbUrl, b.meta, b.clientId, tok);
    return tok.access_token;
  } catch (e) {
    logout(kbUrl);
    return null;
  }
}

export function hasToken(kbUrl) {
  return !!localStorage.getItem(tokenKey(kbUrl));
}

export function logout(kbUrl) {
  localStorage.removeItem(tokenKey(kbUrl));
}

// Escape hatch for local / same-origin testing: store a bearer token by hand,
// bypassing the OAuth flow. No refresh; treated as long-lived.
export function setManualToken(kbUrl, token) {
  localStorage.setItem(tokenKey(kbUrl), JSON.stringify({
    access_token: token,
    refresh_token: null,
    expires_at: Date.now() + 365 * 24 * 3600 * 1000,
    meta: null,
    clientId: null,
  }));
}

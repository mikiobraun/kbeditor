# kb editor

A pure-frontend viewer/editor for a [kbmcp](../kbmcp) knowledge base. No backend
of its own — it builds to static files. You give it a KB URL, it signs you in
through that KB's gateway ([volume-auth](../volume-auth)), and talks to the KB's
REST interface (`/files`).

```
[ file tree ] │ [ rendered markdown / raw / edit ]
```

## Stack

- **Vue 3** with **Vite** as the dev server / bundler. No SFCs and no framework
  plugin: components are plain objects with string `template:` options, so
  `vite.config.js` aliases `vue` to the esm-bundler build (the default npm entry
  is runtime-only and can't compile those templates).
- **marked** for markdown, **DOMPurify** to sanitize the rendered HTML.
- Plain `fetch` against the kbmcp REST API.

Files:

| file | role |
|---|---|
| `index.html` | mount point + entry script |
| `app.js` | root component, file tree (`TreeNode`), viewer/editor |
| `api.js` | kbmcp REST client (`list` / `read` / `write` / `history`) |
| `auth.js` | OAuth 2.1 authorization-code + PKCE against volume-auth |
| `style.css` | styling (light/dark aware) |
| `vite.config.js` | Vue alias, dev-server host/port, HMR-through-Caddy setup |

## Running

```sh
npm install
npm run dev       # Vite on 127.0.0.1:8072
npm run build     # static bundle -> dist/
npm run preview   # serve the built bundle
```

A secure context is required for `crypto.subtle` and OAuth redirects, so reach
the dev server over `localhost` or through a TLS-terminating proxy. The config is
set up for the latter: Caddy fronts `https://editor.example.com` → `:8072`, with
that host in `allowedHosts` and HMR pointed at `wss://…:443`. Change those three
places if you front it with a different name.

For real use, serve `dist/` behind the same gateway/host family as your KB (or
anywhere that's an allowed origin — see CORS below).

## How auth works

The app is a **public OAuth client**. When you connect to a KB URL it:

1. Discovers the authorization server from the KB:
   `GET <kb>/.well-known/oauth-protected-resource` (RFC 9728) →
   `GET <issuer>/.well-known/oauth-authorization-server` (RFC 8414).
2. **Self-registers** a client the first time (RFC 7591), caching the
   `client_id` per issuer in `localStorage`.
3. Runs **authorization code + PKCE**: redirects to `/authorize`, then exchanges
   the returned code at `/token` for a bearer JWT bound to that KB. The authorize
   request sends the KB as **both** `resource` (RFC 8707) and `audience` — Ory
   Hydra reads the audience from the latter — so keep both.
4. Stores the access/refresh tokens per KB URL in `localStorage` and refreshes
   them as needed.

All KB requests then carry `Authorization: Bearer <token>`. There are no secrets
in the app.

> **Token storage note:** tokens live in `localStorage` for persistence across
> reloads, which is XSS-exposed. Fine for a personal tool; harden (in-memory +
> silent refresh) before wider use.

### Advanced (connect screen)

- **Bearer token** — paste one to skip the OAuth flow entirely. Handy for testing
  against a KB running in bearer-token mode, or a same-origin deployment.
- **Delete client_id cache** — forgets the per-issuer registrations from step 2.
  Use it when the authorization server's database has been reset and sign-in
  fails with `invalid_client`: the next connect re-registers from scratch.

## CORS (the deployment gotcha)

Because this is a separate origin from the KB, the **servers it calls** must send
CORS headers — not the server that hosts these files. Two of them:

- **The KB gateway** (in front of kbmcp), for `/files`: allow this app's origin,
  `Expose-Headers: ETag` (needed for the If-Match save flow), the methods
  `GET, PUT, OPTIONS`, and the headers `Authorization, Content-Type, If-Match,
  If-None-Match`. Crucially, let the **unauthenticated `OPTIONS` preflight bypass
  forward_auth**, or the browser's preflight gets redirected to login and the
  request fails.
- **volume-auth**, for the programmatic calls: `POST /token`, `/register`, and
  the `.well-known/*` + `jwks.json` discovery fetches. (`/authorize` and `/login`
  are top-level redirects, not fetches, so they need no CORS.)

## Editing

Edit mode saves via `PUT /files/<path>?message=…` with `If-Match: <etag>` from
the read, so a concurrent change on the server surfaces as a 412 ("file changed
… reload before saving") instead of silently clobbering. Every save is a commit
on the KB side, which is why a commit message is required.

## Viewing

Notes render as sanitized markdown, with a leading YAML frontmatter block (only
flat `key: value` scalars are parsed) pulled out and shown as a metadata card —
emails written into the vault carry `from`/`subject`/`date` that way, and without
the split `marked` turns the closing `---` into a setext heading. **Raw** shows
the file verbatim. **Log** in the header lists the KB's recent commits
(`GET /history`).

## Status / not yet done

- Viewer + single-file editing. No create-new-file / rename / delete UI yet
  (the REST API is read + create/overwrite; delete isn't exposed server-side).
- No wiki-link navigation (kbmcp exposes `backlinks`/`outgoing_links` over MCP,
  not REST).
- Tree loads lazily per folder; no search box yet.

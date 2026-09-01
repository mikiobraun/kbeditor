# kb editor

A pure-frontend viewer/editor for a [kbmcp](../kbmcp) knowledge base. No build
step, no backend of its own — just static files. You give it a KB URL, it signs
you in through that KB's gateway ([volume-auth](../volume-auth)), and talks to
the KB's REST interface (`/files`).

```
[ file tree ] │ [ rendered markdown / raw / edit ]
```

## Stack

- **Vue 3**, loaded as ESM from a CDN (no npm, no bundler) via an import map in
  `index.html`.
- **marked** for markdown, **DOMPurify** to sanitize the rendered HTML.
- Plain `fetch` against the kbmcp REST API.

Files:

| file | role |
|---|---|
| `index.html` | import map + mount point |
| `app.js` | root component, file tree (`TreeNode`), viewer/editor |
| `api.js` | kbmcp REST client (`list` / `read` / `write`) |
| `auth.js` | OAuth 2.1 authorization-code + PKCE against volume-auth |
| `style.css` | styling (light/dark aware) |

## Running

It's static — serve the folder over HTTP (a secure context is required for
`crypto.subtle` and OAuth redirects; `localhost` counts):

```sh
python3 -m http.server 8091      # then open http://localhost:8091
```

For real use, host it behind the same gateway/host family as your KB (or anywhere
that's an allowed origin — see CORS below).

## How auth works

The app is a **public OAuth client**. When you connect to a KB URL it:

1. Discovers the authorization server from the KB:
   `GET <kb>/.well-known/oauth-protected-resource` (RFC 9728) →
   `GET <issuer>/.well-known/oauth-authorization-server` (RFC 8414).
2. **Self-registers** a client the first time (RFC 7591), caching the
   `client_id` per issuer in `localStorage`.
3. Runs **authorization code + PKCE**: redirects to `/authorize`, then exchanges
   the returned code at `/token` for a bearer JWT bound to that KB (`resource`
   parameter, RFC 8707).
4. Stores the access/refresh tokens per KB URL in `localStorage` and refreshes
   them as needed.

All KB requests then carry `Authorization: Bearer <token>`. There are no secrets
in the app.

> **Token storage note:** tokens live in `localStorage` for persistence across
> reloads, which is XSS-exposed. Fine for a personal tool; harden (in-memory +
> silent refresh) before wider use.

### Local / same-origin escape hatch

Under **advanced** on the connect screen you can paste a bearer token directly,
skipping the OAuth flow — handy for testing against a KB running in bearer-token
mode, or a same-origin deployment.

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
on the KB side.

## Status / not yet done

- Viewer + single-file editing. No create-new-file / rename / delete UI yet
  (the REST API is read + create/overwrite; delete isn't exposed server-side).
- No wiki-link navigation (kbmcp exposes `backlinks`/`outgoing_links` over MCP,
  not REST).
- Tree loads lazily per folder; no search box yet.

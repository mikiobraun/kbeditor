# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`kb-editor` — a frontend-only Vue 3 viewer/editor for a **kbmcp** knowledge base
(`../kbmcp`). It has no backend of its own: it signs in through the KB's gateway
(`../volume-auth`) via OAuth and talks to the KB's REST interface. Both sibling
repos matter when debugging auth or API behaviour.

## Commands

```sh
npm run dev       # Vite dev server on 127.0.0.1:8072 (strictPort)
npm run build     # -> dist/
npm run preview
```

There are no tests, linter, or typechecker configured.

The dev server is reachable through a Caddy reverse proxy at
`https://editor.example.com` (allowedHosts + HMR over wss are configured for
exactly that host in `vite.config.js`). A secure context is required — OAuth
redirects and `crypto.subtle` don't work over plain http on a non-localhost host.

## Architecture

Four source files, no framework plugin, no SFCs:

| file | role |
|---|---|
| `app.js` | root component + `TreeNode`; all UI state and view logic |
| `api.js` | `KbClient(kbUrl, tokenProvider)` — REST client for `/files` and `/history` |
| `auth.js` | OAuth 2.1 code+PKCE against volume-auth; token/client storage |
| `style.css` | all styling; light/dark via `prefers-color-scheme` |

Components are plain objects with string `template:` options (not `.vue` files).
That's why `vite.config.js` aliases `vue` → `vue/dist/vue.esm-bundler.js`: the
default npm entry is the runtime-only build and cannot compile those templates.
If you add a component, keep the same style or the alias assumption breaks.

**Data flow.** `App.setup()` owns `client` (a `KbClient`) and everything else.
The file tree is lazy: `App` provides a `listDir` function via `provide`, and each
`TreeNode` `inject`s it and fetches its own children on first expand
(`node.children === null` means "not loaded"). Dot-files are filtered and folders
sort before files everywhere — the same sort exists in `loadRoots` and
`loadChildren`; change both.

**Auth flow** (`auth.js`), all browser-side, no secrets:
1. Discovery: `GET <kb>/.well-known/oauth-protected-resource` (RFC 9728) →
   `GET <issuer>/.well-known/oauth-authorization-server` (RFC 8414).
2. Dynamic client registration (RFC 7591) the first time, `client_id` cached in
   `localStorage` under `va_client_<issuer>`. When the AS's database is reset,
   this cache goes stale and login fails with `invalid_client` — the connect
   screen's *advanced → Delete client_id cache* button (`clearClientCache`) is the
   fix.
3. Code + PKCE. The authorize request sends **both** `resource` and `audience`
   with the same value: Ory Hydra reads the audience from `audience`, the spec
   (RFC 8707) says `resource`. Keep both.
4. Tokens stored per-KB in `localStorage` under `va_token_<kbUrl>`, refreshed
   when within 30s of expiry; a failed refresh logs out and returns null so the
   caller starts a fresh login.

`api.js` throws `AuthError` on 401; `App.connect()` catches it and redirects to
login. Bearer-token mode sends `credentials: 'omit'` deliberately — sending
credentials would force credentialed CORS, which the gateway isn't set up for.
Only same-origin cookie mode (no token) uses `'include'`.

**Saving** is `PUT /files/<path>?message=…` with `If-Match: <etag>` from the read.
A 412 is surfaced as "the file changed on the server" rather than clobbering.
Every save is a commit on the KB side, so a commit message is required.

**Rendering.** `renderNote` splits leading YAML frontmatter off (flat scalar keys
only) and renders it as a table, then `marked` + `DOMPurify.sanitize` for the
body. Without the split, `marked` turns the closing `---` into a setext heading.
Anything that reaches `v-html` must go through `DOMPurify`.

## Deployment gotcha: CORS

The app is a different origin from the KB, so the **servers it calls** need CORS
headers — not the server hosting these files. The KB gateway must expose `ETag`
(the If-Match save flow depends on it), allow `Authorization, Content-Type,
If-Match, If-None-Match`, and let unauthenticated `OPTIONS` preflights bypass
forward_auth, or preflight gets redirected to login. volume-auth needs CORS on
`/token`, `/register` and the `.well-known/*` + `jwks.json` fetches (`/authorize`
and `/login` are top-level redirects, not fetches).

## Conventions

- `changes.local` (gitignored) is a pending-work log: append a self-contained
  entry per logical change so whoever commits later — possibly a different agent
  — can reconstruct clean commits. Read its header for the entry template, and
  delete entries once committed.
- `README.md` documents the same auth/CORS/save behaviour for humans; keep the
  two in sync when any of that changes.

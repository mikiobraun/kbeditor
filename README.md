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

**New** opens an empty buffer at a path you name (`.md` is appended unless the
name already has an extension; missing folders are created with it). Nothing is
written until you save, so a new note costs one commit and cancelling leaves no
trace. That first save goes out with `If-None-Match: *`, so if someone else took
the path meanwhile it fails instead of overwriting them.

## Staying in sync

The REST API has no watch endpoint, but every write to the KB is a commit, so the
head commit is a single cheap change token: `GET /history?max=1` answers "did
anything change?" for the whole vault, in one request whose cost doesn't grow
with the repo.

There is no polling. The check runs when the tab regains focus and when you click
in the tree or the document — the moments a stale view starts to matter — with a
2-second floor so a burst of clicks is one request. An idle tab makes no requests
at all.

When the token moves, the tree re-lists its open folders (keeping expansion and
selection) and the open file is re-read. While you're editing, the buffer is left
alone and a banner offers to reload instead — the `If-Match` save would be
rejected anyway, and losing your text to a background refresh would be worse than
a stale view. Hitting **Edit** takes the server's current version first, so you
never start typing against a stale copy; it says so in the banner when that
happens.

A change that doesn't move HEAD — something written into the vault without a
commit — is invisible to this.

## Coming back

The last KB and the file you had open are remembered per KB, so a reload drops
you back where you were, with the tree expanded down to that file. Reconnecting
never redirects to the login page on its own: if the stored token has expired you
get the connect card and a note, not a surprise navigation. **Disconnect** drops
the token, and with it the automatic reconnect.

## Viewing

Notes render as sanitized markdown, with a leading YAML frontmatter block pulled
out and shown as a metadata card (without the split, `marked` turns the closing
`---` into a setext heading). The card handles the full structure the vault
actually uses — the mail notes carry nested maps and lists of maps — so nested
keys indent and each element of a list keeps its fields grouped. Scalar lists sit
inline: `tags: inbox, work`.

Values are shown exactly as written. Parsing uses YAML's failsafe schema, which
knows only maps, sequences and strings, so `date: 2026-09-06` stays that text
instead of becoming a JavaScript `Date` that prints as
`Sun Sep 06 2026 00:00:00 GMT+0200`. A block that won't parse is shown verbatim
rather than dropped.

Since frontmatter has no meaningful ordering, a long block isn't truncated —
**Frontmatter** and **Content** in the toolbar jump between the card and the note
body instead. **Raw** shows the file verbatim, and **Log** in the header lists
the KB's recent commits (`GET /history`).

## Status / not yet done

- Viewer, single-file editing, create. No rename / delete UI (the REST API is
  read + create/overwrite; delete isn't exposed server-side).
- No wiki-link navigation (kbmcp exposes `backlinks`/`outgoing_links` over MCP,
  not REST).
- Tree loads lazily per folder; no search box yet.

# kb editor

A pure-frontend viewer/editor for a [kbmcp](../kbmcp) knowledge base. No backend
of its own — it builds to static files. You give it a KB URL, it signs you in
through that KB's gateway ([volume-auth](../volume-auth)), and talks to the KB's
REST interface (`/files`).

```
[ file tree ] │ [ rendered markdown / raw / edit ]
```

## Stack

- **Vue 3** single-file components, built by **Vite**. Templates compile at build
  time, so the browser gets the runtime-only Vue and never a template compiler.
- **marked** for markdown, **DOMPurify** to sanitize it, **js-yaml** for
  frontmatter.
- Plain `fetch` against the kbmcp REST API. No store, no router, no UI framework.
- **vitest** for tests; jsdom only where a test needs a DOM.

Layout:

| path | role |
|---|---|
| `src/main.js` | mounts the app |
| `src/api.js` | kbmcp REST client (`list` / `read` / `write` / `search` / `find` / `links` / `history`) |
| `src/auth.js` | OAuth 2.1 authorization-code + PKCE against volume-auth |
| `src/lib/` | pure functions — markdown and frontmatter rendering, task lines, text helpers. No Vue, no DOM, all unit-tested |
| `src/composables/` | the behaviour: the open document, the tree, search, sync, links and checkboxes, history, mobile chrome |
| `src/components/` | `App.vue` (layout and wiring) plus the pieces that own state or are pure views |
| `src/style.css` | styling (light/dark aware) |
| `vite.config.js` | dev-server host/port and HMR-through-Caddy setup |

Composables take their collaborators as arguments rather than importing them, so
dependencies point one way and a test can pass stubs. Markup becomes a component
only when it owns state (the connect screen, the dialogs) or is a pure view of
props (the two result lists) — the header, toolbar and tree stay in `App.vue`,
since extracting them would only move markup while leaving the state behind.

## Running

```sh
npm install
npm run dev       # Vite on 127.0.0.1:8072
npm run build     # static bundle -> dist/
npm run preview   # serve the built bundle
npm test          # vitest
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
  `GET, PUT, DELETE, OPTIONS`, and the headers `Authorization, Content-Type, If-Match,
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

Task-list checkboxes are live in the rendered view: ticking one rewrites that
line's marker in the source, saves it with `If-Match`, and commits as
`Check "first 30 characters…"`. One commit per tick, as on GitHub. The label is
the item's text with formatting stripped and cut at 30 characters — one rule
regardless of how the line is punctuated, since the notes use em dashes, colons
and full stops interchangeably. If the source line doesn't match what the box on
screen was showing, the tick is refused rather than applied to a line it can't
vouch for.

**New** opens an empty buffer at a path you name (`.md` is appended unless the
name already has an extension; missing folders are created with it). Nothing is
written until you save, so a new note costs one commit and cancelling leaves no
trace. That first save goes out with `If-None-Match: *`, so if someone else took
the path meanwhile it fails instead of overwriting them.

**Delete** removes the open note via `DELETE /files/<path>?message=…`, after a
dialog asking for the commit message (pre-filled as `Delete <path>`). It sends
`If-Match`, so a note someone rewrote since you opened it is refused with a 412
rather than deleted. kbmcp also refuses a file with uncommitted changes, so every
deletion can be undone from history. Afterwards the pane is empty and `?note=` is
dropped from the URL.

## Search

The header box searches note contents across the whole KB via
`GET /search?substring=…`, which is kbmcp's ripgrep-backed search behind a REST
route. Substring only: the parameter is named for the mode, so a literal like
`[x]` is never read as a regex.

One search per press of **Search** (or Enter) — not per keystroke, since each one
spawns a ripgrep over the vault. Results fill the pane grouped by file, with each
matching line and its line number; clicking one opens that file, expanding the
tree down to it, with the term marked and the first hit scrolled into view. The
term stays in the box, so pressing Search again brings the results back.

Marking follows ripgrep's smart case — a pattern containing an uppercase letter
matches case-sensitively — so what's highlighted is exactly what the server
counted as a match.

The box at the top of the tree searches **filenames** instead, via
`GET /find?substring=…`. The term is escaped server-side before it reaches `fd`,
so `meeting.md` matches that name literally rather than as a pattern whose `.`
means any character. Results replace the tree with a flat list — filename over
muted folder — and clicking one opens it while leaving the list up, since
finding files usually means opening several. **Clear** restores the tree, already
expanded to whatever you opened.

That list is deliberately flat rather than a filtered tree: a folder shown
holding only its matching children reads as a folder that contains only those
children.

Not yet: live search as you type, cycling between hits, restricting a search to
a folder, regex mode.

## Wiki links and history

`[[wiki links]]` in a rendered note are clickable. Where each one points is
decided by kbmcp (`GET /links?path=…`), not by the editor — a name resolves to a
sibling first and then vault-wide, a target with a slash is a vault path, and an
ambiguous name resolves to nothing. A link that doesn't resolve stays visible in
dotted red and gives the reason on hover, listing the candidates when a name
matched several notes.

Opening a note pushes `?note=<path>` onto the browser's history, so Back walks
the notes you followed and a URL can be shared or reloaded straight into a note.
Only notes are history entries — search results aren't, which keeps queries out
of the URL and a ripgrep off the Back button.

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

If the open file was deleted elsewhere, a banner says it doesn't exist anymore.
When you're only viewing it, the note is closed. When you're editing, the buffer is
kept and becomes a new file: saving creates it again, and Cancel discards it.

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

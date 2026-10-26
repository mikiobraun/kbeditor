# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`kb-editor` — a frontend-only Vue 3 viewer/editor for a **kbmcp** knowledge base
(`../kbmcp`). It has no backend of its own: it signs in through the KB's gateway
(`../volume-auth`) via OAuth and talks to the KB's REST interface. Both sibling
repos matter when debugging auth or API behaviour.

## Commands

```sh
npm run dev        # Vite dev server on 127.0.0.1:8072 (strictPort)
npm run build      # -> dist/
npm run preview    # serve the built bundle
npm test           # vitest, once
npm run test:watch
```

No linter or typechecker is configured. `npm test` runs in node by default; a
test that needs a DOM opts in with `// @vitest-environment jsdom` on its first
line and is named `*.dom.test.js`, so a plain unit test never pays jsdom's
~350ms startup.

The dev server does **not** pick up `vite.config.js` changes if it was started
before them — restart it. A stale server reports `.vue` files as "invalid JS
syntax", which reads like a code error and isn't one.

The dev server is reachable through a Caddy reverse proxy at
`https://editor.example.com` (allowedHosts + HMR over wss are configured for
exactly that host in `vite.config.js`). A secure context is required — OAuth
redirects and `crypto.subtle` don't work over plain http on a non-localhost host.

## Architecture

Single-file components: templates compile at build time, so only the runtime
`vue` build reaches the browser.

```
src/main.js          mounts App
src/api.js           KbClient(kbUrl, tokenProvider) — REST client
src/auth.js          OAuth 2.1 code+PKCE against volume-auth; token storage
src/style.css        all styling; light/dark via prefers-color-scheme
src/lib/             pure functions: no Vue, no DOM, no network — the tested part
src/composables/     the app's behaviour, one concern per file
src/components/      App.vue plus the pieces that own state or are pure views
```

**Where to put a change.** The organising rule is what a piece *owns*:

- `lib/` — anything that is a function of its arguments. If it can be written
  without Vue, it belongs here and gets a unit test. The one exception is
  `tree.js`: `makeNode` returns a reactive node, so it imports Vue and has no
  test.
- `composables/` — state plus the operations on it. Each takes its collaborators
  as arguments rather than importing them, so the dependencies point one way and
  a test can pass stubs.
- `components/` — only where a piece **owns state** (`ConnectScreen` owns the
  URL and token fields; the dialogs own their input) or is a **pure view**
  (`SearchResults`, `FindResults`: props in, events out). Header, toolbar and
  tree markup deliberately stay in `App.vue`: they own nothing, so extracting
  them would mean injecting a context, and a component that reaches into shared
  context is a file split rather than a boundary.

`useDocument` is the hub — the open note, its modes, and every way it changes.
Everything else depends on it and it depends on nothing but callbacks. Its long
parameter list is that hub-and-spoke shape being honest. The signal that
something has gone wrong is not the list growing but changing kind: if it ever
imports `useTree`, or a callback needs a value only the tree can compute, the
dependency has become bidirectional.

**Data flow.** `App.vue` creates the composables and wires them together; it is
the only place that knows how they fit. The file tree is lazy: `useTree`
provides a `listDir` function, and each `TreeNode` injects it and fetches its own
children on first expand (`node.children === null` means "not loaded"). `listDir`
is the single place that hides dot-files and sorts folders before files, so every
consumer — the roots, `TreeNode`, the post-change refresh, `revealPath` — agrees
on ordering.

**Search** (`useSearch.js`, `useFind.js`). Two of them, on submit only — never per keystroke, since each call
spawns a ripgrep or an fd over the vault. `GET /search?substring=…` searches
contents, grouped by file in the pane. `GET /find?substring=…` searches
filenames from the box above the tree, replacing it with a flat list (a filtered
*tree* would show folders holding only their matching children, which reads as
folders that contain only those). Both `openMatch` and `openFound` route through
`revealPath`, so the file ends up selected in the tree rather than opening from
nowhere. Both endpoints take `substring` and escape it server-side, so a typed
`.` or `[x]` is a literal.

Highlighting has two rules worth keeping. It never builds HTML from search
results or note content: the results list renders `<mark>` elements from
`matchParts`, and the note is marked by walking **text nodes** (a regex over the
rendered HTML would rewrite tags and attribute values). And it uses `caseFold`,
mirroring ripgrep's smart case, so nothing is marked that the server didn't
match. A `watch` on `[rendered, highlight, mode]` re-applies it, because leaving
Raw mode recreates the pane element and drops the marks.

**Task checkboxes** (`useDecorations.js`, `lib/tasks.js`). marked renders
`- [ ]` as a disabled `<input>` and
DOMPurify's default allow-list keeps it, so `bindTaskBoxes` only has to enable
them and map a click back to its source line — by position, since render and
source list tasks in the same order. Two things keep that mapping honest:
`taskLines` skips fenced code blocks (marked doesn't render a `- [ ]` inside a
fence, so counting one would shift every later index), and the selector takes
only marked's own `li > input:first-child`, so inline HTML in a note can't. Before
writing, the source line's state must match what the box was showing; on mismatch
or a failed write the box is reverted and nothing is committed. Each tick is one
commit, with the message `Check "<label>"` or `Uncheck "<label>"`; `taskLabel`
is the item's text with formatting stripped, cut at 30 characters.

**Wiki links** (`useDecorations.js`). `GET /links?path=…` returns each `[[…]]` with what it resolves
to; the grammar lives in kbmcp, so the editor never guesses a target. Rendering
follows the same text-node rule as the highlighter, skipping `code`, `pre` and
existing links. The one subtlety: resolutions arrive *after* the render they
belong to, and converting `[[…]]` consumes the markers — so elements carry
`data-raw` and `decorateWikiLink` re-runs over them, rather than a second pass
looking for text that is no longer there. An empty `linkMap` means "not answered
yet", not "all broken", since a note with links always returns one entry each.

**External links** (`useDecorations.js`). `bindExternalLinks` gives http(s)
links to another origin `target="_blank"` and `rel="noopener noreferrer"`.
It runs on the rendered pane and not in `renderNote`, because DOMPurify strips
`target` from sanitized HTML. `mailto:`, anchors and relative links are left
alone.

**Toolbar** (`App.vue`, `style.css`). Two flex items: the `.path` span and one
`.actions` div holding the buttons. `.toolbar` wraps, and wrapping is decided on
unshrunk widths, so both share a line when the whole path fits and otherwise the
buttons drop to a second row as a block. The buttons must stay grouped: as
separate flex items they wrap one at a time. Within `.path` the folder span
shrinks about 100x more readily than the name span, so the filename is the last
thing to be cut. Clicking `.path` runs `copyPath`, which writes `selected.path`
to the clipboard. `copiedPath` stores the copied path, not a flag, so the
"· copied" mark disappears when another note is opened.

**Phone layout** (`style.css`, `useChrome.js`). One breakpoint,
`@media (max-width: 720px)`. Below it the tree is a drawer (`treeOpen`, closed
again when a file is picked), toolbar buttons show `.icon` glyphs in place of
`.label` words (the word stays in `aria-label`), and the header's search box
takes a row of its own. `useChrome` hides header and toolbar when the note is
scrolled down and shows them on scroll up. Only the panes scroll, so its
listener sits on the pane container in the capture phase. While editing, only
the header hides, since Save and the commit message are in the toolbar. The
hiding animates `max-height`; that cap (10rem) has to stay above the toolbar's
real height, which is up to three rows.

**Log** (`App.vue`). The header's Log button opens a modal listing the last 50
commits from `GET /history?max=50`. It is fetched on each open and has no
composable.

**History** (`useHistory.js`). No router: `openFile` pushes `?note=<path>`, `popstate` reopens with
`{history: false}`, and the on-load restore uses `replace: true` so landing on a
note isn't a step you can go Back through. Only notes are history entries:
search results are not, so queries stay out of the URL and Back never triggers
a ripgrep. An open that fails during
`popstate` re-pushes the current note, because the browser has already moved by
then. Query strings are safe for OAuth — `redirectUri()` is origin + pathname.

**Change detection** (`useSync.js`). The REST API has no watch or SSE endpoint, but every write
to the KB is a git commit, so `GET /history?max=1` is a cheap change token for
the whole vault: one request answers "did anything change?" — and it's O(1) in
repo size, since `git log -n1` with no pathspec reads one commit object and
computes no diff (a `?path=` would walk history instead; nothing passes one).

There is deliberately **no timer**: `syncNow` runs on `visibilitychange`/`focus`
and on clicks in the tree and the document pane, throttled by `MIN_SYNC_GAP`, so
an idle tab costs nothing. On a change it calls `refreshTree`
(which re-lists only *expanded* folders and reuses existing node objects, so
expansion state survives) and re-reads the open file. In edit mode it must not
touch the buffer — it sets `staleFile` instead, since the `If-Match` save would
be rejected anyway. `staleFile` opens the conflict dialog (`showConflict`):
*Discard my changes* takes the server version, *Keep editing and overwrite*
adopts the server's current etag as the base, so the next save replaces exactly
that version and is still refused if it moves again. There is no merge. Our own commits call `markSynced` so they don't come back as
external changes. `startEdit` re-reads the open file directly, bypassing the
throttle, so an edit never starts from a stale buffer. Blind spot: a change that
doesn't move HEAD — a file written into the vault without a commit — is invisible
to this.

**Session restore** (`App.vue`). `connect()` reconnects to `kb_editor_last_url` on load when
a token is still held, and reopens `kb_editor_last_file_<kbUrl>` via `revealPath`,
which expands and loads each ancestor folder so the file is highlighted in the
tree. Both restores are silent on failure and never redirect to login on their
own — a stale token would otherwise make every page load a surprise navigation.
The restore runs *after* `connect`'s try/finally for the same reason: a failed
restore is not a failed connect.

**Auth flow** (`auth.js`), all browser-side, no secrets:

1. Discovery: `GET <kb>/.well-known/oauth-protected-resource` (RFC 9728) →
   `GET <issuer>/.well-known/oauth-authorization-server` (RFC 8414).
2. Dynamic client registration (RFC 7591) the first time, `client_id` cached in
   `localStorage` under `va_client_<issuer>`. When the AS's database is reset,
   this cache goes stale and login fails with `invalid_client` — the connect
   screen's *advanced → Delete client_id cache* button (`clearClientCache`) is the
   fix.
3. Code + PKCE. The authorize request sends **both** `resource` and `audience`
   with the same value: volume-auth is built on Ory fosite, which reads the
   audience from `audience`, while the spec (RFC 8707) says `resource`. Keep
   both.
4. Tokens stored per-KB in `localStorage` under `va_token_<kbUrl>`, refreshed
   when within 30s of expiry. The refresh runs under a Web Lock
   (`va_refresh_<kbUrl>`) and re-reads the token inside it: volume-auth rotates
   refresh tokens, and presenting a rotated one is treated as reuse and revokes
   the whole grant — which parallel requests, or two tabs, used to do after
   every expiry. Only a 400/401 from the token endpoint logs out (returning null
   so the caller starts a fresh login); a network error throws and keeps the
   token.

`api.js` throws `AuthError` on 401; `App.connect()` catches it and redirects to
login. Bearer-token mode sends `credentials: 'omit'` deliberately — sending
credentials would force credentialed CORS, which the gateway isn't set up for.
Only same-origin cookie mode (no token) uses `'include'`.

**Saving** (`useDocument.js`) is `PUT /files/<path>?message=…` with `If-Match: <etag>` from the read.
A 412 throws `ConflictError`, which sets `staleFile` rather than clobbering.
Every save is a commit on the KB side, so a commit message is required. Save
with an empty message opens a dialog (`showCommitPrompt`) asking for one, and
`confirmCommit` then saves.

**Drafts** (`lib/drafts.js`, `useDrafts.js`). While editing, the buffer is
mirrored on every change into `localStorage` under
`kb_editor_draft_<kbUrl> <path>` (a space, which no URL contains) as
`{text, baseEtag, commitMsg, cursor, savedAt}`. A buffer equal to the server
text is not a draft, except for a create. So leaving a note never loses edits
and there is no "discard?" prompt on switching: `openFile` finds the draft and
opens in edit mode with cursor and scroll restored, `etag` = `baseEtag`, and
`staleFile` set if the server's etag differs. A draft whose file is gone opens as
a create; `restoreOpenFile` opens a draft path the tree doesn't have, and
`confirmNew` remembers the new path, so an unsaved new file survives a reload.
Drafts are dropped only by a successful save, Cancel (which confirms) and
*Discard my changes*. The tree marks drafted notes with a dot (`draftPaths`,
provided like `listDir`; other tabs' changes arrive via the `storage` event).

**Deleting** is `DELETE /files/<path>?message=…` with `If-Match`, behind a dialog
pre-filled with `Delete <path>`. kbmcp refuses a file with uncommitted changes
(409), so a deletion is always recoverable. A `read` or `remove` that gets 404
throws `NotFoundError`, which is how a note deleted *elsewhere* is told apart
from a failed request: `useSync` hands it to `fileGone`. When viewing, `fileGone`
closes the note, forgets it and clears `?note=` with `replaceState`. When
editing, it turns the buffer into a create (`creating`, etag null), because the
`If-Match` save would 412 against a missing file and the buffer is the user's work.

**Renaming** is `POST /move?from=…&to=…&message=…` with `If-Match`. The dialog
edits the basename only (`renamedPath` keeps folder and extension). kbmcp
rewrites every wiki link whose target the move would change, in the same commit,
so the dialog takes two steps: the first submit is `dry_run=true` and lists
`links`, the second commits. A `watch` on the name drops the preview, because the
rewrites depend on the name. Afterwards `afterMove` refreshes the tree and marks
the commit synced, and the note is reopened at the new path with `replace: true`.
Replace, because Back to the old path would only find it gone. The reopen also
picks up rewrites of the note's own links.

A **new file** is not written until its first save: *New* only opens an empty
buffer at a path (`creating` is true, `etag` null), which keeps a new note to one
commit. The name gets `.md` appended unless its last segment already contains
a dot (`newFullPath` in `useDocument.js`), and kbmcp creates missing folders
with the file. That save goes out with `If-None-Match: *` instead, so losing a race to
the same path fails rather than overwriting — hence the two different 412
messages in `api.js`.

**Rendering** (`lib/markdown.js`). `renderNote` splits leading YAML frontmatter off and renders it as
an indented card (`fmRows`), then `marked` + `DOMPurify.sanitize` for the body.
Anything reaching `v-html` must go through `DOMPurify`.

The frontmatter parse runs under js-yaml's **failsafe schema** — maps, sequences
and strings only — so nothing is guessed to be a date, number or boolean and the
card shows the text the file actually contains. A block that won't parse is
rendered verbatim rather than dropped, matching kbmcp's stance server-side
(`frontmatter.go:1-8`). A blank block short-circuits before parsing, since
js-yaml 5 treats empty input as an error.

`splitFrontmatter`'s regex has two non-obvious requirements: the content group is
optional, so an empty `---`/`---` block is still frontmatter rather than two
horizontal rules; and the newline lives *inside* that group, which keeps the
closing `---` at a line start so a value ending in `---` can't close the block
early. A marker div between card and body anchors the toolbar's Content button.

## Deployment gotcha: CORS

The app is a different origin from the KB, so the **servers it calls** need CORS
headers — not the server hosting these files. The KB gateway must expose `ETag`
(the If-Match save flow depends on it), allow the methods `GET, PUT, POST, DELETE` and the headers `Authorization, Content-Type,
If-Match, If-None-Match, X-Client-Id`, and let unauthenticated `OPTIONS` preflights bypass
forward_auth, or preflight gets redirected to login. volume-auth needs CORS on
`/token`, `/register` and the `.well-known/*` + `jwks.json` fetches (`/authorize`
and `/login` are top-level redirects, not fetches).

## Conventions

- `README.md` documents the same auth/CORS/save behaviour for humans; keep the
  two in sync when any of that changes.
- `BACKLOG.md` holds deliberate not-yet-done work with the reasoning that led
  there. Add an entry when a decision would otherwise have to be re-derived;
  delete it when the work lands. Same convention as kbmcp's.

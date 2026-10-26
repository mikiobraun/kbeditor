# Backlog

Work deliberately not done yet, with the reasoning that led there. An entry earns
its place by recording a decision someone would otherwise have to re-derive —
not by being a to-do.

## Treat the KB's extras as optional

The editor needs more of kbmcp than `/files`: `/search`, `/find`, `/links` and
`/history` each back a feature, and each was a server change before it was an
editor change. Today the editor assumes all of them exist. A KB serving only
`/files` would show a search box that 404s.

The clean fix is not probing endpoints and watching for 404s, but the server
saying what it has — one small capabilities document fetched at connect, with
the UI switching off what isn't there. Cheap to build.

**Why it waits:** capability negotiation earns its keep when there is a second
implementation on either side. There is one server and one client, both in this
family of repos, so the failure it prevents cannot occur without someone
noticing immediately. Build it when a KB that isn't kbmcp — or an editor that
isn't this one — actually exists.

## Move notes between folders

Rename changes only the name. Moving a note to another folder is what's missing.
The server side is mostly there: `POST /move` accepts any destination, rewrites
the links a move would change, and has a dry run to preview them. The open
question is the UI, and how much of it is worth building:

- **A "Move…" dialog** next to Rename with a destination folder picker. It is
  the smallest option and reuses the rename dialog's preview-then-commit flow.
- **A context menu on tree entries** (rename, move, delete where the file is,
  not only for the open note). A first proper tree menu, which other actions
  would then want too.
- **Drag and drop in the tree.** Natural on desktop, poor on touch, and the
  editor is used on the phone, so it can't be the only way.
- **A select-and-move mode in the tree.** Works on touch and suits moving
  several notes at once.

Things that grow the scope, whichever way is chosen:

- **Several notes at once** would need a batch over REST. `POST /move` takes one
  file, and `batch_edits` (which can move several in one commit) is tool-only.
- **Moving a folder** isn't supported by kbmcp at all. `move_file` moves files.
- **The preview** would have to show rewrites for every moved note, and a
  failure for one note (uncommitted changes, name taken) blocks the whole commit.

**Why it waits:** it ranges from a small dialog to a tree interaction model, and
which of those is reasonable needs its own discussion. Deferred on 2026-09-15.

## Take the dev host out of `vite.config.js`

`allowedHosts` and the `hmr` block name `editor.example.com`, the author's
Caddy-fronted dev host. Anyone else running `npm run dev` on localhost gets a
working page, but its hot reload tries to open a websocket to that host.

The fix is to read the public host from an environment variable (a
`.env.local`, which Vite loads; it needs adding to `.gitignore`) and, when it is unset, leave
`allowedHosts` and `hmr` at Vite's defaults.

**Why it waits:** found on 2026-10-12 while preparing the README for
publishing, in a session that was about the README. It has to land before the
repo goes public; until then the README's Development section says to edit the
two places by hand.

## Make it a PWA

Wanted for the look (no address bar) and, later, notifications. Explicitly *not*
wanted for offline: the vault is a remote git repo behind an auth gateway, and
queuing edits to replay as one commit is a lot of moving parts for a case that
rarely comes up.

That framing makes it much smaller than it first appears:

- **No service worker.** Chrome dropped the service-worker requirement for
  installability, and iOS "Add to Home Screen" never had one, so a manifest with
  name, 192/512 icons and `display: standalone` over HTTPS is enough for the
  standalone look. A service worker exists to serve things offline; without that
  goal it is a cache to keep coherent for no benefit.
- **Updates stop being a PWA problem.** With no service worker there is no stale
  cache: serve `index.html` as `no-cache` and the hashed `assets/*` as immutable,
  and a redeploy is picked up on next launch. This is the wrinkle that makes
  people dread PWAs, and it is entirely self-inflicted by the service worker.
- **Notifications will bring one back**, since push is delivered to a service
  worker — but that is the moment to write it, alongside a push server and VAPID
  keys. On iOS, web push requires the app to be installed anyway.

**Three things to settle first, in this order:**

1. **Does login survive standalone?** Sign-in redirects cross-origin to
   `auth.example.com`. A standalone PWA usually hands cross-origin navigation
   to the browser, and on iOS the installed app and Safari keep *separate*
   storage — so a login completing in Safari can leave the installed app logged
   out, with `va_token_*` written to the wrong store. This is the thing most
   likely to sink the whole idea, and it is testable with a manifest and nothing
   else. Answer it before building anything.
2. **There is no static deploy.** `editor.example.com` proxies to the Vite *dev
   server* (`dev.yaml`, port 8072). An app on a home screen wants `dist/` served
   statically — which is also the only place the cache headers above can be set.
3. **Standalone has no back button** on iOS, and navigation here is
   history-based (`?note=`). An in-app Back would be needed, shown only when
   running installed — `display-mode: standalone` matches in both CSS and JS.

Deferred on 2026-09-07: while the app is redeployed several times an hour, the
address bar costs nothing, and question 1 is better answered when the feature is
actually wanted.

## Merge a conflicting edit

When a note changes on the server while you edit it, the conflict dialog offers
two ways out: discard your changes, or keep them and overwrite the server's
version (which stays in history). What's wanted is a three-way merge, like
git's. Yours and theirs are at hand; the base is not. The draft records only
`baseEtag`, and kbmcp's REST interface can't read an old version (`file_at` is
MCP-only). Either the draft keeps the base text too, or kbmcp grows a
`GET /files/<path>?rev=…`.

**Why it waits:** a merge needs a UI for the hunks that don't merge cleanly,
which is the bulk of the work, and a reason to resolve per hunk rather than
per file. Conflicts are rare with one person editing; overwrite-or-discard is
enough until they aren't. Worth revisiting with edit tabs, which make long-lived
drafts — and so conflicts — more common.

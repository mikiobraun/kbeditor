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

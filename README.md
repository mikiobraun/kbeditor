# kb editor

A pure-frontend viewer/editor for a [kbmcp](https://github.com/mikiobraun/kbmcp)
knowledge base: a git-backed folder of markdown notes. It builds to static
files. You give it a KB URL, it signs you in through the gateway in front of
that KB, and talks to the KB's REST interface.

```
[ content search · New · Log                          ]
[ filename search ] │ [ path · view / raw / edit …    ]
[ file tree       ] │ [ rendered markdown             ]
```

## Features

**Viewing**

- Notes render as markdown. YAML frontmatter is shown as a card above the note,
  with values exactly as written in the file. **Frontmatter** and **Content**
  jump between the card and the body.
- **Raw** shows the file verbatim.
- Clicking the path in the toolbar copies it to the clipboard.
- Links to other sites open in a new tab.
- **Log** lists the KB's recent commits.

**Editing**

- Every save is a git commit in the KB, so saving asks for a commit message.
- **New** creates a note at a path you name. `.md` is added if the name has no
  extension, and nothing is written until the first save.
- **Rename** changes the open note's name. Wiki links pointing at it are
  rewritten in the same commit, and you see the list of rewrites before
  confirming.
- **Delete** removes the open note. The deletion is a commit, so it can be
  undone from history.
- Task checkboxes (`- [ ]`) can be ticked in the rendered view. Each tick is a
  commit.
- A save, rename or delete is refused if the note changed on the server since
  you opened it. When you are editing, you choose between discarding your
  changes and keeping them to overwrite the server version.
- Unsaved edits are kept in the browser, per note, until you save or cancel.
  They survive switching notes, reloading and signing in again; a note with
  unsaved edits reopens in the editor where you left off, and is marked with
  a dot in the tree.

**Search**

- The box in the header searches note contents. Results are grouped by file;
  clicking a line opens the note with the term marked.
- The box above the tree searches filenames and replaces the tree with a flat
  list of matches.
- Both match the typed text literally, and both run when you submit.

**Links and navigation**

- `[[wiki links]]` are clickable. A link that doesn't resolve is marked, and
  hovering gives the reason.
- Each opened note is a browser history entry with its own URL
  (`?note=<path>`), so Back works and a URL opens straight into a note.
- A reload returns to the last KB and note.

**Staying in sync**

- Changes made elsewhere are picked up when the tab regains focus and when you
  click in the tree or the note. There is no polling.
- While you are editing, your text is left alone and a banner offers a reload.
- Not detected: files changed in the vault without a commit.

**On a phone**

- The tree becomes a drawer, toolbar buttons become icons, and header and
  toolbar hide while you scroll down into a note.

## What you need

1. **A kbmcp server** in HTTP mode, serving the vault. See the
   [kbmcp README](https://github.com/mikiobraun/kbmcp#readme).
2. **A gateway in front of it** that signs users in with OAuth and forwards
   their requests to kbmcp. The author's is
   [volume-auth](https://github.com/mikiobraun/volume-auth) behind Caddy's
   `forward_auth`; any setup meeting the requirements below works.
3. **A place to serve the built files** (`dist/`) over HTTPS. Any static host
   will do. It doesn't need to share an origin with the KB.

### What the gateway has to provide

For sign-in:

- `GET <kb>/.well-known/oauth-protected-resource` (RFC 9728), reachable without
  a token, naming the authorization server in `authorization_servers`. An
  optional `resource` is used as the token audience; the default is `<kb>/`.
- `GET <issuer>/.well-known/oauth-authorization-server` (RFC 8414) with
  `authorization_endpoint`, `token_endpoint` and `registration_endpoint`.
- Open dynamic client registration (RFC 7591) for a public client:
  `token_endpoint_auth_method: none`, grant types `authorization_code` and
  `refresh_token`, and the app's own URL as redirect URI.
- Authorization code flow with PKCE (`S256`), for the scopes `read write`.
- A token response with `access_token` and `expires_in`. Without a
  `refresh_token` the session ends when the access token expires.

For KB requests:

- Accept `Authorization: Bearer <access token>` and answer `401` when the token
  is missing or invalid. The editor reacts to a `401` by starting sign-in.
- Forward to kbmcp with its shared token and the user and scope headers kbmcp
  expects (see "Behind an auth gateway" in the kbmcp README). Writing needs the
  `write` scope; without it kbmcp answers `403`.
- Send the CORS headers described under
  [Setting up CORS correctly](#setting-up-cors-correctly).

## How auth works

The app is a public OAuth client and holds no secrets. When you connect to a KB
URL it:

1. Discovers the authorization server from the KB:
   `GET <kb>/.well-known/oauth-protected-resource` →
   `GET <issuer>/.well-known/oauth-authorization-server`.
2. Registers itself as a client the first time, and caches the `client_id` per
   issuer in `localStorage`.
3. Runs authorization code + PKCE: it redirects to the authorization endpoint,
   then exchanges the returned code at the token endpoint for an access token
   bound to that KB. The authorize request names the KB in both `resource`
   (RFC 8707) and `audience`, because authorization servers differ in which of
   the two they read.
4. Stores the access and refresh tokens per KB URL in `localStorage`, and
   refreshes the access token shortly before it expires. Only one refresh runs
   at a time, across tabs, because refresh tokens rotate and reusing an old one
   ends the session. A refresh that fails for lack of network keeps the tokens.

All KB requests then carry `Authorization: Bearer <token>`.

> **Note:** the access and refresh tokens are kept in `localStorage`, where a
> cross-site scripting (XSS) attack on the app could read them.

### The connect screen's "advanced" options

Below the URL field, **advanced** opens two more controls:

- **Bearer token**: a token pasted here is sent as-is and the OAuth flow is
  skipped. Use it when the URL you connect to accepts a fixed token, for
  example kbmcp's own shared token behind a plain reverse proxy. kbmcp is
  read-only in that setup unless the proxy adds the scope header.
- **Delete client_id cache**: forgets the client registrations from step 2.
  Use it when the authorization server's database was reset and sign-in fails
  with `invalid_client`. The next connect registers again.

## Setting up CORS correctly

The app usually runs on a different origin from the KB, so the servers it
calls must send CORS headers. The server hosting the app's files needs none.

**The KB gateway**, for `/files`, `/move`, `/search`, `/find`, `/links`,
`/history` and `/.well-known/oauth-protected-resource`:

- allow the app's origin
- allow the methods `GET, PUT, POST, DELETE, OPTIONS`
- allow the request headers
  `Authorization, Content-Type, If-Match, If-None-Match, X-Client-Id`
- expose the response header `ETag`
- answer `OPTIONS` preflights without requiring a token. A preflight carries
  no `Authorization` header, so a gateway that redirects it to login breaks
  every request.

**The authorization server**, for the token endpoint, the registration
endpoint and its `.well-known` metadata. The authorize and login pages are
top-level redirects, not fetches, and need no CORS.

## Development

Vue 3 single-file components built with Vite; marked, DOMPurify and js-yaml for
rendering; vitest for tests.

```sh
npm install
npm run dev       # Vite on http://127.0.0.1:8072
npm run build     # static bundle -> dist/
npm run preview   # serve the built bundle
npm test          # vitest
```

The app needs a secure context (HTTPS or `localhost`) for sign-in.

To develop behind your own TLS reverse proxy, put its host name in a
gitignored `.env.local` as `DEV_PUBLIC_HOST=editor.example.com`. Vite then
accepts that `Host` header and points hot reload at `wss://<host>:443`.
Without it, the dev server is plain localhost.

[CLAUDE.md](CLAUDE.md) describes the code's structure and the reasoning behind
it.

## Status / not yet done

Not yet:

- Moving a note to another folder.
- Backlinks.
- Installing as a PWA.
- Search as you type, cycling between hits, restricting a search to a folder,
  regex search.

[BACKLOG.md](BACKLOG.md) has the reasoning behind the deferred items.

## License

BSD 3-Clause — see [LICENSE](LICENSE).

import { createApp, reactive, ref, computed, inject, provide, onMounted, nextTick } from 'vue';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { load as loadYaml, FAILSAFE_SCHEMA } from 'js-yaml';
import { KbClient, AuthError } from './api.js';
import * as auth from './auth.js';

const LAST_KB = 'kb_editor_last_url';
// The file you were last in, per KB, so a reload puts you back where you were.
const fileKey = (url) => `kb_editor_last_file_${String(url).trim().replace(/\/+$/, '')}`;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// splitFrontmatter separates a leading YAML frontmatter block (--- … ---) from
// the note body, returning the block's text unparsed — what to do with a block
// that won't parse is the renderer's call. Without the split, marked renders the
// closing --- as a setext heading.
function splitFrontmatter(text) {
  // The content group is optional so that an empty block (`---` then `---`)
  // still counts as frontmatter; without that the delimiters reach marked and
  // render as horizontal rules. Requiring the newline *inside* that group keeps
  // the closing `---` at the start of a line, so a value ending in `---`
  // doesn't close the block early.
  const m = /^---\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { raw: null, body: text };
  return { raw: m[1] || '', body: text.slice(m[0].length) };
}

// A frontmatter value is scalar for display purposes when it isn't a map or a
// list. Under the failsafe schema that means it's a string.
function isScalar(v) {
  return v === null || typeof v !== 'object';
}

// inlineValue renders the values that fit on the key's own row: a scalar, or a
// list of scalars joined with commas. Anything with structure returns null and
// gets a block instead.
function inlineValue(v) {
  const text = (x) => (x === null || x === undefined ? '' : String(x));
  if (isScalar(v)) return escapeHtml(text(v));
  if (Array.isArray(v) && v.every(isScalar)) return escapeHtml(v.map(text).join(', '));
  return null;
}

// fmRows renders a parsed frontmatter value as indented key/value rows. A map
// nests one level deeper; a list carrying structure (the vault's `attachments`,
// say) puts each element in its own group, so it stays visible which values
// belong together.
function fmRows(v) {
  if (Array.isArray(v)) {
    return v.map((item) => `<div class="fm-item">${fmRows(item)}</div>`).join('');
  }
  if (isScalar(v)) {
    return `<div class="fm-row"><span class="fm-val">${escapeHtml(v === null ? '' : String(v))}</span></div>`;
  }
  return Object.entries(v)
    .map(([k, val]) => {
      const key = `<span class="fm-key">${escapeHtml(k)}</span>`;
      const inline = inlineValue(val);
      if (inline !== null) return `<div class="fm-row">${key}<span class="fm-val">${inline}</span></div>`;
      return `<div class="fm-row fm-parent">${key}</div><div class="fm-sub">${fmRows(val)}</div>`;
    })
    .join('');
}

// renderFrontmatter turns the raw block into the metadata card. The parse runs
// under YAML's failsafe schema, so every scalar stays the text that was written
// — nothing is guessed to be a date, a number or a boolean, which keeps what you
// see equal to what the file says. A block that won't parse is shown verbatim
// rather than dropped or turned into an error, the same line kbmcp takes.
function renderFrontmatter(raw) {
  // An empty block (`---` immediately followed by `---`) is a note with no
  // metadata, not a broken one. js-yaml rejects empty input as an error, so
  // this has to be settled before parsing.
  if (!raw.trim()) return '';
  let data;
  try {
    data = loadYaml(raw, { schema: FAILSAFE_SCHEMA });
  } catch (e) {
    return `<pre class="frontmatter-raw">${escapeHtml(raw)}</pre>`;
  }
  const rows = data === null || data === undefined ? '' : fmRows(data);
  return rows ? `<div class="frontmatter">${rows}</div>` : '';
}

// renderNote renders a note to sanitized HTML: the frontmatter card (if any),
// then the markdown body.
function renderNote(text) {
  const { raw, body } = splitFrontmatter(text || '');
  const card = raw === null ? '' : renderFrontmatter(raw);
  // A marker between the card and the body gives the toolbar's Content button
  // something to scroll to. A class rather than an id: ids in note content
  // could collide, classes we query for can't.
  const html = card + (card ? '<div class="note-body-start"></div>' : '') + marked.parse(body);
  return DOMPurify.sanitize(html);
}

// Every listing is shown the same way: dot-files hidden, folders before files,
// each group alphabetical. Lives here so the tree, the root list and the
// post-change refresh can't drift apart.
function visibleEntries(entries) {
  return entries
    .filter((e) => !e.name.startsWith('.'))
    .sort((a, b) => (a.is_dir === b.is_dir ? a.name.localeCompare(b.name) : a.is_dir ? -1 : 1));
}

// Turn a REST listing entry into a reactive tree node.
function makeNode(entry) {
  return reactive({
    name: entry.name,
    path: entry.path,
    is_dir: entry.is_dir,
    size: entry.size,
    expanded: false,
    loading: false,
    error: null,
    children: null, // null = not yet loaded
  });
}

// ---- TreeNode: one row in the file tree, recursive for folders ----

const TreeNode = {
  name: 'TreeNode',
  props: { node: Object, selectedPath: String },
  emits: ['select'],
  setup(props, { emit }) {
    const listDir = inject('listDir');

    async function loadChildren(n) {
      n.loading = true;
      n.error = null;
      try {
        n.children = (await listDir(n.path)).map(makeNode);
      } catch (e) {
        n.error = e.message || String(e);
        n.children = [];
      } finally {
        n.loading = false;
      }
    }

    async function onClick() {
      const n = props.node;
      if (!n.is_dir) {
        emit('select', n);
        return;
      }
      n.expanded = !n.expanded;
      if (n.expanded && n.children === null) await loadChildren(n);
    }

    return { onClick };
  },
  template: `
    <li class="node">
      <div class="row"
           :class="{ dir: node.is_dir, active: !node.is_dir && node.path === selectedPath }"
           @click="onClick">
        <span class="twist">{{ node.is_dir ? (node.expanded ? '▾' : '▸') : '' }}</span>
        <span class="icon">{{ node.is_dir ? '📁' : '📄' }}</span>
        <span class="name">{{ node.name }}</span>
      </div>
      <ul v-if="node.is_dir && node.expanded" class="children">
        <li v-if="node.loading" class="muted pad">…</li>
        <li v-else-if="node.error" class="err pad">{{ node.error }}</li>
        <li v-else-if="node.children && node.children.length === 0" class="muted pad">(empty)</li>
        <tree-node
          v-for="c in node.children"
          :key="c.path"
          :node="c"
          :selected-path="selectedPath"
          @select="$emit('select', $event)" />
      </ul>
    </li>
  `,
};

// ---- root app ----

const App = {
  components: { TreeNode },
  setup() {
    const view = ref('connect'); // 'connect' | 'browse'
    const kbUrl = ref(localStorage.getItem(LAST_KB) || '');
    const manualToken = ref('');
    const showAdvanced = ref(false);
    const busy = ref(false);
    const banner = ref(null); // { kind: 'err'|'info', text }
    const treeOpen = ref(false); // mobile drawer state (ignored on desktop via CSS)

    const roots = ref([]);
    const client = ref(null);

    // Lazy directory lister, shared with TreeNode via provide/inject; closes
    // over the current client ref.
    const listDir = async (path) => visibleEntries(await client.value.list(path));
    provide('listDir', listDir);

    const selected = ref(null); // node
    const content = ref('');
    const etag = ref(null);
    const mode = ref('view'); // 'view' | 'raw' | 'edit'
    const editText = ref('');
    const commitMsg = ref('');
    const saving = ref(false);
    const creating = ref(false); // the open buffer is a file that doesn't exist yet
    const staleFile = ref(false); // it changed on the server while we were editing

    const rendered = computed(() => renderNote(content.value));
    // Whether there's a metadata card to jump between. Frontmatter has no
    // meaningful order, so there's no "first few rows worth showing" — the
    // answer to a long block is to skip past it, not to truncate it.
    const hasFrontmatter = computed(() => {
      const { raw } = splitFrontmatter(content.value || '');
      return !!(raw && raw.trim());
    });

    // The rendered pane is its own scroll container, so these scroll it rather
    // than the window.
    const notePane = ref(null);

    function scrollToFrontmatter() {
      if (notePane.value) notePane.value.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function scrollToContent() {
      const marker = notePane.value && notePane.value.querySelector('.note-body-start');
      if (marker) marker.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function setError(e) {
      banner.value = { kind: 'err', text: e.message || String(e) };
    }

    async function loadRoots() {
      roots.value = [];
      roots.value = (await listDir('')).map(makeNode);
    }

    // Re-list the folders that are currently open, reusing the existing node
    // objects for paths that are still there so expansion state survives.
    // Collapsed folders are left alone — they re-list when next expanded.
    async function refreshNodes(current, path) {
      const byPath = new Map(current.map((n) => [n.path, n]));
      const next = (await listDir(path)).map((e) => {
        const old = byPath.get(e.path);
        if (!old || old.is_dir !== e.is_dir) return makeNode(e);
        old.size = e.size;
        return old;
      });
      for (const n of next) {
        if (n.is_dir && n.expanded && n.children) n.children = await refreshNodes(n.children, n.path);
      }
      return next;
    }

    async function refreshTree() {
      roots.value = await refreshNodes(roots.value, '');
    }

    // Walk to a path, expanding and loading each folder on the way, so a
    // restored file is highlighted in the tree instead of being open with
    // nothing selected around it. Null if any segment is gone.
    async function revealPath(path) {
      const segments = String(path).split('/');
      let list = roots.value;
      let node = null;
      for (let i = 0; i < segments.length; i++) {
        const sub = segments.slice(0, i + 1).join('/');
        node = list.find((n) => n.path === sub);
        if (!node) return null;
        if (i === segments.length - 1) break;
        if (!node.is_dir) return null;
        if (node.children === null) node.children = (await listDir(node.path)).map(makeNode);
        node.expanded = true;
        list = node.children;
      }
      return node && !node.is_dir ? node : null;
    }

    // Reopen the file this KB was left in. Silent on failure: a file that was
    // deleted or renamed since is forgotten, not an error to greet you with.
    async function restoreOpenFile(url) {
      const path = localStorage.getItem(fileKey(url));
      if (!path) return;
      try {
        const node = await revealPath(path);
        if (!node) {
          localStorage.removeItem(fileKey(url));
          return;
        }
        await openFile(node);
      } catch (e) {
        /* the tree is still fine; just don't restore */
      }
    }

    function findNode(path, list = roots.value) {
      for (const n of list) {
        if (n.path === path) return n;
        if (n.children) {
          const hit = findNode(path, n.children);
          if (hit) return hit;
        }
      }
      return null;
    }

    // Connect to a KB: build a client, try to list the root, and fall back to a
    // login redirect if we're not authenticated yet.
    //
    // `auto` marks the unattended reconnect on page load, which must never
    // redirect on its own: a stale token would turn every load into a surprise
    // navigation, and a loop if the authorization server refuses. It drops back
    // to the connect card instead.
    async function connect(opts = {}) {
      const auto = opts && opts.auto === true;
      const url = kbUrl.value.trim();
      if (!url) return;
      busy.value = true;
      banner.value = null;
      localStorage.setItem(LAST_KB, url);
      try {
        if (manualToken.value.trim()) auth.setManualToken(url, manualToken.value.trim());
        client.value = KbClient(url, () => auth.getAccessToken(url));
        await loadRoots();
        view.value = 'browse';
        await markSynced();
      } catch (e) {
        const needsLogin = e instanceof AuthError || !auth.hasToken(url);
        if (auto) {
          client.value = null;
          if (needsLogin) {
            auth.logout(url);
            banner.value = { kind: 'err', text: 'Your session has expired — connect again to sign in.' };
          } else {
            setError(e);
          }
        } else if (needsLogin) {
          banner.value = { kind: 'info', text: 'Redirecting you to sign in…' };
          try {
            await auth.beginLogin(url);
            return; // navigating away
          } catch (le) {
            setError(le);
          }
        } else {
          setError(e);
        }
      } finally {
        busy.value = false;
      }
      // After the connect settles, not inside the try: a failed restore is not
      // a failed connect, and must not fall into the login-redirect path.
      if (view.value === 'browse') await restoreOpenFile(url);
    }

    async function openFile(node) {
      if (selected.value && mode.value === 'edit' && editText.value !== content.value) {
        if (!confirm('Discard unsaved edits?')) return;
      }
      busy.value = true;
      banner.value = null;
      try {
        const { text, etag: tag } = await client.value.read(node.path);
        selected.value = node;
        content.value = text;
        etag.value = tag;
        mode.value = 'view';
        creating.value = false;
        staleFile.value = false;
        treeOpen.value = false; // close the drawer after picking a file (mobile)
        localStorage.setItem(fileKey(kbUrl.value), node.path);
      } catch (e) {
        setError(e);
      } finally {
        busy.value = false;
      }
    }

    // Discard what we have and take the server's version of the open file.
    async function reloadFile() {
      if (!selected.value || creating.value) return;
      if (mode.value === 'edit' && editText.value !== content.value &&
          !confirm('Discard your edits and load the server version?')) return;
      try {
        const { text, etag: tag } = await client.value.read(selected.value.path);
        content.value = text;
        editText.value = text;
        etag.value = tag;
        staleFile.value = false;
      } catch (e) {
        setError(e);
      }
    }

    // --- change detection ---------------------------------------------------
    //
    // The REST API has no watch or SSE endpoint, but every write to the KB is a
    // git commit, so the head commit hash is a single cheap change token for the
    // whole vault: one `GET /history?max=1` answers "did anything change?"
    // without re-walking the tree.
    //
    // There is no timer. We check when the tab comes back to the foreground and
    // when you touch the tree or the document — which is when a stale view
    // starts to matter — so an idle tab costs nothing at all.
    //
    // Blind spot: a change that doesn't move HEAD (something written into the
    // vault without a commit) is invisible to this.
    const MIN_SYNC_GAP = 2000; // floor, so a burst of clicks is one request
    let lastHash = null;
    let lastCheck = 0;
    let syncing = false;

    async function headHash() {
      const commits = await client.value.history({ max: 1 });
      return commits.length ? commits[0].hash : null;
    }

    // Record the current head as already seen, so our own commits don't come
    // back as an external change on the next check.
    async function markSynced() {
      try {
        lastHash = await headHash();
        lastCheck = Date.now();
      } catch (e) {
        /* the next check retries */
      }
    }

    async function syncNow() {
      if (!client.value || syncing || document.hidden) return;
      if (Date.now() - lastCheck < MIN_SYNC_GAP) return;
      lastCheck = Date.now();
      syncing = true;
      try {
        const head = await headHash();
        if (head === lastHash) return;
        lastHash = head;
        await refreshTree();
        // Pull the open file's new content in — unless we're editing it, where
        // clobbering the buffer would be worse than a stale one. The If-Match
        // save would fail anyway, so flag it and let the user decide.
        if (selected.value && !creating.value) {
          const { text, etag: tag } = await client.value.read(selected.value.path);
          if (tag !== etag.value) {
            if (mode.value === 'edit') {
              staleFile.value = true;
            } else {
              content.value = text;
              etag.value = tag;
            }
          }
        }
      } catch (e) {
        // A failed check isn't worth a banner; the next one retries.
      } finally {
        syncing = false;
      }
    }

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) syncNow();
    });
    window.addEventListener('focus', syncNow);

    // Take the server's current version before filling the buffer: typing
    // against a stale copy means the If-Match save comes back 412 and you get to
    // reconcile by hand. A direct read, not syncNow — the 2s floor would skip
    // exactly the check that matters here. Nothing you typed can be lost: the
    // buffer is empty of your work until the line below.
    async function startEdit() {
      commitMsg.value = '';
      staleFile.value = false;
      try {
        const { text, etag: tag } = await client.value.read(selected.value.path);
        if (tag !== etag.value) {
          content.value = text;
          etag.value = tag;
          banner.value = { kind: 'info', text: 'Loaded the newer version from the server.' };
        }
      } catch (e) {
        // Network trouble — edit what we have; the If-Match save still guards it.
      }
      editText.value = content.value;
      mode.value = 'edit';
    }

    function cancelEdit() {
      // A new file only exists in the buffer, so cancelling drops it entirely.
      if (creating.value) {
        creating.value = false;
        selected.value = null;
        content.value = '';
        editText.value = '';
        localStorage.removeItem(fileKey(kbUrl.value));
      }
      mode.value = 'view';
    }

    // --- new file -----------------------------------------------------------
    //
    // Nothing is written until the first save: the dialog only opens an empty
    // buffer at a path. That keeps a new note to one commit and lets the save
    // carry a real message, and the create is `If-None-Match: *` so racing
    // someone else to the same path fails instead of overwriting them.
    const showNew = ref(false);
    const newPath = ref('');
    const newError = ref(null);
    const newInput = ref(null);

    // Default to markdown unless the name already carries an extension.
    const newFullPath = computed(() => {
      const raw = newPath.value.trim().replace(/^\/+/, '');
      if (!raw) return '';
      return raw.split('/').pop().includes('.') ? raw : `${raw}.md`;
    });

    async function openNew() {
      // Start in the folder of whatever is open, which is usually where the
      // next note belongs.
      const dir = selected.value ? selected.value.path.split('/').slice(0, -1).join('/') : '';
      newPath.value = dir ? `${dir}/` : '';
      newError.value = null;
      showNew.value = true;
      await nextTick();
      if (newInput.value) newInput.value.focus();
    }

    function confirmNew() {
      const path = newFullPath.value;
      if (!path) {
        newError.value = 'Enter a file name.';
        return;
      }
      if (path.split('/').some((s) => s === '' || s === '.' || s === '..')) {
        newError.value = 'That path has an empty or relative segment.';
        return;
      }
      if (findNode(path)) {
        newError.value = 'A file already exists at that path.';
        return;
      }
      if (mode.value === 'edit' && editText.value !== content.value &&
          !confirm('Discard unsaved edits?')) return;

      showNew.value = false;
      selected.value = { name: path.split('/').pop(), path, is_dir: false };
      content.value = '';
      editText.value = '';
      etag.value = null;
      creating.value = true;
      staleFile.value = false;
      commitMsg.value = `Add ${path}`;
      mode.value = 'edit';
      treeOpen.value = false;
    }

    // Every save is a commit, so it needs a message. Rather than refusing with
    // an error and leaving you to find the toolbar field, ask for it where you
    // already are.
    const showCommitPrompt = ref(false);
    const commitInput = ref(null);

    async function save() {
      if (!commitMsg.value.trim()) {
        showCommitPrompt.value = true;
        await nextTick();
        if (commitInput.value) commitInput.value.focus();
        return;
      }
      await doSave();
    }

    async function confirmCommit() {
      if (!commitMsg.value.trim()) return;
      showCommitPrompt.value = false;
      await doSave();
    }

    async function doSave() {
      saving.value = true;
      banner.value = null;
      const isNew = creating.value;
      try {
        const res = await client.value.write(selected.value.path, editText.value, commitMsg.value.trim(),
          isNew ? { ifNoneMatch: '*' } : { ifMatch: etag.value || undefined });
        content.value = editText.value;
        etag.value = res.etag;
        mode.value = 'view';
        staleFile.value = false;
        banner.value = { kind: 'info', text: isNew ? 'Created and committed.' : 'Saved and committed.' };
        if (isNew) {
          creating.value = false;
          localStorage.setItem(fileKey(kbUrl.value), selected.value.path);
          await refreshTree();
          // Swap the placeholder for the real tree node, when its folder is open.
          const node = findNode(selected.value.path);
          if (node) selected.value = node;
        }
        await markSynced();
      } catch (e) {
        setError(e);
      } finally {
        saving.value = false;
      }
    }

    function disconnect() {
      auth.logout(kbUrl.value.trim());
      lastHash = null;
      view.value = 'connect';
      selected.value = null;
      content.value = '';
      creating.value = false;
      staleFile.value = false;
      client.value = null;
    }

    // --- change log (recent commits) modal ---
    const showLog = ref(false);
    const logEntries = ref([]);
    const logLoading = ref(false);
    const logError = ref(null);

    async function openLog() {
      showLog.value = true;
      logLoading.value = true;
      logError.value = null;
      try {
        logEntries.value = await client.value.history({ max: 50 });
      } catch (e) {
        logError.value = e.message || String(e);
      } finally {
        logLoading.value = false;
      }
    }

    onMounted(async () => {
      // If we're returning from the AS with an auth code, finish the flow and
      // auto-connect to the KB we were signing into.
      try {
        const back = await auth.completeLoginIfReturning();
        if (back && back.kbUrl) {
          kbUrl.value = back.kbUrl;
          await connect();
          return;
        }
      } catch (e) {
        setError(e);
        return;
      }
      // Otherwise go straight back to the KB we were last in, as long as we
      // still hold a token for it. Disconnect drops the token, so it lands on
      // the connect card as before.
      const url = kbUrl.value.trim();
      if (url && auth.hasToken(url)) await connect({ auto: true });
    });

    // Forget cached DCR client registrations so the next connect re-registers
    // (recovers from invalid_client after the gateway's database was reset).
    function forgetClient() {
      const n = auth.clearClientCache();
      banner.value = {
        kind: 'info',
        text: n
          ? `Cleared ${n} cached client registration${n === 1 ? '' : 's'}; you'll re-register on the next connect.`
          : 'No cached client registration to clear.',
      };
    }

    // Expose a lazy directory lister to TreeNode via provide/inject.
    return {
      view, kbUrl, manualToken, showAdvanced, busy, banner, treeOpen, forgetClient,
      roots, selected, content, etag, mode, editText, commitMsg, saving, rendered,
      hasFrontmatter, notePane, scrollToFrontmatter, scrollToContent,
      creating, staleFile, reloadFile, syncNow,
      connect, openFile, startEdit, cancelEdit, save, disconnect,
      showNew, newPath, newError, newInput, newFullPath, openNew, confirmNew,
      showCommitPrompt, commitInput, confirmCommit,
      showLog, logEntries, logLoading, logError, openLog,
    };
  },
  template: `
    <div class="app">
      <!-- connect screen -->
      <div v-if="view === 'connect'" class="connect">
        <div class="card">
          <h1>kb editor</h1>
          <p class="muted">Open a knowledge base by its URL. You'll sign in through its gateway.</p>
          <form @submit.prevent="connect">
            <input v-model="kbUrl" type="url" placeholder="https://kb.example.com" autofocus />
            <button type="submit" :disabled="busy || !kbUrl">{{ busy ? 'Connecting…' : 'Connect' }}</button>
          </form>
          <p class="advanced-toggle" @click="showAdvanced = !showAdvanced">
            {{ showAdvanced ? '▾' : '▸' }} advanced
          </p>
          <div v-if="showAdvanced" class="advanced">
            <label>Bearer token (skip OAuth — for local/same-origin testing)</label>
            <textarea v-model="manualToken" rows="3" placeholder="paste a token to bypass the sign-in flow"></textarea>
            <button type="button" @click="forgetClient">Delete client_id cache</button>
            <p class="muted">Forces a fresh registration on the next connect — use if sign-in fails with “invalid_client” after the gateway was reset.</p>
          </div>
          <div v-if="banner" class="banner" :class="banner.kind">{{ banner.text }}</div>
        </div>
      </div>

      <!-- browser -->
      <div v-else class="browser" :class="{ 'tree-open': treeOpen }">
        <header>
          <button class="ghost menu" @click="treeOpen = !treeOpen" aria-label="Toggle file tree">☰</button>
          <span class="kb">{{ kbUrl }}</span>
          <span class="spacer"></span>
          <button class="ghost" @click="openNew">New</button>
          <button class="ghost" @click="openLog">Log</button>
          <button class="ghost" @click="disconnect">Disconnect</button>
        </header>
        <div class="body">
          <div class="backdrop" @click="treeOpen = false"></div>
          <nav class="tree" @click="syncNow">
            <ul>
              <tree-node
                v-for="n in roots"
                :key="n.path"
                :node="n"
                :selected-path="selected && selected.path"
                @select="openFile" />
            </ul>
          </nav>
          <main class="pane" @click="syncNow">
            <div v-if="banner" class="banner" :class="banner.kind">{{ banner.text }}</div>
            <div v-if="staleFile" class="banner err">
              This file changed on the server while you were editing — saving would be rejected.
              <button class="ghost" @click="reloadFile">Discard my edits and reload</button>
            </div>
            <div v-if="!selected" class="empty muted">Select a file from the tree, or create one with “New”.</div>
            <template v-else>
              <div class="toolbar">
                <span class="path">{{ selected.path }}<span v-if="creating" class="muted"> · new</span></span>
                <span class="spacer"></span>
                <template v-if="mode !== 'edit'">
                  <template v-if="mode === 'view' && hasFrontmatter">
                    <button class="ghost" @click="scrollToFrontmatter">Frontmatter</button>
                    <button class="ghost" @click="scrollToContent">Content</button>
                  </template>
                  <button class="ghost" :class="{ on: mode === 'view' }" @click="mode = 'view'">Rendered</button>
                  <button class="ghost" :class="{ on: mode === 'raw' }" @click="mode = 'raw'">Raw</button>
                  <button @click="startEdit">Edit</button>
                </template>
                <template v-else>
                  <input class="msg" v-model="commitMsg" placeholder="commit message (required)" />
                  <button @click="save" :disabled="saving">{{ saving ? 'Saving…' : (creating ? 'Create' : 'Save') }}</button>
                  <button class="ghost" @click="cancelEdit">Cancel</button>
                </template>
              </div>
              <div v-if="mode === 'view'" class="markdown" ref="notePane" v-html="rendered"></div>
              <pre v-else-if="mode === 'raw'" class="raw">{{ content }}</pre>
              <textarea v-else class="editor" v-model="editText"></textarea>
            </template>
          </main>
        </div>

        <!-- commit-message modal: shown when Save is pressed with none given -->
        <div v-if="showCommitPrompt" class="modal-backdrop" @click.self="showCommitPrompt = false">
          <div class="modal">
            <header class="modal-head">
              <h2>Commit message</h2>
              <button class="ghost" @click="showCommitPrompt = false" aria-label="Close">✕</button>
            </header>
            <div class="modal-body">
              <form class="new-file" @submit.prevent="confirmCommit">
                <input ref="commitInput" v-model="commitMsg" placeholder="what changed?" />
                <p class="muted">Saving <code>{{ selected && selected.path }}</code> commits it to the knowledge base.</p>
                <div class="actions">
                  <button type="submit" :disabled="!commitMsg.trim()">Save</button>
                  <button type="button" class="ghost" @click="showCommitPrompt = false">Cancel</button>
                </div>
              </form>
            </div>
          </div>
        </div>

        <!-- new-file modal -->
        <div v-if="showNew" class="modal-backdrop" @click.self="showNew = false">
          <div class="modal">
            <header class="modal-head">
              <h2>New file</h2>
              <button class="ghost" @click="showNew = false" aria-label="Close">✕</button>
            </header>
            <div class="modal-body">
              <form class="new-file" @submit.prevent="confirmNew">
                <input ref="newInput" v-model="newPath" placeholder="notes/idea.md" />
                <p class="muted">
                  Creates <code>{{ newFullPath || '…' }}</code>; missing folders are created with it.
                  Nothing is written until you save.
                </p>
                <p v-if="newError" class="err">{{ newError }}</p>
                <div class="actions">
                  <button type="submit">Continue</button>
                  <button type="button" class="ghost" @click="showNew = false">Cancel</button>
                </div>
              </form>
            </div>
          </div>
        </div>

        <!-- recent-changes log modal -->
        <div v-if="showLog" class="modal-backdrop" @click.self="showLog = false">
          <div class="modal">
            <header class="modal-head">
              <h2>Recent changes</h2>
              <button class="ghost" @click="showLog = false" aria-label="Close">✕</button>
            </header>
            <div class="modal-body">
              <p v-if="logLoading" class="muted">Loading…</p>
              <p v-else-if="logError" class="err">{{ logError }}</p>
              <p v-else-if="logEntries.length === 0" class="muted">No commits yet.</p>
              <ul v-else class="log">
                <li v-for="c in logEntries" :key="c.hash">
                  <div class="log-subject">{{ c.subject }}</div>
                  <div class="log-meta">{{ c.relative }} · {{ c.author }} · <code>{{ c.hash }}</code></div>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  `,
};

createApp(App).mount('#app');

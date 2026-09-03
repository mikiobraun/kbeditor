import { createApp, reactive, ref, computed, inject, provide, onMounted } from 'vue';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { KbClient, AuthError } from './api.js';
import * as auth from './auth.js';

const LAST_KB = 'kb_editor_last_url';

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// splitFrontmatter pulls a leading YAML frontmatter block (--- … ---) off the
// top of a note and parses its flat `key: value` lines. Emails written into the
// vault carry metadata (from/subject/date) this way; without splitting it out,
// marked renders the closing --- as a setext heading. Only top-level scalar
// fields are parsed — enough for note/email metadata, not full YAML.
function splitFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: null, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s?(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^["'](.*)["']$/, '$1');
  }
  return { meta, body: text.slice(m[0].length) };
}

// renderNote renders a note to sanitized HTML: a metadata table for the
// frontmatter (if any), then the markdown body.
function renderNote(text) {
  const { meta, body } = splitFrontmatter(text || '');
  let html = '';
  if (meta && Object.keys(meta).length) {
    const rows = Object.entries(meta)
      .map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`)
      .join('');
    html += `<table class="frontmatter">${rows}</table>`;
  }
  html += marked.parse(body);
  return DOMPurify.sanitize(html);
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
        const entries = (await listDir(n.path)).filter((e) => !e.name.startsWith('.'));
        // folders first, then files, each alphabetical
        entries.sort((a, b) => (a.is_dir === b.is_dir ? a.name.localeCompare(b.name) : a.is_dir ? -1 : 1));
        n.children = entries.map(makeNode);
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

    // Lazy directory lister for TreeNode; closes over the current client ref.
    provide('listDir', (path) => client.value.list(path));

    const selected = ref(null); // node
    const content = ref('');
    const etag = ref(null);
    const mode = ref('view'); // 'view' | 'raw' | 'edit'
    const editText = ref('');
    const commitMsg = ref('');
    const saving = ref(false);

    const rendered = computed(() => renderNote(content.value));

    function setError(e) {
      banner.value = { kind: 'err', text: e.message || String(e) };
    }

    async function loadRoots() {
      roots.value = [];
      const entries = (await client.value.list('')).filter((e) => !e.name.startsWith('.'));
      entries.sort((a, b) => (a.is_dir === b.is_dir ? a.name.localeCompare(b.name) : a.is_dir ? -1 : 1));
      roots.value = entries.map(makeNode);
    }

    // Connect to a KB: build a client, try to list the root, and fall back to a
    // login redirect if we're not authenticated yet.
    async function connect() {
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
      } catch (e) {
        if (e instanceof AuthError || !auth.hasToken(url)) {
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
        treeOpen.value = false; // close the drawer after picking a file (mobile)
      } catch (e) {
        setError(e);
      } finally {
        busy.value = false;
      }
    }

    function startEdit() {
      editText.value = content.value;
      commitMsg.value = '';
      mode.value = 'edit';
    }

    async function save() {
      if (!commitMsg.value.trim()) {
        banner.value = { kind: 'err', text: 'A commit message is required.' };
        return;
      }
      saving.value = true;
      banner.value = null;
      try {
        const res = await client.value.write(selected.value.path, editText.value, commitMsg.value.trim(), {
          ifMatch: etag.value || undefined,
        });
        content.value = editText.value;
        etag.value = res.etag;
        mode.value = 'view';
        banner.value = { kind: 'info', text: 'Saved and committed.' };
      } catch (e) {
        setError(e);
      } finally {
        saving.value = false;
      }
    }

    function disconnect() {
      auth.logout(kbUrl.value.trim());
      view.value = 'connect';
      selected.value = null;
      content.value = '';
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
        }
      } catch (e) {
        setError(e);
      }
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
      connect, openFile, startEdit, save, disconnect,
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
          <button class="ghost" @click="openLog">Log</button>
          <button class="ghost" @click="disconnect">Disconnect</button>
        </header>
        <div class="body">
          <div class="backdrop" @click="treeOpen = false"></div>
          <nav class="tree">
            <ul>
              <tree-node
                v-for="n in roots"
                :key="n.path"
                :node="n"
                :selected-path="selected && selected.path"
                @select="openFile" />
            </ul>
          </nav>
          <main class="pane">
            <div v-if="banner" class="banner" :class="banner.kind">{{ banner.text }}</div>
            <div v-if="!selected" class="empty muted">Select a file from the tree.</div>
            <template v-else>
              <div class="toolbar">
                <span class="path">{{ selected.path }}</span>
                <span class="spacer"></span>
                <template v-if="mode !== 'edit'">
                  <button class="ghost" :class="{ on: mode === 'view' }" @click="mode = 'view'">Rendered</button>
                  <button class="ghost" :class="{ on: mode === 'raw' }" @click="mode = 'raw'">Raw</button>
                  <button @click="startEdit">Edit</button>
                </template>
                <template v-else>
                  <input class="msg" v-model="commitMsg" placeholder="commit message (required)" />
                  <button @click="save" :disabled="saving">{{ saving ? 'Saving…' : 'Save' }}</button>
                  <button class="ghost" @click="mode = 'view'">Cancel</button>
                </template>
              </div>
              <div v-if="mode === 'view'" class="markdown" v-html="rendered"></div>
              <pre v-else-if="mode === 'raw'" class="raw">{{ content }}</pre>
              <textarea v-else class="editor" v-model="editText"></textarea>
            </template>
          </main>
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

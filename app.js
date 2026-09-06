import { createApp, reactive, ref, computed, inject, provide, onMounted, nextTick, watch } from 'vue';
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

// taskLines returns the note's task-list lines in source order, split so a
// toggle can rewrite just the marker. Fenced code blocks are skipped: marked
// doesn't render a `- [ ]` inside a fence as a checkbox, so counting one here
// would shift every index after it and tick the wrong line.
function taskLines(text) {
  const out = [];
  let fence = null;
  const lines = String(text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = /^\s*(```+|~~~+)/.exec(line);
    if (f) {
      if (fence === null) fence = f[1];
      else if (line.trim().startsWith(fence[0].repeat(fence.length))) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const m = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\]\s?)(.*)$/.exec(line);
    if (m) out.push({ line: i, checked: m[2] !== ' ', open: m[1], close: m[3], text: m[4] });
  }
  return out;
}

// Task text as prose, for a commit message: link labels survive, emphasis and
// code markers don't.
function plainText(md) {
  return String(md)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// One rule for the label, applied whatever the line looks like: the notes use
// em dashes, colons and full stops interchangeably, so there is no boundary
// worth detecting — just take the first 30 characters.
const TASK_LABEL_MAX = 30;
function taskLabel(md) {
  const t = plainText(md);
  return t.length > TASK_LABEL_MAX ? `${t.slice(0, TASK_LABEL_MAX)}…` : t;
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
      // A note named in the URL is an explicit request — a shared link, a
      // reload, a restored tab — so it beats the remembered file.
      const fromUrl = noteFromUrl();
      const path = fromUrl || localStorage.getItem(fileKey(url));
      if (!path) return;
      try {
        const node = await revealPath(path);
        if (!node) {
          if (!fromUrl) localStorage.removeItem(fileKey(url));
          return;
        }
        // Replace rather than push: landing on a note is where the history
        // starts, not a step within it.
        await openFile(node, { replace: true });
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

    // --- browser history ------------------------------------------------------
    //
    // No router: an open note is just `?note=<path>` pushed onto the history
    // stack, so the browser's Back button — and a phone's back gesture — walk
    // the notes you followed, and a URL can be shared. Only notes are entries;
    // search results are not, which keeps the query out of the URL and the
    // ripgrep off the Back button.
    //
    // The query string is safe for the OAuth flow: redirectUri() is built from
    // origin + pathname, and cleanUrl() strips everything else after login.
    const NOTE_PARAM = 'note';

    function noteFromUrl() {
      return new URL(location.href).searchParams.get(NOTE_PARAM) || '';
    }

    function pushNoteUrl(path, replace = false) {
      const url = new URL(location.href);
      url.searchParams.set(NOTE_PARAM, path);
      const how = replace ? 'replaceState' : 'pushState';
      history[how]({ [NOTE_PARAM]: path }, '', url);
    }

    // openFile is the single door onto a note, so history is pushed here rather
    // than at each call site. `history: false` is for openings that are *not*
    // navigations: replaying a popstate, and the restore on load.
    async function openFile(node, opts = {}) {
      if (selected.value && mode.value === 'edit' && editText.value !== content.value) {
        if (!confirm('Discard unsaved edits?')) return false;
      }
      busy.value = true;
      banner.value = null;
      try {
        const { text, etag: tag } = await client.value.read(node.path);
        if (opts.history !== false) pushNoteUrl(node.path, opts.replace === true);
        selected.value = node;
        content.value = text;
        etag.value = tag;
        mode.value = 'view';
        creating.value = false;
        staleFile.value = false;
        highlight.value = ''; // openMatch re-sets it after this returns
        treeOpen.value = false; // close the drawer after picking a file (mobile)
        localStorage.setItem(fileKey(kbUrl.value), node.path);
        return true;
      } catch (e) {
        setError(e);
        return false;
      } finally {
        busy.value = false;
      }
    }

    // Open the note a history entry names. popstate fires *after* the browser
    // has moved, so a refused "discard edits?" leaves the URL ahead of the app —
    // push the note we're still on back over it rather than let the two lie.
    async function openHistoryNote(path) {
      if (!client.value || !path) return;
      if (selected.value && selected.value.path === path) return;
      const node = (await revealPath(path)) || { name: path.split('/').pop(), path, is_dir: false };
      const opened = await openFile(node, { history: false });
      if (!opened && selected.value) pushNoteUrl(selected.value.path, true);
    }

    window.addEventListener('popstate', (e) => {
      const path = (e.state && e.state[NOTE_PARAM]) || noteFromUrl();
      openHistoryNote(path);
    });

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

    // --- search ---------------------------------------------------------------
    //
    // One search per Enter, not per keystroke: each one spawns a ripgrep over
    // the whole vault, and a debounce still means a full scan for every pause in
    // typing. Live search is worth having later; it isn't free enough to switch
    // on by default.
    const searchTerm = ref('');
    const searchResults = ref(null); // null = the pane is showing a file
    const searching = ref(false);
    const highlight = ref(''); // term to mark in the opened file

    // Match ripgrep's smart case: a pattern with an uppercase letter is
    // case-sensitive, anything else isn't. Marking has to use the same rule as
    // the search did, or we highlight things the server never matched.
    function caseFold(term) {
      const sensitive = /[A-Z]/.test(term);
      return (s) => (sensitive ? s : s.toLowerCase());
    }

    // Split a line into alternating plain and matching parts, so a hit can be
    // marked in the results without ever building HTML out of search results.
    function matchParts(text, term) {
      const s = String(text === null || text === undefined ? '' : text);
      if (!term) return [{ t: s, hit: false }];
      const fold = caseFold(term);
      const hay = fold(s);
      const needle = fold(term);
      const parts = [];
      let i = 0;
      for (;;) {
        const at = hay.indexOf(needle, i);
        if (at === -1) break;
        if (at > i) parts.push({ t: s.slice(i, at), hit: false });
        parts.push({ t: s.slice(at, at + term.length), hit: true });
        i = at + term.length;
      }
      if (i < s.length) parts.push({ t: s.slice(i), hit: false });
      return parts;
    }

    // Matches arrive flat, but they cluster: forty hits under five headings read
    // where forty numbered lines don't.
    function groupMatches(matches) {
      const groups = [];
      const byPath = new Map();
      for (const m of matches) {
        let g = byPath.get(m.path);
        if (!g) {
          g = { path: m.path, lines: [] };
          byPath.set(m.path, g);
          groups.push(g);
        }
        g.lines.push(m);
      }
      return groups;
    }

    async function runSearch() {
      const term = searchTerm.value;
      if (!term.trim()) {
        clearSearch();
        return;
      }
      searching.value = true;
      banner.value = null;
      try {
        const { matches, truncated } = await client.value.search(term);
        searchResults.value = { term, groups: groupMatches(matches), truncated, count: matches.length };
      } catch (e) {
        setError(e);
      } finally {
        searching.value = false;
      }
    }

    // The term stays in the box, so getting back to the results is pressing
    // Search again. Deliberately not on focusing the box: clicking in to type a
    // new search would then take away the note you were reading.
    function clearSearch() {
      searchTerm.value = '';
      searchResults.value = null;
    }

    // Open the file a match belongs to, carrying the term over so it can be
    // marked in the note. revealPath expands the tree on the way, so the file is
    // selected in the tree too rather than opening from nowhere.
    async function openMatch(path) {
      const term = searchResults.value ? searchResults.value.term : '';
      searchResults.value = null;
      const node = (await revealPath(path)) || { name: path.split('/').pop(), path, is_dir: false };
      await openFile(node);
      highlight.value = term;
    }

    // Mark the term in the rendered note. This walks text nodes rather than
    // running a regex over the HTML string, which would happily rewrite tag
    // names and attribute values. Each render replaces the pane's content, so
    // the marks never accumulate.
    function applyHighlight() {
      const pane = notePane.value;
      const term = highlight.value;
      if (!pane || !term) return;
      const fold = caseFold(term);
      const needle = fold(term);
      const walker = document.createTreeWalker(pane, NodeFilter.SHOW_TEXT);
      const targets = [];
      while (walker.nextNode()) {
        const node = walker.currentNode;
        // Never descend into a mark we already made: if this ever ran twice on
        // the same DOM, it would nest marks inside marks.
        if (node.parentNode && node.parentNode.nodeName === 'MARK') continue;
        if (fold(node.nodeValue).includes(needle)) targets.push(node);
      }
      for (const node of targets) {
        const frag = document.createDocumentFragment();
        for (const part of matchParts(node.nodeValue, term)) {
          if (!part.hit) {
            frag.appendChild(document.createTextNode(part.t));
            continue;
          }
          const mark = document.createElement('mark');
          mark.textContent = part.t;
          frag.appendChild(mark);
        }
        node.parentNode.replaceChild(frag, node);
      }
      const first = pane.querySelector('mark');
      if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    // --- filename search ------------------------------------------------------
    //
    // Lives in the tree, because it answers "which file" rather than "where is
    // this text". Results replace the tree with a flat list rather than a
    // filtered tree: a folder shown holding only its matching children reads as
    // a folder that contains only those children.
    const findTerm = ref('');
    const findResults = ref(null); // null = the tree is showing the vault
    const finding = ref(false);

    async function runFind() {
      const term = findTerm.value;
      if (!term.trim()) {
        clearFind();
        return;
      }
      finding.value = true;
      try {
        const { paths, truncated } = await client.value.find(term);
        findResults.value = { term, paths, truncated };
      } catch (e) {
        setError(e);
      } finally {
        finding.value = false;
      }
    }

    function clearFind() {
      findTerm.value = '';
      findResults.value = null;
    }

    // Split a path for display: the filename reads normally, the folder sits
    // behind it in muted text.
    function pathParts(path) {
      const at = path.lastIndexOf('/');
      return at === -1 ? { dir: '', name: path } : { dir: path.slice(0, at), name: path.slice(at + 1) };
    }

    // Open a hit, leaving the results up: finding a file usually means opening
    // a few of them in turn.
    async function openFound(path) {
      const node = (await revealPath(path)) || { name: pathParts(path).name, path, is_dir: false };
      await openFile(node);
    }

    // --- wiki links -----------------------------------------------------------
    //
    // The server owns the grammar — name vs path, sibling-first, ambiguity — so
    // the editor only asks where each link points and never guesses. Resolution
    // depends on the note, not on the occurrence, so the same target twice in a
    // note resolves the same way and a map keyed by target is enough.
    const noteLinks = ref([]);
    const linkMap = computed(() => new Map(noteLinks.value.map((l) => [l.target, l])));

    async function loadLinks() {
      if (!selected.value || creating.value || !client.value) {
        noteLinks.value = [];
        return;
      }
      try {
        noteLinks.value = await client.value.links(selected.value.path);
      } catch (e) {
        noteLinks.value = []; // links stay plain text; not worth a banner
      }
    }

    // Refetch whenever the note's text changes — opening, saving, ticking a box,
    // or a sync pulling someone else's edit in.
    watch(content, loadLinks);

    // The address is everything before an |alias, #heading or ^block, matching
    // what the server reports as the link's target.
    function linkAddress(raw) {
      return raw.split(/[|#^]/)[0].trim();
    }

    function linkDisplay(raw) {
      const bar = raw.indexOf('|');
      return bar === -1 ? raw.trim() : raw.slice(bar + 1).trim();
    }

    // Set a link element's state from the current resolutions. Kept separate
    // from creating it, and driven by data-raw, because the resolutions usually
    // arrive *after* the render they belong to — converting [[...]] consumes the
    // markers, so a second pass has to be able to upgrade existing elements
    // rather than look for text that is no longer there.
    function decorateWikiLink(el, raw) {
      const info = linkMap.value.get(linkAddress(raw));
      el.textContent = linkDisplay(raw);
      el.dataset.raw = raw;
      el.onclick = null;
      el.classList.remove('broken', 'pending');

      if (info && info.resolved) {
        el.title = info.resolved;
        el.onclick = () => openFound(info.resolved);
        return;
      }
      // An empty map means the answer hasn't arrived yet, not that everything is
      // broken: a note with links always comes back with an entry per link.
      if (linkMap.value.size === 0) {
        el.classList.add('pending');
        el.title = '';
        return;
      }
      // A link that doesn't resolve stays visible and says why on hover, rather
      // than looking like a working link or vanishing into plain text.
      el.classList.add('broken');
      const reason = (info && info.reason) || 'no note found for this link';
      const candidates = info && info.candidates && info.candidates.length
        ? `: ${info.candidates.join(', ')}`
        : '';
      el.title = reason + candidates;
    }

    function wikiLinkEl(raw) {
      const el = document.createElement('a');
      el.className = 'wikilink';
      decorateWikiLink(el, raw);
      return el;
    }

    // Replace [[...]] in the rendered note. Text nodes only, and never inside
    // code or an existing link — the same reason the highlighter walks nodes
    // instead of rewriting the HTML string.
    function bindWikiLinks() {
      const pane = notePane.value;
      if (!pane) return;
      const walker = document.createTreeWalker(pane, NodeFilter.SHOW_TEXT);
      const targets = [];
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (node.parentElement && node.parentElement.closest('code, pre, a')) continue;
        if (node.nodeValue.includes('[[')) targets.push(node);
      }
      const re = /\[\[([^[\]]+)\]\]/g;
      for (const node of targets) {
        const text = node.nodeValue;
        const frag = document.createDocumentFragment();
        let i = 0;
        let m;
        re.lastIndex = 0;
        while ((m = re.exec(text)) !== null) {
          if (m.index > i) frag.appendChild(document.createTextNode(text.slice(i, m.index)));
          frag.appendChild(wikiLinkEl(m[1]));
          i = m.index + m[0].length;
        }
        if (i < text.length) frag.appendChild(document.createTextNode(text.slice(i)));
        node.parentNode.replaceChild(frag, node);
      }
      // Refresh the ones already converted, which is how a link created before
      // its resolution arrived becomes clickable.
      pane.querySelectorAll('a.wikilink[data-raw]').forEach((el) => decorateWikiLink(el, el.dataset.raw));
    }

    // --- task checkboxes ------------------------------------------------------
    //
    // marked renders `- [ ]` as a disabled checkbox and DOMPurify keeps it, so
    // ticking one is a matter of enabling it and mapping the click back to the
    // source line it came from — by position, since the render and the source
    // list tasks in the same order.
    const savingTask = ref(false);

    async function toggleTask(i, want, box) {
      if (!selected.value || creating.value || savingTask.value || staleFile.value) {
        if (box) box.checked = !want; // nothing was written
        return;
      }
      const task = taskLines(content.value)[i];
      // The source has to agree with what the rendered box was showing. If it
      // doesn't, the two are out of step and writing would tick a line I can't
      // vouch for — so refuse rather than guess.
      if (!task || task.checked === want) {
        if (box) box.checked = !want;
        setError(new Error('This note no longer matches what is on screen — reload before ticking.'));
        return;
      }

      const lines = content.value.split('\n');
      lines[task.line] = task.open + (want ? 'x' : ' ') + task.close + task.text;
      const next = lines.join('\n');
      const message = `${want ? 'Check' : 'Uncheck'} "${taskLabel(task.text)}"`;

      savingTask.value = true;
      banner.value = null;
      try {
        const res = await client.value.write(selected.value.path, next, message, {
          ifMatch: etag.value || undefined,
        });
        content.value = next;
        etag.value = res.etag;
        banner.value = { kind: 'info', text: `Committed: ${message}` };
        await markSynced();
      } catch (e) {
        if (box) box.checked = !want;
        setError(e);
      } finally {
        savingTask.value = false;
      }
    }

    // Enable the rendered checkboxes and wire them to their source line. Each
    // render replaces the pane's content, so listeners can't accumulate.
    function bindTaskBoxes() {
      const pane = notePane.value;
      if (!pane) return;
      // Only the boxes marked itself emits — `<li><input> text` — so a raw
      // checkbox written as inline HTML in a note can't shift the indices.
      pane.querySelectorAll('li > input[type="checkbox"]:first-child').forEach((box, i) => {
        box.disabled = false;
        box.addEventListener('change', () => toggleTask(i, box.checked, box));
      });
    }

    // Re-decorate whenever the rendered HTML is replaced — including switching
    // back from Raw, which recreates the pane element and drops all of it.
    // noteLinks is a source too: it arrives after the render it belongs to.
    watch([rendered, highlight, mode, noteLinks], async () => {
      await nextTick();
      applyHighlight();
      bindWikiLinks();
      bindTaskBoxes();
    });

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
      searchTerm, searchResults, searching, matchParts,
      runSearch, clearSearch, openMatch,
      findTerm, findResults, finding, runFind, clearFind, pathParts, openFound,
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
          <form class="search" @submit.prevent="runSearch">
            <input v-model="searchTerm" type="search" placeholder="Search the knowledge base…"
                   @search="runSearch" />
            <button class="ghost" type="submit" :disabled="searching">
              {{ searching ? 'Searching…' : 'Search' }}
            </button>
          </form>
          <span class="spacer"></span>
          <button class="ghost" @click="openNew">New</button>
          <button class="ghost" @click="openLog">Log</button>
          <button class="ghost" @click="disconnect">Disconnect</button>
        </header>
        <div class="body">
          <div class="backdrop" @click="treeOpen = false"></div>
          <nav class="tree" @click="syncNow">
            <form class="tree-find" @submit.prevent="runFind">
              <input v-model="findTerm" type="search" placeholder="Find file by name…" @search="runFind" />
              <button class="ghost" type="submit" :disabled="finding">{{ finding ? '…' : 'Find' }}</button>
            </form>

            <div v-if="findResults" class="find-results">
              <div class="find-head">
                <span class="muted">
                  {{ findResults.paths.length }}
                  {{ findResults.paths.length === 1 ? 'file' : 'files' }}
                </span>
                <span class="spacer"></span>
                <button class="ghost" @click="clearFind">Clear</button>
              </div>
              <p v-if="!findResults.paths.length" class="muted pad">No file matches.</p>
              <div v-for="p in findResults.paths" :key="p" class="found"
                   :class="{ active: selected && selected.path === p }"
                   @click="openFound(p)">
                <span class="found-name">{{ pathParts(p).name }}</span>
                <span v-if="pathParts(p).dir" class="found-dir">{{ pathParts(p).dir }}</span>
              </div>
              <p v-if="findResults.truncated" class="muted pad">More matches than shown.</p>
            </div>

            <ul v-else>
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
            <div v-if="searching" class="empty muted">Searching…</div>
            <div v-else-if="searchResults" class="results">
              <div class="results-head">
                <span>
                  <strong>{{ searchResults.count }}</strong>
                  {{ searchResults.count === 1 ? 'match' : 'matches' }} for “{{ searchResults.term }}”
                </span>
                <span class="spacer"></span>
                <button class="ghost" @click="clearSearch">Clear</button>
              </div>
              <p v-if="!searchResults.groups.length" class="empty muted">Nothing found.</p>
              <div v-for="g in searchResults.groups" :key="g.path" class="result-file">
                <div class="result-path">{{ g.path }}</div>
                <div v-for="m in g.lines" :key="m.line" class="result-line" @click="openMatch(g.path)">
                  <span class="result-lineno">{{ m.line }}</span>
                  <span class="result-text"><template
                    v-for="(p, i) in matchParts(m.text, searchResults.term)" :key="i"><mark
                      v-if="p.hit">{{ p.t }}</mark><template v-else>{{ p.t }}</template></template></span>
                </div>
              </div>
              <p v-if="searchResults.truncated" class="muted pad">
                Stopped at {{ searchResults.count }} matches — there are more.
              </p>
            </div>
            <div v-else-if="!selected" class="empty muted">Select a file from the tree, or create one with “New”.</div>
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

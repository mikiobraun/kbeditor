<template>
    <div class="app">
      <connect-screen
        v-if="view === 'connect'"
        :initial-url="kbUrl"
        :busy="busy"
        :banner="banner"
        @connect="connect"
        @forget-client="forgetClient" />

      <!-- browser -->
      <div v-else class="browser"
           :class="{ 'tree-open': treeOpen, 'chrome-hidden': chromeHidden, editing: mode === 'edit' }">
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

            <find-results
              v-if="findResults"
              :results="findResults"
              :selected-path="selected ? selected.path : ''"
              @open="openFound"
              @clear="clearFind" />

            <ul v-else>
              <tree-node
                v-for="n in roots"
                :key="n.path"
                :node="n"
                :selected-path="selected && selected.path"
                @select="openFile" />
            </ul>
          </nav>
          <main class="pane" ref="paneEl" @click="syncNow" @scroll.capture="onPaneScroll">
            <div v-if="banner" class="banner" :class="banner.kind">{{ banner.text }}</div>
            <div v-if="staleFile" class="banner err">
              This file changed on the server while you were editing — saving would be rejected.
              <button class="ghost" @click="reloadFile">Discard my edits and reload</button>
            </div>
            <div v-if="searching" class="empty muted">Searching…</div>
            <search-results
              v-else-if="searchResults"
              :results="searchResults"
              @open="openMatch"
              @clear="clearSearch" />
            <div v-else-if="!selected" class="empty muted">Select a file from the tree, or create one with “New”.</div>
            <template v-else>
              <div class="toolbar">
                <span class="path"><span
                  v-if="pathParts(selected.path).dir"
                  class="path-dir">{{ pathParts(selected.path).dir }}/</span><span
                  class="path-name">{{ pathParts(selected.path).name }}</span><span
                  v-if="creating" class="muted">&nbsp;· new</span></span>
                <span class="spacer"></span>
                <template v-if="mode !== 'edit'">
                  <template v-if="mode === 'view' && hasFrontmatter">
                    <button class="ghost" @click="scrollToFrontmatter" title="Frontmatter" aria-label="Jump to frontmatter">
                      <span class="icon" aria-hidden="true">↑</span><span class="label">Frontmatter</span>
                    </button>
                    <button class="ghost" @click="scrollToContent" title="Content" aria-label="Jump to content">
                      <span class="icon" aria-hidden="true">↓</span><span class="label">Content</span>
                    </button>
                  </template>
                  <button class="ghost" :class="{ on: mode === 'view' }" @click="mode = 'view'"
                          title="Rendered" aria-label="Rendered">
                    <span class="icon" aria-hidden="true">👁</span><span class="label">Rendered</span>
                  </button>
                  <button class="ghost" :class="{ on: mode === 'raw' }" @click="mode = 'raw'"
                          title="Raw" aria-label="Raw">
                    <span class="icon" aria-hidden="true">&lt;/&gt;</span><span class="label">Raw</span>
                  </button>
                  <button @click="startEdit" title="Edit" aria-label="Edit">
                    <span class="icon" aria-hidden="true">✏️</span><span class="label">Edit</span>
                  </button>
                  <button class="ghost" @click="askRename" title="Rename" aria-label="Rename">
                    <span class="icon" aria-hidden="true">✎</span><span class="label">Rename</span>
                  </button>
                  <button class="ghost" @click="askDelete" title="Delete" aria-label="Delete">
                    <span class="icon" aria-hidden="true">🗑</span><span class="label">Delete</span>
                  </button>
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

        <!-- Shown when Save is pressed with no message given. -->
        <modal-dialog v-if="showCommitPrompt" title="Commit message" @close="showCommitPrompt = false">
          <form class="new-file" @submit.prevent="confirmCommit">
            <input ref="commitInput" v-model="commitMsg" placeholder="what changed?" />
            <p class="muted">Saving <code>{{ selected && selected.path }}</code> commits it to the knowledge base.</p>
            <div class="actions">
              <button type="submit" :disabled="!commitMsg.trim()">Save</button>
              <button type="button" class="ghost" @click="showCommitPrompt = false">Cancel</button>
            </div>
          </form>
        </modal-dialog>

        <modal-dialog v-if="showDelete" title="Delete file" @close="showDelete = false">
          <form class="new-file" @submit.prevent="confirmDelete">
            <input ref="deleteInput" v-model="deleteMsg" placeholder="commit message" />
            <p class="muted">
              Deletes <code>{{ selected && selected.path }}</code> and commits the removal;
              it stays recoverable from history.
            </p>
            <div class="actions">
              <button type="submit" :disabled="deleting || !deleteMsg.trim()">
                {{ deleting ? 'Deleting…' : 'Delete' }}
              </button>
              <button type="button" class="ghost" @click="showDelete = false">Cancel</button>
            </div>
          </form>
        </modal-dialog>

        <modal-dialog v-if="showRename" title="Rename file" @close="showRename = false">
          <form class="new-file" @submit.prevent="submitRename">
            <div class="rename-name">
              <span v-if="pathParts(selected.path).dir" class="muted">{{ pathParts(selected.path).dir }}/</span>
              <input ref="renameInput" v-model="renameStem" aria-label="New name" />
              <span class="muted">{{ splitExt(pathParts(selected.path).name).ext }}</span>
            </div>
            <p v-if="renameError" class="err">{{ renameError }}</p>
            <template v-if="renamePlan">
              <p v-if="renamePlan.links.length === 0" class="muted">
                No wiki link needs rewriting; only the file is renamed.
              </p>
              <template v-else>
                <p class="muted">
                  Also rewrites {{ renamePlan.links.length }}
                  link{{ renamePlan.links.length === 1 ? '' : 's' }} so
                  {{ renamePlan.links.length === 1 ? 'it keeps its' : 'they keep their' }} target:
                </p>
                <ul class="rewrites">
                  <li v-for="l in renamePlan.links" :key="`${l.path}:${l.line}:${l.old}`">
                    <div class="muted"><code>{{ l.path }}:{{ l.line }}</code></div>
                    <code>{{ l.old }}</code> → <code>{{ l.new }}</code>
                  </li>
                </ul>
              </template>
              <input v-model="renameMsg" placeholder="commit message" aria-label="Commit message" />
            </template>
            <p v-else class="muted">
              Renames <code>{{ selected.path }}</code> to <code>{{ renameTarget }}</code>. Wiki links
              that would stop reaching their note are rewritten in the same commit — you’ll see
              which before anything changes.
            </p>
            <div class="actions">
              <button type="submit" :disabled="renaming || (renamePlan && !renameMsg.trim())">
                {{ renaming ? (renamePlan ? 'Renaming…' : 'Checking…') : (renamePlan ? 'Rename' : 'Preview') }}
              </button>
              <button type="button" class="ghost" @click="showRename = false">Cancel</button>
            </div>
          </form>
        </modal-dialog>

        <modal-dialog v-if="showNew" title="New file" @close="showNew = false">
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
        </modal-dialog>

        <modal-dialog v-if="showLog" title="Recent changes" @close="showLog = false">
          <p v-if="logLoading" class="muted">Loading…</p>
          <p v-else-if="logError" class="err">{{ logError }}</p>
          <p v-else-if="logEntries.length === 0" class="muted">No commits yet.</p>
          <ul v-else class="log">
            <li v-for="c in logEntries" :key="c.hash">
              <div class="log-subject">{{ c.subject }}</div>
              <div class="log-meta">{{ c.relative }} · {{ c.author }} · <code>{{ c.hash }}</code></div>
            </li>
          </ul>
        </modal-dialog>
      </div>
    </div>
</template>

<script>
import { ref, computed, onMounted } from 'vue';
import { KbClient, AuthError } from '../api.js';
import * as auth from '../auth.js';
import TreeNode from './TreeNode.vue';
import ConnectScreen from './ConnectScreen.vue';
import ModalDialog from './ModalDialog.vue';
import SearchResults from './SearchResults.vue';
import FindResults from './FindResults.vue';
import { renderNote, splitFrontmatter } from '../lib/markdown.js';
import { pathParts, splitExt } from '../lib/text.js';
import { useTree } from '../composables/useTree.js';
import { useDocument } from '../composables/useDocument.js';
import { useChrome } from '../composables/useChrome.js';
import { useFind } from '../composables/useFind.js';
import { useSearch } from '../composables/useSearch.js';
import { useSync } from '../composables/useSync.js';
import { useDecorations } from '../composables/useDecorations.js';
import { useHistory } from '../composables/useHistory.js';

const LAST_KB = 'kb_editor_last_url';
// The file you were last in, per KB, so a reload puts you back where you were.
const fileKey = (url) => `kb_editor_last_file_${String(url).trim().replace(/\/+$/, '')}`;

export default {
  components: { TreeNode, ConnectScreen, ModalDialog, SearchResults, FindResults },
  setup() {
    const view = ref('connect'); // 'connect' | 'browse'
    const kbUrl = ref(localStorage.getItem(LAST_KB) || '');
    const busy = ref(false);
    const banner = ref(null); // { kind: 'err'|'info', text }
    const treeOpen = ref(false); // mobile drawer state (ignored on desktop via CSS)

    const client = ref(null);

    // The file tree and how to walk it; see composables/useTree.js.
    const { roots, loadRoots, refreshTree, revealPath, findNode } = useTree({ client });

    // The open note and everything that changes it; see useDocument.js. The
    // callbacks are where this component decides what "a note was opened" or "a
    // file was created" mean for the rest of the app.
    const {
      selected, content, etag, mode, editText, commitMsg, saving, creating, staleFile,
      rendered, hasFrontmatter,
      openFile, reloadFile, startEdit, cancelEdit, close: closeDocument, fileGone,
      showNew, newPath, newError, newInput, newFullPath, openNew, confirmNew: confirmNewFile,
      showCommitPrompt, commitInput, save, confirmCommit,
      showDelete, deleteMsg, deleting, deleteInput, askDelete, confirmDelete,
      showRename, renameStem, renameMsg, renamePlan, renameError, renaming, renameInput, renameTarget,
      askRename, submitRename,
    } = useDocument({
      client,
      onError: (e) => setError(e),
      setBanner: (b) => { banner.value = b; },
      pushNoteUrl: (path, replace) => pushNoteUrl(path, replace),
      clearNoteUrl: () => clearNoteUrl(),
      onOpened: () => {
        resetChrome(); // a new note starts with the chrome shown
        treeOpen.value = false; // close the drawer after picking a file (mobile)
        highlight.value = ''; // openMatch re-sets it after openFile returns
      },
      remember: (path) => localStorage.setItem(fileKey(kbUrl.value), path),
      forget: () => localStorage.removeItem(fileKey(kbUrl.value)),
      afterCreate: async (path) => {
        await refreshTree();
        return findNode(path);
      },
      afterDelete: async () => {
        await refreshTree();
        await markSynced();
      },
      afterMove: async (path) => {
        await refreshTree();
        await markSynced();
        return revealPath(path);
      },
      markSynced: () => markSynced(),
    });

    // confirmNew asks the tree whether a path is taken; the document has no
    // view of the vault.
    const confirmNew = () => confirmNewFile((path) => !!findNode(path));

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

    // Connect to a KB: build a client, try to list the root, and fall back to a
    // login redirect if we're not authenticated yet.
    //
    // `auto` marks the unattended reconnect on page load, which must never
    // redirect on its own: a stale token would turn every load into a surprise
    // navigation, and a loop if the authorization server refuses. It drops back
    // to the connect card instead.
    // Called two ways: from ConnectScreen with what you typed, and by the
    // unattended reconnect on load with `{ auto: true }`.
    async function connect(opts = {}) {
      const auto = opts.auto === true;
      const url = (opts.url || kbUrl.value).trim();
      if (!url) return;
      kbUrl.value = url;
      busy.value = true;
      banner.value = null;
      localStorage.setItem(LAST_KB, url);
      try {
        if (opts.token) auth.setManualToken(url, opts.token);
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

    // `?note=<path>` on the history stack; see composables/useHistory.js.
    const { noteFromUrl, pushNoteUrl, clearNoteUrl } = useHistory({
      openPath: (path, opts) => openPath(path, opts),
      currentPath: () => (selected.value ? selected.value.path : ''),
      isReady: () => !!client.value,
    });

    // openFile is the single door onto a note, so history is pushed here rather
    // than at each call site. `history: false` is for openings that are *not*
    // navigations: replaying a popstate, and the restore on load.
    // Open a note by path, from wherever: a search hit, a find hit, a wiki link,
    // a history entry. revealPath expands the tree on the way so the file is
    // selected there rather than opening from nowhere; when it isn't in the tree
    // (a folder that failed to list, say) a bare node still opens it.
    async function openPath(path, opts) {
      const node = (await revealPath(path)) || { name: pathParts(path).name, path, is_dir: false };
      return openFile(node, opts);
    }

    // Content search across the vault; see composables/useSearch.js.
    const {
      searchTerm, searchResults, searching, highlight,
      runSearch, clearSearch, openMatch, applyHighlight,
    } = useSearch({ client, openPath, onError: setError, onBusy: () => { banner.value = null; } });

    // Filename search, above the tree; see composables/useFind.js.
    const { findTerm, findResults, finding, runFind, clearFind, openFound } = useFind({
      client, openPath, onError: setError,
    });

    // Header and toolbar retreat on scroll-down; see composables/useChrome.js.
    const { chromeHidden, paneEl, onPaneScroll, reset: resetChrome } = useChrome(mode);

    // Everything that happens to the rendered note once it is in the DOM —
    // search marks, wiki links, checkboxes; see composables/useDecorations.js.
    const { watchRender } = useDecorations({
      client,
      doc: { selected, content, etag, mode, creating, staleFile },
      notePane,
      rendered,
      highlight,
      applyHighlight,
      openPath,
      onError: setError,
      setBanner: (b) => { banner.value = b; },
    });

    // Noticing changes made elsewhere; see composables/useSync.js.
    const { syncNow, markSynced, forget: forgetSync } = useSync({
      client,
      refreshTree,
      doc: { selected, content, etag, mode, creating, staleFile },
      onGone: () => fileGone(),
    });

    // Wired after useSync, because a checkbox commit marks the vault as seen.
    watchRender(markSynced);

    function disconnect() {
      auth.logout(kbUrl.value.trim());
      forgetSync();
      view.value = 'connect';
      closeDocument();
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

    // What the template binds to. The logic itself lives in composables/ —
    // this component is the wiring between them and the markup.
    return {
      view, kbUrl, busy, banner, treeOpen, forgetClient,
      roots, selected, content, etag, mode, editText, commitMsg, saving, rendered,
      hasFrontmatter, notePane, scrollToFrontmatter, scrollToContent,
      searchTerm, searchResults, searching,
      runSearch, clearSearch, openMatch,
      findTerm, findResults, finding, runFind, clearFind, pathParts, openFound,
      creating, staleFile, reloadFile, syncNow,
      chromeHidden, paneEl, onPaneScroll,
      connect, openFile, startEdit, cancelEdit, save, disconnect,
      showNew, newPath, newError, newInput, newFullPath, openNew, confirmNew,
      showCommitPrompt, commitInput, confirmCommit,
      showDelete, deleteMsg, deleting, deleteInput, askDelete, confirmDelete,
      showRename, renameStem, renameMsg, renamePlan, renameError, renaming, renameInput, renameTarget,
      askRename, submitRename, splitExt,
      showLog, logEntries, logLoading, logError, openLog,
    };
  },
};
</script>

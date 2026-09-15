import { ref, computed, nextTick } from 'vue';
import { renderNote, splitFrontmatter } from '../lib/markdown.js';
import { NotFoundError } from '../api.js';

// The open note: its text, which mode you are looking at it in, and every way it
// changes — opening, editing, saving, creating, deleting.
//
// This is the app's centre, which is why it takes so many collaborators. They
// are passed in rather than imported so the dependencies point one way: the
// document knows nothing about the tree, history, or syncing, it just says when
// something happened and lets the caller decide what that means.
export function useDocument({
  client,
  onError,
  setBanner,
  pushNoteUrl,
  clearNoteUrl,
  onOpened,          // a note was opened: reset scroll chrome, close the drawer
  remember,          // persist "the file you were last in", per KB
  forget,
  afterCreate,       // refresh the tree and hand back the real node, if any
  afterDelete,       // refresh the tree and mark our commit as seen
  markSynced,
}) {
  const selected = ref(null); // node
  const content = ref('');
  const etag = ref(null);
  const mode = ref('view'); // 'view' | 'raw' | 'edit'
  const editText = ref('');
  const commitMsg = ref('');
  const saving = ref(false);
  const creating = ref(false); // the open buffer is a file that doesn't exist yet
  const staleFile = ref(false); // it changed on the server while we were editing
  const busy = ref(false);

  const rendered = computed(() => renderNote(content.value));

  // Whether there's a metadata card to jump between. Frontmatter has no
  // meaningful order, so there's no "first few rows worth showing" — the answer
  // to a long block is to skip past it, not to truncate it.
  const hasFrontmatter = computed(() => {
    const { raw } = splitFrontmatter(content.value || '');
    return !!(raw && raw.trim());
  });

  // openFile is the single door onto a note, so history is pushed here rather
  // than at each call site. `history: false` is for openings that are *not*
  // navigations: replaying a popstate, and the restore on load.
  async function openFile(node, opts = {}) {
    if (selected.value && mode.value === 'edit' && editText.value !== content.value) {
      if (!confirm('Discard unsaved edits?')) return false;
    }
    busy.value = true;
    setBanner(null);
    try {
      const { text, etag: tag } = await client.value.read(node.path);
      if (opts.history !== false) pushNoteUrl(node.path, opts.replace === true);
      selected.value = node;
      content.value = text;
      etag.value = tag;
      mode.value = 'view';
      creating.value = false;
      staleFile.value = false;
      onOpened(node);
      remember(node.path);
      return true;
    } catch (e) {
      onError(e);
      return false;
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
      if (e instanceof NotFoundError) {
        // You already chose to discard the edits, so there is nothing to keep.
        mode.value = 'view';
        fileGone();
      } else {
        onError(e);
      }
    }
  }

  // Take the server's current version before filling the buffer: typing against
  // a stale copy means the If-Match save comes back 412 and you get to reconcile
  // by hand. A direct read, not syncNow — the floor there would skip exactly the
  // check that matters here. Nothing you typed can be lost: the buffer is empty
  // of your work until the line below.
  async function startEdit() {
    commitMsg.value = '';
    staleFile.value = false;
    try {
      const { text, etag: tag } = await client.value.read(selected.value.path);
      if (tag !== etag.value) {
        content.value = text;
        etag.value = tag;
        setBanner({ kind: 'info', text: 'Loaded the newer version from the server.' });
      }
    } catch (e) {
      if (e instanceof NotFoundError) {
        fileGone();
        return;
      }
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
      forget();
    }
    mode.value = 'view';
  }

  // --- new file ---
  //
  // Nothing is written until the first save: the dialog only opens an empty
  // buffer at a path. That keeps a new note to one commit and lets the save
  // carry a real message, and the create is `If-None-Match: *` so racing someone
  // else to the same path fails instead of overwriting them.
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
    // Start in the folder of whatever is open, which is usually where the next
    // note belongs.
    const dir = selected.value ? selected.value.path.split('/').slice(0, -1).join('/') : '';
    newPath.value = dir ? `${dir}/` : '';
    newError.value = null;
    showNew.value = true;
    await nextTick();
    if (newInput.value) newInput.value.focus();
  }

  // `exists` asks the caller whether a path is already in the tree — the
  // document has no view of the vault.
  function confirmNew(exists) {
    const path = newFullPath.value;
    if (!path) {
      newError.value = 'Enter a file name.';
      return;
    }
    if (path.split('/').some((s) => s === '' || s === '.' || s === '..')) {
      newError.value = 'That path has an empty or relative segment.';
      return;
    }
    if (exists(path)) {
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
    onOpened(selected.value);
  }

  // --- saving ---
  //
  // Every save is a commit, so it needs a message. Rather than refusing with an
  // error and leaving you to find the toolbar field, ask for it where you are.
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
    setBanner(null);
    const isNew = creating.value;
    try {
      const res = await client.value.write(selected.value.path, editText.value, commitMsg.value.trim(),
        isNew ? { ifNoneMatch: '*' } : { ifMatch: etag.value || undefined });
      content.value = editText.value;
      etag.value = res.etag;
      mode.value = 'view';
      staleFile.value = false;
      setBanner({ kind: 'info', text: isNew ? 'Created and committed.' : 'Saved and committed.' });
      if (isNew) {
        creating.value = false;
        remember(selected.value.path);
        // Swap the placeholder for the real tree node, when its folder is open.
        const node = await afterCreate(selected.value.path);
        if (node) selected.value = node;
      }
      await markSynced();
    } catch (e) {
      onError(e);
    } finally {
      saving.value = false;
    }
  }

  // --- deleting ---
  //
  // A deletion is a commit too, so it asks for a message the way a save does,
  // pre-filled since "Delete <path>" is nearly always what it says. It carries
  // If-Match, so a note rewritten since you opened it is refused, not removed.
  const showDelete = ref(false);
  const deleteMsg = ref('');
  const deleting = ref(false);
  const deleteInput = ref(null);

  async function askDelete() {
    if (!selected.value || creating.value) return;
    deleteMsg.value = `Delete ${selected.value.path}`;
    showDelete.value = true;
    await nextTick();
    if (deleteInput.value) deleteInput.value.focus();
  }

  async function confirmDelete() {
    if (!deleteMsg.value.trim()) return;
    const path = selected.value.path;
    deleting.value = true;
    setBanner(null);
    try {
      await client.value.remove(path, deleteMsg.value.trim(), { ifMatch: etag.value || undefined });
      showDelete.value = false;
      dropNote();
      setBanner({ kind: 'info', text: `Deleted ${path}.` });
      await afterDelete();
    } catch (e) {
      showDelete.value = false;
      if (e instanceof NotFoundError) fileGone();
      else onError(e);
    } finally {
      deleting.value = false;
    }
  }

  // The open note was deleted by someone else — noticed by a sync, or by a read
  // that came back 404. Viewing, there is nothing left to show. Editing, the
  // buffer is your work, so it is kept and becomes a new file: saving creates
  // the note again (with If-None-Match, as any create), Cancel lets it go.
  function fileGone() {
    if (!selected.value) return;
    const path = selected.value.path;
    if (mode.value === 'edit') {
      creating.value = true;
      etag.value = null;
      staleFile.value = false;
      setBanner({ kind: 'err', text: `${path} doesn't exist anymore — saving will create it again.` });
      return;
    }
    dropNote();
    setBanner({ kind: 'err', text: `${path} doesn't exist anymore.` });
  }

  // Nothing open, and nothing remembered that points at a note that isn't there.
  function dropNote() {
    close();
    mode.value = 'view';
    forget();
    clearNoteUrl();
  }

  // Leaving a knowledge base: nothing about the previous note should survive
  // into the next one.
  function close() {
    selected.value = null;
    content.value = '';
    editText.value = '';
    etag.value = null;
    creating.value = false;
    staleFile.value = false;
  }

  return {
    selected, content, etag, mode, editText, commitMsg, saving, creating, staleFile, busy,
    rendered, hasFrontmatter,
    openFile, reloadFile, startEdit, cancelEdit, close, fileGone,
    showNew, newPath, newError, newInput, newFullPath, openNew, confirmNew,
    showCommitPrompt, commitInput, save, confirmCommit,
    showDelete, deleteMsg, deleting, deleteInput, askDelete, confirmDelete,
  };
}

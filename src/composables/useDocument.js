import { ref, computed, nextTick, watch } from 'vue';
import { renderNote, splitFrontmatter } from '../lib/markdown.js';
import { pathParts, splitExt, renamedPath } from '../lib/text.js';
import { NotFoundError, ConflictError } from '../api.js';

// The open note: its text, which mode you are looking at it in, and every way it
// changes — opening, editing, saving, creating, renaming, deleting.
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
  afterMove,         // the same, then hand back the tree node at the new path, if any
  markSynced,
  drafts,            // unsaved edits per note: load(path), store(path, draft), drop(path)
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
  const editorEl = ref(null); // the textarea
  const cursor = ref(null); // { start, end, scrollTop } of the textarea

  const rendered = computed(() => renderNote(content.value));

  // Whether there's a metadata card to jump between. Frontmatter has no
  // meaningful order, so there's no "first few rows worth showing" — the answer
  // to a long block is to skip past it, not to truncate it.
  const hasFrontmatter = computed(() => {
    const { raw } = splitFrontmatter(content.value || '');
    return !!(raw && raw.trim());
  });

  // --- drafts ---
  //
  // While editing, the buffer is mirrored into a draft on every change, so
  // leaving a note — another note, a reload, a closed tab, a sign-in redirect —
  // loses nothing, and needs no "discard?" prompt. A buffer that matches the
  // server is not a draft. Only Cancel, discarding on a conflict, and a
  // successful save drop one.
  function persistDraft() {
    if (mode.value !== 'edit' || !selected.value) return;
    const path = selected.value.path;
    if (!creating.value && editText.value === content.value) {
      drafts.drop(path);
      return;
    }
    drafts.store(path, {
      text: editText.value,
      baseEtag: etag.value,
      commitMsg: commitMsg.value,
      cursor: cursor.value,
      savedAt: Date.now(),
    });
  }

  watch([editText, commitMsg, cursor, etag, creating], persistDraft);

  // Bound to the textarea's input, keyup, mouseup and scroll.
  function trackCursor(e) {
    const t = e.target;
    cursor.value = { start: t.selectionStart, end: t.selectionEnd, scrollTop: t.scrollTop };
  }

  async function restoreCursor(c) {
    await nextTick();
    const t = editorEl.value;
    if (!t) return;
    t.focus();
    if (c) {
      t.setSelectionRange(c.start, c.end);
      t.scrollTop = c.scrollTop;
    }
  }

  // openFile is the single door onto a note, so history is pushed here rather
  // than at each call site. `history: false` is for openings that are *not*
  // navigations: replaying a popstate, and the restore on load.
  //
  // A note with a draft opens in edit mode, where you left it. The draft's
  // baseEtag stays the etag, so If-Match still guards the save, and whether the
  // server moved on is decided the same way useSync decides it. A draft whose
  // file is gone opens as a create, the way fileGone turns an open buffer into
  // one.
  async function openFile(node, opts = {}) {
    busy.value = true;
    setBanner(null);
    try {
      const draft = drafts.load(node.path);
      let text = '';
      let tag = null;
      let exists = true;
      try {
        ({ text, etag: tag } = await client.value.read(node.path));
      } catch (e) {
        if (!(draft && e instanceof NotFoundError)) throw e;
        exists = false;
      }
      if (opts.history !== false && exists) pushNoteUrl(node.path, opts.replace === true);
      selected.value = node;
      content.value = text;
      if (draft) {
        etag.value = exists ? draft.baseEtag : null;
        creating.value = !exists;
        staleFile.value = exists && tag !== draft.baseEtag;
        editText.value = draft.text;
        commitMsg.value = draft.commitMsg || '';
        cursor.value = draft.cursor || null;
        mode.value = 'edit';
        // The watch only sees a change; this note may be stale like the last.
        showConflict.value = staleFile.value;
      } else {
        etag.value = tag;
        creating.value = false;
        staleFile.value = false;
        cursor.value = null;
        mode.value = 'view';
      }
      onOpened(node);
      remember(node.path);
      if (draft) restoreCursor(draft.cursor);
      return true;
    } catch (e) {
      onError(e);
      return false;
    } finally {
      busy.value = false;
    }
  }

  // --- conflicts ---
  //
  // The server has a version you haven't seen: noticed by useSync, on reopening
  // a draft, or by a save that came back 412. There is no merge, so it is one of
  // two: drop your edits for the server's version, or keep yours and let the
  // next save replace it. The dialog opens whenever that becomes the case; the
  // banner stays until it's resolved, in case the dialog was closed.
  const showConflict = ref(false);
  watch(staleFile, (stale) => { showConflict.value = stale; });

  async function discardEdits() {
    showConflict.value = false;
    const path = selected.value.path;
    try {
      const { text, etag: tag } = await client.value.read(path);
      drafts.drop(path);
      content.value = text;
      etag.value = tag;
      staleFile.value = false;
      mode.value = 'view';
    } catch (e) {
      if (e instanceof NotFoundError) {
        // You chose to discard the edits, so there is nothing to keep.
        drafts.drop(path);
        mode.value = 'view';
        fileGone();
      } else {
        onError(e);
      }
    }
  }

  // Adopt the server's current version as the base, so the next save
  // overwrites exactly that version — and is still refused if it changes again.
  async function overwriteServer() {
    showConflict.value = false;
    try {
      const { text, etag: tag } = await client.value.read(selected.value.path);
      content.value = text;
      etag.value = tag;
      creating.value = false;
      staleFile.value = false;
    } catch (e) {
      if (e instanceof NotFoundError) {
        content.value = '';
        etag.value = null;
        creating.value = true;
        staleFile.value = false;
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
    cursor.value = null;
    mode.value = 'edit';
  }

  // The one way to throw edits away on purpose, so it asks first.
  function cancelEdit() {
    if ((creating.value || editText.value !== content.value) &&
        !confirm('Discard your edits?')) return;
    drafts.drop(selected.value.path);
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

    showNew.value = false;
    selected.value = { name: path.split('/').pop(), path, is_dir: false };
    content.value = '';
    editText.value = '';
    etag.value = null;
    creating.value = true;
    staleFile.value = false;
    commitMsg.value = `Add ${path}`;
    cursor.value = null;
    mode.value = 'edit';
    onOpened(selected.value);
    // The tree can't lead back to a file that doesn't exist yet, so a reload
    // finds its draft through "the file you were last in".
    remember(path);
    restoreCursor(null);
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
      drafts.drop(selected.value.path);
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
      if (e instanceof ConflictError) staleFile.value = true;
      else onError(e);
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

  // --- renaming ---
  //
  // Only the name changes, never the folder: the dialog edits the name without
  // its extension. The server rewrites every wiki link the rename would
  // otherwise break or send elsewhere, in the same commit, so nothing is renamed
  // before you have seen those rewrites. The first submit is a dry run that
  // lists them; the second renames. Changing the name asks again, since the
  // rewrites depend on it.
  const showRename = ref(false);
  const renameStem = ref('');
  const renameMsg = ref('');
  const renamePlan = ref(null); // the dry run's report for the name as typed
  const renameError = ref(null);
  const renaming = ref(false);
  const renameInput = ref(null);

  const renameTarget = computed(() =>
    selected.value ? renamedPath(selected.value.path, renameStem.value.trim()) : '');

  watch(renameStem, () => {
    renamePlan.value = null;
    renameError.value = null;
  });

  async function askRename() {
    if (!selected.value || creating.value) return;
    renameStem.value = splitExt(pathParts(selected.value.path).name).stem;
    renamePlan.value = null;
    renameError.value = null;
    showRename.value = true;
    await nextTick();
    if (renameInput.value) renameInput.value.select();
  }

  function submitRename() {
    return renamePlan.value ? confirmRename() : previewRename();
  }

  async function previewRename() {
    const stem = renameStem.value.trim();
    const from = selected.value.path;
    const to = renameTarget.value;
    if (!stem) {
      renameError.value = 'Enter a name.';
      return;
    }
    if (stem.includes('/')) {
      renameError.value = 'A name can’t contain “/” — renaming keeps the file in its folder.';
      return;
    }
    if (to === from) {
      renameError.value = 'That is the current name.';
      return;
    }
    renaming.value = true;
    renameError.value = null;
    try {
      const message = `Rename ${from} to ${to}`;
      const plan = await client.value.move(from, to, message, { dryRun: true, ifMatch: etag.value || undefined });
      // The name may have changed while the dry run was out; that answer is for
      // a name no longer in the box.
      if (renameTarget.value !== to) return;
      renamePlan.value = plan;
      renameMsg.value = message;
    } catch (e) {
      if (e instanceof NotFoundError) {
        showRename.value = false;
        fileGone();
      } else {
        renameError.value = e.message || String(e);
      }
    } finally {
      renaming.value = false;
    }
  }

  async function confirmRename() {
    if (!renameMsg.value.trim()) return;
    const from = selected.value.path;
    const to = renameTarget.value;
    renaming.value = true;
    setBanner(null);
    try {
      const res = await client.value.move(from, to, renameMsg.value.trim(), { ifMatch: etag.value || undefined });
      showRename.value = false;
      const node = await afterMove(to);
      // Replace, not push: Back to the old path would only find it gone. The
      // reopen also picks up the note's own links, if the rename rewrote any.
      await openFile(node || { name: pathParts(to).name, path: to, is_dir: false }, { replace: true });
      const notes = new Set(res.links.map((l) => l.path)).size;
      setBanner({
        kind: 'info',
        text: res.links.length
          ? `Renamed to ${pathParts(to).name} and updated ${res.links.length} link${res.links.length === 1 ? '' : 's'} in ${notes} note${notes === 1 ? '' : 's'}.`
          : `Renamed to ${pathParts(to).name}.`,
      });
    } catch (e) {
      if (e instanceof NotFoundError) {
        showRename.value = false;
        fileGone();
      } else {
        renameError.value = e.message || String(e);
      }
    } finally {
      renaming.value = false;
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
    openFile, startEdit, cancelEdit, close, fileGone, editorEl, trackCursor,
    showConflict, discardEdits, overwriteServer,
    showNew, newPath, newError, newInput, newFullPath, openNew, confirmNew,
    showCommitPrompt, commitInput, save, confirmCommit,
    showDelete, deleteMsg, deleting, deleteInput, askDelete, confirmDelete,
    showRename, renameStem, renameMsg, renamePlan, renameError, renaming, renameInput, renameTarget,
    askRename, submitRename,
  };
}

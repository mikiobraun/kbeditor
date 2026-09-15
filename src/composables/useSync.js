import { NotFoundError } from '../api.js';

// Noticing that the vault changed under you.
//
// The REST API has no watch or SSE endpoint, but every write to the KB is a git
// commit, so the head commit hash is a single cheap change token for the whole
// vault: one `GET /history?max=1` answers "did anything change?" without
// re-walking the tree.
//
// There is no timer. The caller checks when the tab comes back to the foreground
// and when you touch the tree or the document — which is when a stale view
// starts to matter — so an idle tab costs nothing at all.
//
// Blind spot: a change that doesn't move HEAD (something written into the vault
// without a commit) is invisible to this.
//
// `refreshTree` re-lists the open folders; `doc` is the open note's state, which
// this reads to decide whether pulling new content in is safe. `onGone` is told
// when the open note has been deleted, and decides what that means.
// `minGap` is the floor between checks, so a burst of clicks in the tree or the
// note is one request rather than twenty. A parameter rather than a constant
// because it is a policy, and because a test shouldn't have to sleep through it.
export function useSync({ client, refreshTree, doc, onGone, minGap = 2000 }) {
  const MIN_SYNC_GAP = minGap;
  let lastHash = null;
  let lastCheck = 0;
  let syncing = false;

  async function headHash() {
    const commits = await client.value.history({ max: 1 });
    return commits.length ? commits[0].hash : null;
  }

  // Record the current head as already seen, so our own commits don't come back
  // as an external change on the next check.
  async function markSynced() {
    try {
      lastHash = await headHash();
      lastCheck = Date.now();
    } catch (e) {
      /* the next check retries */
    }
  }

  function forget() {
    lastHash = null;
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
      // clobbering the buffer would be worse than a stale one. The If-Match save
      // would fail anyway, so flag it and let the user decide.
      const { selected, creating, etag, mode, content, staleFile } = doc;
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
      // A deleted note is news, not a failure. Anything else isn't worth a
      // banner; the next check retries.
      if (e instanceof NotFoundError) onGone();
    } finally {
      syncing = false;
    }
  }

  // Coming back to the tab is the moment a stale view starts to matter, and the
  // one check the user never has to ask for.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) syncNow();
  });
  window.addEventListener('focus', syncNow);

  return { syncNow, markSynced, forget };
}

import { ref, provide } from 'vue';
import { readDraft, writeDraft, removeDraft, draftPaths } from '../lib/drafts.js';

// Unsaved edits in localStorage, per note; see lib/drafts.js for the format.
//
// `paths` is the set of notes with a draft, for the tree's dot. It is provided
// rather than passed down for the same reason as `listDir`: TreeNode is
// recursive. Another tab's drafts arrive through the `storage` event, which
// fires only in the tabs that didn't make the change.
export function useDrafts({ kbUrl }) {
  const paths = ref(new Set());
  provide('draftPaths', paths);

  function refresh() {
    paths.value = new Set(kbUrl.value ? draftPaths(localStorage, kbUrl.value) : []);
  }

  function load(path) {
    return readDraft(localStorage, kbUrl.value, path);
  }

  function store(path, draft) {
    writeDraft(localStorage, kbUrl.value, path, draft);
    if (!paths.value.has(path)) paths.value = new Set([...paths.value, path]);
  }

  function drop(path) {
    removeDraft(localStorage, kbUrl.value, path);
    if (paths.value.has(path)) {
      const next = new Set(paths.value);
      next.delete(path);
      paths.value = next;
    }
  }

  window.addEventListener('storage', refresh);

  return { paths, refresh, load, store, drop };
}

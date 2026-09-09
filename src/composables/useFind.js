import { ref } from 'vue';

// Filename search, which lives in the tree because it answers "which file"
// rather than "where is this text". Results replace the tree with a flat list
// rather than a filtered tree: a folder shown holding only its matching
// children reads as a folder that contains only those children.
//
// `client` is the KbClient ref; `openPath` opens a result (the caller decides
// what that means, which keeps this ignorant of the tree and of history);
// `onError` surfaces a failure the way the app does.
export function useFind({ client, openPath, onError }) {
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
      onError(e);
    } finally {
      finding.value = false;
    }
  }

  function clearFind() {
    findTerm.value = '';
    findResults.value = null;
  }

  // Open a hit, leaving the results up: finding a file usually means opening a
  // few of them in turn.
  async function openFound(path) {
    await openPath(path);
  }

  return { findTerm, findResults, finding, runFind, clearFind, openFound };
}

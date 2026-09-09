import { ref } from 'vue';
import { caseFold, matchParts } from '../lib/text.js';

// Content search across the vault, and the marking of hits in the note you open
// from the results.
//
// One search per Enter, not per keystroke: each one spawns a ripgrep over the
// whole vault, and a debounce still means a full scan for every pause in typing.
// Live search is worth having later; it isn't free enough to switch on by
// default.
//
// `openPath` opens a hit, `onError` surfaces a failure, `onBusy` clears any
// standing banner before a search runs.
export function useSearch({ client, openPath, onError, onBusy }) {
  const searchTerm = ref('');
  const searchResults = ref(null); // null = the pane is showing a file
  const searching = ref(false);
  const highlight = ref(''); // term to mark in the opened file

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
    onBusy();
    try {
      const { matches, truncated } = await client.value.search(term);
      searchResults.value = { term, groups: groupMatches(matches), truncated, count: matches.length };
    } catch (e) {
      onError(e);
    } finally {
      searching.value = false;
    }
  }

  // The term stays in the box, so getting back to the results is pressing Search
  // again. Deliberately not on focusing the box: clicking in to type a new
  // search would then take away the note you were reading.
  function clearSearch() {
    searchTerm.value = '';
    searchResults.value = null;
  }

  // Open the file a match belongs to, carrying the term over so it can be marked
  // in the note.
  async function openMatch(path) {
    const term = searchResults.value ? searchResults.value.term : '';
    searchResults.value = null;
    await openPath(path);
    highlight.value = term;
  }

  // Mark the term in the rendered note. This walks text nodes rather than
  // running a regex over the HTML string, which would happily rewrite tag names
  // and attribute values. Each render replaces the pane's content, so the marks
  // never accumulate.
  function applyHighlight(pane) {
    const term = highlight.value;
    if (!pane || !term) return;
    const fold = caseFold(term);
    const needle = fold(term);
    const walker = document.createTreeWalker(pane, NodeFilter.SHOW_TEXT);
    const targets = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      // Never descend into a mark we already made: if this ever ran twice on the
      // same DOM, it would nest marks inside marks.
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

  return {
    searchTerm, searchResults, searching, highlight,
    runSearch, clearSearch, openMatch, applyHighlight,
  };
}

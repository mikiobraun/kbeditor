import { ref, computed, watch, nextTick } from 'vue';
import { linkAddress, linkDisplay } from '../lib/text.js';
import { taskLines, taskLabel } from '../lib/tasks.js';

// Everything that happens to the rendered note *after* Vue has put it in the
// DOM: marking search hits, making [[wiki links]] clickable, and wiring the task
// checkboxes to their source lines.
//
// These are one composable rather than three because they are one pass. They all
// walk the same element, they all have to run again whenever the rendered HTML
// is replaced, and splitting them would mean three watchers racing over the same
// DOM in an order nothing guarantees.
//
// A rule they share: nothing here builds HTML from strings. Everything works on
// text nodes and elements, because a regex over rendered HTML would happily
// rewrite tag names and attribute values.
export function useDecorations({
  client, doc, notePane, rendered, highlight, applyHighlight, openPath, onError, setBanner,
}) {
  const { selected, content, etag, mode, creating, staleFile } = doc;

  // --- wiki links ---
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

  // Set a link element's state from the current resolutions. Kept separate from
  // creating it, and driven by data-raw, because the resolutions usually arrive
  // *after* the render they belong to — converting [[...]] consumes the markers,
  // so a second pass has to be able to upgrade existing elements rather than
  // look for text that is no longer there.
  function decorateWikiLink(el, raw) {
    const info = linkMap.value.get(linkAddress(raw));
    el.textContent = linkDisplay(raw);
    el.dataset.raw = raw;
    el.onclick = null;
    el.classList.remove('broken', 'pending');

    if (info && info.resolved) {
      el.title = info.resolved;
      el.onclick = () => openPath(info.resolved);
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

  // Replace [[...]] in the rendered note. Text nodes only, and never inside code
  // or an existing link.
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
    // Refresh the ones already converted, which is how a link created before its
    // resolution arrived becomes clickable.
    pane.querySelectorAll('a.wikilink[data-raw]').forEach((el) => decorateWikiLink(el, el.dataset.raw));
  }

  // --- task checkboxes ---
  //
  // marked renders `- [ ]` as a disabled checkbox and DOMPurify keeps it, so
  // ticking one is a matter of enabling it and mapping the click back to the
  // source line it came from — by position, since the render and the source list
  // tasks in the same order.
  const savingTask = ref(false);

  async function toggleTask(i, want, box, markSynced) {
    if (!selected.value || creating.value || savingTask.value || staleFile.value) {
      if (box) box.checked = !want; // nothing was written
      return;
    }
    const task = taskLines(content.value)[i];
    // The source has to agree with what the rendered box was showing. If it
    // doesn't, the two are out of step and writing would tick a line we can't
    // vouch for — so refuse rather than guess.
    if (!task || task.checked === want) {
      if (box) box.checked = !want;
      onError(new Error('This note no longer matches what is on screen — reload before ticking.'));
      return;
    }

    const lines = content.value.split('\n');
    lines[task.line] = task.open + (want ? 'x' : ' ') + task.close + task.text;
    const next = lines.join('\n');
    const message = `${want ? 'Check' : 'Uncheck'} "${taskLabel(task.text)}"`;

    savingTask.value = true;
    setBanner(null);
    try {
      const res = await client.value.write(selected.value.path, next, message, {
        ifMatch: etag.value || undefined,
      });
      content.value = next;
      etag.value = res.etag;
      setBanner({ kind: 'info', text: `Committed: ${message}` });
      await markSynced();
    } catch (e) {
      if (box) box.checked = !want;
      onError(e);
    } finally {
      savingTask.value = false;
    }
  }

  // Enable the rendered checkboxes and wire them to their source line. Each
  // render replaces the pane's content, so listeners can't accumulate.
  function bindTaskBoxes(markSynced) {
    const pane = notePane.value;
    if (!pane) return;
    // Both shapes marked emits: `<li><input>` for a tight list, and
    // `<li><p><input>` for a loose one — items separated by blank lines have
    // their content wrapped in a paragraph. Both must match: catching only the
    // tight ones leaves the wrapped boxes unbound while the tight ones take
    // their indices, so a click ticks a different line than the one you pressed.
    const boxes = pane.querySelectorAll(
      'li > input[type="checkbox"], li > p:first-child > input[type="checkbox"]',
    );
    // The mapping from a box to its source line is positional, so it is only
    // valid while both sides agree on how many there are. If they don't, the
    // rendering has a shape this doesn't know about — leave the boxes inert
    // rather than write to a line we can't identify.
    const tasks = taskLines(content.value);
    if (boxes.length !== tasks.length) {
      boxes.forEach((box) => {
        box.disabled = true;
        box.title = "This note's checkboxes can't be matched to its source, so they're read-only here.";
      });
      return;
    }
    boxes.forEach((box, i) => {
      box.disabled = false;
      box.title = '';
      box.addEventListener('change', () => toggleTask(i, box.checked, box, markSynced));
    });
  }

  // --- external links ---
  //
  // A link to another site opens in a new tab, so following it doesn't leave
  // the editor. External means an http(s) URL on a different origin; mailto:,
  // anchors and relative links are left as they are. Done here and not in
  // renderNote, because DOMPurify strips `target` from the sanitized HTML.
  function bindExternalLinks() {
    const pane = notePane.value;
    if (!pane) return;
    pane.querySelectorAll('a[href]').forEach((a) => {
      let url;
      try {
        url = new URL(a.getAttribute('href'), location.href);
      } catch (e) {
        return;
      }
      if ((url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== location.origin) {
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
      }
    });
  }

  // One pass over the pane. Separate from the watcher below so it can be run —
  // and tested — without waiting on Vue's scheduler.
  function decorate(markSynced) {
    applyHighlight(notePane.value);
    bindWikiLinks();
    bindExternalLinks();
    bindTaskBoxes(markSynced);
  }

  // Re-decorate whenever the rendered HTML is replaced — including switching
  // back from Raw, which recreates the pane element and drops all of it.
  // noteLinks is a source too: it arrives after the render it belongs to.
  function watchRender(markSynced) {
    watch([rendered, highlight, mode, noteLinks], async () => {
      await nextTick();
      decorate(markSynced);
    });
  }

  return { noteLinks, loadLinks, decorate, watchRender };
}

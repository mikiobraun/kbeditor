// Unsaved edits, one per note, kept in a Storage (localStorage in the app) so
// they outlive a reload, a closed tab or a sign-in redirect.
//
// A draft is { text, baseEtag, commitMsg, cursor, savedAt }: baseEtag is the
// version the edits started from, so reopening can tell whether the server has
// moved on since. cursor is { start, end, scrollTop } of the textarea.
//
// The key is the KB URL and the path separated by a space, which a URL can't
// contain — so the path is everything after the prefix, and one KB's prefix
// never matches another's.

function prefix(kbUrl) {
  return `kb_editor_draft_${String(kbUrl).trim().replace(/\/+$/, '')} `;
}

export function draftKey(kbUrl, path) {
  return prefix(kbUrl) + path;
}

// A draft that won't parse is treated as absent, not as an error: there is
// nothing useful to show for it.
export function readDraft(storage, kbUrl, path) {
  try {
    return JSON.parse(storage.getItem(draftKey(kbUrl, path)) || 'null');
  } catch (e) {
    return null;
  }
}

export function writeDraft(storage, kbUrl, path, draft) {
  storage.setItem(draftKey(kbUrl, path), JSON.stringify(draft));
}

export function removeDraft(storage, kbUrl, path) {
  storage.removeItem(draftKey(kbUrl, path));
}

// The paths of every note in this KB that has a draft.
export function draftPaths(storage, kbUrl) {
  const p = prefix(kbUrl);
  const paths = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k && k.startsWith(p)) paths.push(k.slice(p.length));
  }
  return paths;
}

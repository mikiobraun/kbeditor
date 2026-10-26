// Browser history, without a router.
//
// An open note is just `?note=<path>` pushed onto the history stack, so the
// browser's Back button — and a phone's back gesture — walk the notes you
// followed, and a URL can be shared or reloaded straight into a note. Only notes
// are entries; search results are not, which keeps the query out of the URL and
// the ripgrep off the Back button.
//
// The query string is safe for the OAuth flow: redirectUri() is built from
// origin + pathname, and cleanUrl() strips everything else after login.
const NOTE_PARAM = 'note';

export function useHistory({ openPath, currentPath, isReady }) {
  function noteFromUrl() {
    return new URL(location.href).searchParams.get(NOTE_PARAM) || '';
  }

  function pushNoteUrl(path, replace = false) {
    const url = new URL(location.href);
    url.searchParams.set(NOTE_PARAM, path);
    const how = replace ? 'replaceState' : 'pushState';
    history[how]({ [NOTE_PARAM]: path }, '', url);
  }

  // The open note is gone. Replace, not push: an entry pointing at a deleted
  // note would only be a 404 to go Back through.
  function clearNoteUrl() {
    const url = new URL(location.href);
    url.searchParams.delete(NOTE_PARAM);
    history.replaceState({}, '', url);
  }

  // Open the note a history entry names. popstate fires *after* the browser has
  // moved, so an open that fails leaves the URL ahead of the app — push
  // the note we're still on back over it rather than let the two lie.
  async function openHistoryNote(path) {
    if (!isReady() || !path) return;
    if (currentPath() === path) return;
    const opened = await openPath(path, { history: false });
    if (!opened && currentPath()) pushNoteUrl(currentPath(), true);
  }

  window.addEventListener('popstate', (e) => {
    openHistoryNote((e.state && e.state[NOTE_PARAM]) || noteFromUrl());
  });

  return { noteFromUrl, pushNoteUrl, clearNoteUrl };
}

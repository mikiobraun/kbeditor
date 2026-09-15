// Small string helpers shared by the search, link and listing code. Pure, and
// deliberately free of Vue or DOM so they can be tested directly.

// Match ripgrep's smart case: a pattern with an uppercase letter is
// case-sensitive, anything else isn't. Marking has to use the same rule as the
// search did, or we highlight things the server never matched.
export function caseFold(term) {
  const sensitive = /[A-Z]/.test(term);
  return (s) => (sensitive ? s : s.toLowerCase());
}

// Split a line into alternating plain and matching parts, so a hit can be
// marked in the results without ever building HTML out of search results.
export function matchParts(text, term) {
  const s = String(text === null || text === undefined ? '' : text);
  if (!term) return [{ t: s, hit: false }];
  const fold = caseFold(term);
  const hay = fold(s);
  const needle = fold(term);
  const parts = [];
  let i = 0;
  for (;;) {
    const at = hay.indexOf(needle, i);
    if (at === -1) break;
    if (at > i) parts.push({ t: s.slice(i, at), hit: false });
    parts.push({ t: s.slice(at, at + term.length), hit: true });
    i = at + term.length;
  }
  if (i < s.length) parts.push({ t: s.slice(i), hit: false });
  return parts;
}

// Split a path for display: the filename reads normally, the folder sits behind
// it in muted text.
export function pathParts(path) {
  const at = String(path).lastIndexOf('/');
  return at === -1
    ? { dir: '', name: String(path) }
    : { dir: String(path).slice(0, at), name: String(path).slice(at + 1) };
}

// Split a filename at its last dot: `notes.md` is `notes` + `.md`. A leading dot
// starts a name rather than an extension, so `.env` has none.
export function splitExt(name) {
  const at = String(name).lastIndexOf('.');
  return at <= 0
    ? { stem: String(name), ext: '' }
    : { stem: String(name).slice(0, at), ext: String(name).slice(at) };
}

// The path a rename to `stem` produces: same folder, same extension.
export function renamedPath(path, stem) {
  const { dir, name } = pathParts(path);
  const next = stem + splitExt(name).ext;
  return dir ? `${dir}/${next}` : next;
}

// The address of a [[wiki link]] is everything before an |alias, #heading or
// ^block, matching what the server reports as the link's target.
export function linkAddress(raw) {
  return raw.split(/[|#^]/)[0].trim();
}

// What a [[wiki link]] shows: the alias when there is one, else the target.
export function linkDisplay(raw) {
  const bar = raw.indexOf('|');
  return bar === -1 ? raw.trim() : raw.slice(bar + 1).trim();
}

// Every listing is shown the same way: dot-files hidden, folders before files,
// each group alphabetical. Lives here so the tree, the root list and the
// post-change refresh can't drift apart.
export function visibleEntries(entries) {
  return entries
    .filter((e) => !e.name.startsWith('.'))
    .sort((a, b) => (a.is_dir === b.is_dir ? a.name.localeCompare(b.name) : a.is_dir ? -1 : 1));
}

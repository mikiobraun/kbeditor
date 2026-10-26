import { describe, it, expect } from 'vitest';
import { draftKey, readDraft, writeDraft, removeDraft, draftPaths } from './drafts.js';

// Just enough of the Storage interface.
function fakeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  };
}

describe('drafts', () => {
  it('round-trips a draft', () => {
    const s = fakeStorage();
    const d = { text: 'hi', baseEtag: '"1"', commitMsg: '', cursor: null, savedAt: 1 };
    writeDraft(s, 'https://kb', 'a/b.md', d);
    expect(readDraft(s, 'https://kb', 'a/b.md')).toEqual(d);
    removeDraft(s, 'https://kb', 'a/b.md');
    expect(readDraft(s, 'https://kb', 'a/b.md')).toBeNull();
  });

  it('ignores a trailing slash on the KB URL', () => {
    expect(draftKey('https://kb/', 'x.md')).toBe(draftKey('https://kb', 'x.md'));
  });

  it('lists the paths of one KB only', () => {
    const s = fakeStorage();
    writeDraft(s, 'https://kb', 'one.md', {});
    writeDraft(s, 'https://kb', 'dir/two words.md', {});
    writeDraft(s, 'https://kb.other', 'three.md', {});
    s.setItem('kb_editor_last_url', 'https://kb');
    expect(draftPaths(s, 'https://kb').sort()).toEqual(['dir/two words.md', 'one.md']);
  });

  it('treats an unparseable draft as absent', () => {
    const s = fakeStorage();
    s.setItem(draftKey('https://kb', 'x.md'), '{nope');
    expect(readDraft(s, 'https://kb', 'x.md')).toBeNull();
  });
});

import { describe, it, expect, vi } from 'vitest';
import { ref } from 'vue';
import { useSearch } from './useSearch.js';
import { useFind } from './useFind.js';

const noop = () => {};

function setup(over = {}) {
  const openPath = vi.fn();
  const onError = vi.fn();
  const client = ref({
    search: vi.fn(async () => ({ matches: [], truncated: false })),
    find: vi.fn(async () => ({ paths: [], truncated: false })),
    ...over,
  });
  return { client, openPath, onError };
}

describe('useSearch', () => {
  it('groups matches by file, in the order they arrive', async () => {
    const { client, openPath, onError } = setup({
      search: vi.fn(async () => ({
        matches: [
          { path: 'a.md', line: 2, text: 'one' },
          { path: 'b.md', line: 9, text: 'two' },
          { path: 'a.md', line: 7, text: 'three' },
        ],
        truncated: false,
      })),
    });
    const s = useSearch({ client, openPath, onError, onBusy: noop });

    s.searchTerm.value = 'x';
    await s.runSearch();

    expect(s.searchResults.value.groups.map((g) => g.path)).toEqual(['a.md', 'b.md']);
    expect(s.searchResults.value.groups[0].lines.map((l) => l.line)).toEqual([2, 7]);
    expect(s.searchResults.value.count).toBe(3);
  });

  it('an empty term clears rather than searching for nothing', async () => {
    const { client, openPath, onError } = setup();
    const s = useSearch({ client, openPath, onError, onBusy: noop });

    s.searchTerm.value = '   ';
    await s.runSearch();

    expect(client.value.search).not.toHaveBeenCalled();
    expect(s.searchResults.value).toBe(null);
    expect(s.searchTerm.value).toBe('');
  });

  it('reports a failure and stops being busy', async () => {
    const { client, openPath, onError } = setup({
      search: vi.fn(async () => { throw new Error('boom'); }),
    });
    const s = useSearch({ client, openPath, onError, onBusy: noop });

    s.searchTerm.value = 'x';
    await s.runSearch();

    expect(onError).toHaveBeenCalledOnce();
    expect(s.searching.value).toBe(false);
    expect(s.searchResults.value).toBe(null);
  });

  // Opening a hit carries the term over so it can be marked in the note, and
  // puts the results away — the term stays in the box as the way back.
  it('opens a hit, keeps the term for marking, and hides the results', async () => {
    const { client, openPath, onError } = setup({
      search: vi.fn(async () => ({ matches: [{ path: 'a.md', line: 1, text: 't' }], truncated: false })),
    });
    const s = useSearch({ client, openPath, onError, onBusy: noop });

    s.searchTerm.value = 'needle';
    await s.runSearch();
    await s.openMatch('a.md');

    expect(openPath).toHaveBeenCalledWith('a.md');
    expect(s.highlight.value).toBe('needle');
    expect(s.searchResults.value).toBe(null);
    expect(s.searchTerm.value).toBe('needle'); // still the way back
  });
});

describe('useFind', () => {
  it('keeps the results up after opening one, since you open several', async () => {
    const { client, openPath, onError } = setup({
      find: vi.fn(async () => ({ paths: ['a.md', 'sub/b.md'], truncated: false })),
    });
    const f = useFind({ client, openPath, onError });

    f.findTerm.value = 'b';
    await f.runFind();
    await f.openFound('sub/b.md');

    expect(openPath).toHaveBeenCalledWith('sub/b.md');
    expect(f.findResults.value.paths).toHaveLength(2);
  });

  it('clears back to the tree', async () => {
    const { client, openPath, onError } = setup({
      find: vi.fn(async () => ({ paths: ['a.md'], truncated: false })),
    });
    const f = useFind({ client, openPath, onError });

    f.findTerm.value = 'a';
    await f.runFind();
    f.clearFind();

    expect(f.findResults.value).toBe(null);
    expect(f.findTerm.value).toBe('');
  });

  it('carries the truncation flag through, so a capped list never looks complete', async () => {
    const { client, openPath, onError } = setup({
      find: vi.fn(async () => ({ paths: ['a.md'], truncated: true })),
    });
    const f = useFind({ client, openPath, onError });

    f.findTerm.value = 'a';
    await f.runFind();

    expect(f.findResults.value.truncated).toBe(true);
  });
});

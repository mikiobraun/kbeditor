import { describe, it, expect, vi } from 'vitest';
import { ref } from 'vue';
import { useSync } from './useSync.js';

// A document in the shape useSync expects, with sensible defaults.
function makeDoc(over = {}) {
  return {
    selected: ref({ path: 'note.md' }),
    content: ref('original'),
    etag: ref('"v1"'),
    mode: ref('view'),
    creating: ref(false),
    staleFile: ref(false),
    ...over,
  };
}

// Every write to the KB is a commit, so the head hash answers "did anything
// change?" for the whole vault in one request.
function makeClient({ hashes = ['abc'], read } = {}) {
  let i = 0;
  return ref({
    history: vi.fn(async () => [{ hash: hashes[Math.min(i++, hashes.length - 1)] }]),
    read: read || vi.fn(async () => ({ text: 'from server', etag: '"v2"' })),
  });
}

// jsdom is not loaded for this file, so document.hidden has to exist for the
// early return in syncNow. Node has no document at all.
globalThis.document = { hidden: false, addEventListener() {} };
globalThis.window = { addEventListener() {} };

describe('useSync', () => {
  it('does nothing when the head has not moved', async () => {
    const client = makeClient({ hashes: ['abc'] });
    const doc = makeDoc();
    const refreshTree = vi.fn();
    const { syncNow, markSynced } = useSync({ client, refreshTree, doc, minGap: 0 });

    await markSynced(); // head seen
    await syncNow();

    expect(refreshTree).not.toHaveBeenCalled();
    expect(client.value.read).not.toHaveBeenCalled();
    expect(doc.content.value).toBe('original');
  });

  it('refreshes the tree and pulls new content when the head moves', async () => {
    const client = makeClient({ hashes: ['abc', 'def'] });
    const doc = makeDoc();
    const refreshTree = vi.fn();
    const { syncNow, markSynced } = useSync({ client, refreshTree, doc, minGap: 0 });

    await markSynced();
    await syncNow();

    expect(refreshTree).toHaveBeenCalledOnce();
    expect(doc.content.value).toBe('from server');
    expect(doc.etag.value).toBe('"v2"');
    expect(doc.staleFile.value).toBe(false);
  });

  // The case that matters most: the buffer is the user's unsaved work, and a
  // background refresh must never replace it.
  it('flags a stale file while editing instead of replacing the buffer', async () => {
    const client = makeClient({ hashes: ['abc', 'def'] });
    const doc = makeDoc({ mode: ref('edit') });
    const { syncNow, markSynced } = useSync({ client, refreshTree: vi.fn(), doc, minGap: 0 });

    await markSynced();
    await syncNow();

    expect(doc.content.value).toBe('original'); // untouched
    expect(doc.staleFile.value).toBe(true);
  });

  it('leaves the buffer alone when the file has not changed, even on a new commit', async () => {
    const client = makeClient({
      hashes: ['abc', 'def'],
      read: vi.fn(async () => ({ text: 'anything', etag: '"v1"' })), // same etag
    });
    const doc = makeDoc({ mode: ref('edit') });
    const { syncNow, markSynced } = useSync({ client, refreshTree: vi.fn(), doc, minGap: 0 });

    await markSynced();
    await syncNow();

    expect(doc.staleFile.value).toBe(false);
    expect(doc.content.value).toBe('original');
  });

  it('does not read a file that does not exist on the server yet', async () => {
    const client = makeClient({ hashes: ['abc', 'def'] });
    const doc = makeDoc({ creating: ref(true) });
    const { syncNow, markSynced } = useSync({ client, refreshTree: vi.fn(), doc, minGap: 0 });

    await markSynced();
    await syncNow();

    expect(client.value.read).not.toHaveBeenCalled();
  });

  // A burst of clicks in the tree or the note is one request, not twenty.
  it('collapses checks inside the floor', async () => {
    // The real floor, not the 0 the other tests use: this is the behaviour.
    const client = makeClient({ hashes: ['abc', 'def', 'ghi'] });
    const { syncNow } = useSync({ client, refreshTree: vi.fn(), doc: makeDoc() });

    await syncNow();
    await syncNow();
    await syncNow();

    expect(client.value.history).toHaveBeenCalledOnce();
  });

  it('forgets the head so a reconnect re-checks', async () => {
    const client = makeClient({ hashes: ['abc'] });
    const refreshTree = vi.fn();
    const { syncNow, markSynced, forget } = useSync({ client, refreshTree, doc: makeDoc(), minGap: 0 });

    await markSynced();
    forget();
    await syncNow();

    expect(refreshTree).toHaveBeenCalledOnce(); // head now differs from null
  });
});

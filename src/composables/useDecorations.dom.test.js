// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref, nextTick } from 'vue';
import { marked } from 'marked';
import { useDecorations } from './useDecorations.js';

// These run against real rendered markdown rather than hand-written HTML,
// because the bug this file exists to prevent was a disagreement between what
// marked emits and what the binder looked for.

function setup({ note = '', links = [], mode = 'view' } = {}) {
  const pane = document.createElement('div');
  pane.innerHTML = marked.parse(note);
  document.body.appendChild(pane);

  const doc = {
    selected: ref({ path: 'note.md' }),
    content: ref(note),
    etag: ref('"v1"'),
    mode: ref(mode),
    creating: ref(false),
    staleFile: ref(false),
  };
  const client = ref({
    links: vi.fn(async () => links),
    write: vi.fn(async () => ({ etag: '"v2"' })),
  });
  const onError = vi.fn();
  const openPath = vi.fn();
  const d = useDecorations({
    client,
    doc,
    notePane: ref(pane),
    rendered: ref(pane.innerHTML),
    highlight: ref(''),
    applyHighlight: () => {},
    openPath,
    onError,
    setBanner: () => {},
  });
  return { pane, doc, client, onError, openPath, d };
}

beforeEach(() => { document.body.innerHTML = ''; });

describe('task checkboxes', () => {
  // A loose list — items separated by blank lines — has its content wrapped in
  // <p>, which is what the original selector missed: the wrapped boxes went
  // unbound and the tight ones took their indices, so ticking a sub-item
  // rewrote a heading item above it.
  const looseNote = [
    '- [x] first',
    '',
    '- [x] second',
    '',
    '- [x] third with children',
    '  - [x] child a',
    '  - [x] child b',
  ].join('\n');

  it('binds every checkbox in a loose list, not just the tight ones', async () => {
    const { pane, d } = setup({ note: looseNote });
    d.decorate(vi.fn());

    const boxes = pane.querySelectorAll('input[type="checkbox"]');
    expect(boxes).toHaveLength(5);
    expect([...boxes].every((b) => !b.disabled)).toBe(true);
  });

  it('maps a click to the line it came from, not to a different one', async () => {
    const { pane, doc, client, d } = setup({ note: looseNote });
    d.decorate(vi.fn());

    // The fourth box on screen is "child a", source line 5.
    const box = pane.querySelectorAll('input[type="checkbox"]')[3];
    box.checked = false;
    box.dispatchEvent(new Event('change'));
    await nextTick();

    const written = client.value.write.mock.calls[0][1];
    expect(written.split('\n')[5]).toBe('  - [ ] child a');
    expect(written.split('\n')[0]).toBe('- [x] first'); // untouched
  });

  it('names the item it ticked in the commit message', async () => {
    const { pane, client, d } = setup({ note: '- [ ] buy milk and bread\n' });
    d.decorate(vi.fn());

    const box = pane.querySelector('input[type="checkbox"]');
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    await nextTick();

    expect(client.value.write.mock.calls[0][2]).toBe('Check "buy milk and bread"');
  });

  // The mapping is positional, so it is only valid while both sides count the
  // same. A shape we don't understand must not write to a line we can't name.
  it('leaves the boxes read-only when the counts disagree', async () => {
    const { pane, d } = setup({ note: '- [ ] one\n' });
    // A stray checkbox the source knows nothing about.
    const li = document.createElement('li');
    li.innerHTML = '<input type="checkbox"> extra';
    pane.querySelector('ul').appendChild(li);

    d.decorate(vi.fn());

    const boxes = pane.querySelectorAll('input[type="checkbox"]');
    expect([...boxes].every((b) => b.disabled)).toBe(true);
  });

  it('refuses and reverts when the source disagrees with the box', async () => {
    const { pane, doc, client, onError, d } = setup({ note: '- [ ] one\n' });
    d.decorate(vi.fn());

    doc.content.value = '- [x] one\n'; // changed under us
    const box = pane.querySelector('input[type="checkbox"]');
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    await nextTick();

    expect(client.value.write).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
    expect(box.checked).toBe(false); // put back
  });
});

describe('wiki links', () => {
  it('turns [[...]] into a link that opens the resolved note', async () => {
    const { pane, openPath, d } = setup({
      note: 'see [[target]] here\n',
      links: [{ target: 'target', resolved: 'notes/target.md', broken: false }],
    });
    await d.loadLinks();
    d.decorate(vi.fn());

    const link = pane.querySelector('a.wikilink');
    expect(link).not.toBe(null);
    expect(link.textContent).toBe('target');
    expect(link.classList.contains('broken')).toBe(false);

    link.onclick();
    expect(openPath).toHaveBeenCalledWith('notes/target.md');
  });

  it('marks an unresolved link and says why, without making it clickable', async () => {
    const { pane, d } = setup({
      note: 'see [[nope]]\n',
      links: [{ target: 'nope', resolved: '', broken: true, reason: 'no note with that name' }],
    });
    await d.loadLinks();
    d.decorate(vi.fn());

    const link = pane.querySelector('a.wikilink');
    expect(link.classList.contains('broken')).toBe(true);
    expect(link.title).toContain('no note with that name');
    expect(link.onclick).toBe(null);
  });

  it('shows an alias and resolves by the address', async () => {
    const { pane, openPath, d } = setup({
      note: 'see [[target|Some Label]]\n',
      links: [{ target: 'target', resolved: 'notes/target.md', broken: false }],
    });
    await d.loadLinks();
    d.decorate(vi.fn());

    const link = pane.querySelector('a.wikilink');
    expect(link.textContent).toBe('Some Label');
    link.onclick();
    expect(openPath).toHaveBeenCalledWith('notes/target.md');
  });

  // A [[...]] shown as an example is not a link.
  it('leaves [[...]] inside code alone', async () => {
    const { pane, d } = setup({
      note: 'inline `[[target]]` and\n\n```\n[[target]]\n```\n',
      links: [],
    });
    await d.loadLinks();
    d.decorate(vi.fn());

    expect(pane.querySelectorAll('a.wikilink')).toHaveLength(0);
  });
});

import { describe, it, expect } from 'vitest';
import { splitFrontmatter, renderFrontmatter, escapeHtml } from './markdown.js';

// renderNote is not tested here: it ends in DOMPurify, which needs a DOM. The
// parts above it are pure, and they are where the decisions live.

describe('splitFrontmatter', () => {
  it('separates a block from the body', () => {
    expect(splitFrontmatter('---\ntitle: x\n---\n# Body')).toEqual({ raw: 'title: x', body: '# Body' });
  });

  // Without this the delimiters reach marked and render as horizontal rules.
  it('treats an empty block as frontmatter, not as two rules', () => {
    expect(splitFrontmatter('---\n---\n# Body')).toEqual({ raw: '', body: '# Body' });
  });

  it('does not let a value ending in --- close the block early', () => {
    expect(splitFrontmatter('---\ntitle: a---\n---\nBody').raw).toBe('title: a---');
  });

  it('leaves a note without frontmatter alone, rules and all', () => {
    const note = '# Note\n\n---\n\nafter a rule';
    expect(splitFrontmatter(note)).toEqual({ raw: null, body: note });
  });

  it('handles CRLF, trailing spaces, and a file that is only frontmatter', () => {
    expect(splitFrontmatter('---\r\ntitle: x\r\n---\r\nBody').raw).toBe('title: x');
    expect(splitFrontmatter('---\ntitle: x\n---   \nBody').raw).toBe('title: x');
    expect(splitFrontmatter('---\ntitle: x\n---')).toEqual({ raw: 'title: x', body: '' });
  });
});

describe('renderFrontmatter', () => {
  it('renders scalars as rows', () => {
    expect(renderFrontmatter('title: Hello')).toContain('<span class="fm-key">title</span>');
    expect(renderFrontmatter('title: Hello')).toContain('<span class="fm-val">Hello</span>');
  });

  // The failsafe schema is what keeps this true: nothing is guessed to be a
  // date, a number or a boolean, so the card shows what the file says.
  it('shows values exactly as written', () => {
    const html = renderFrontmatter('date: 2026-09-06\ncount: 42\nflag: true');
    expect(html).toContain('>2026-09-06<');
    expect(html).toContain('>42<');
    expect(html).toContain('>true<');
  });

  it('joins a list of scalars inline', () => {
    expect(renderFrontmatter('tags: [inbox, work]')).toContain('<span class="fm-val">inbox, work</span>');
  });

  it('indents nested maps', () => {
    const html = renderFrontmatter('authentication:\n  dkim: pass');
    expect(html).toContain('fm-parent');
    expect(html).toContain('<div class="fm-sub">');
  });

  it('groups each element of a list of maps', () => {
    const html = renderFrontmatter('attachments:\n  - name: a.png\n  - name: b.pdf');
    expect(html.match(/fm-item/g)).toHaveLength(2);
  });

  it('shows a block it cannot parse verbatim rather than dropping it', () => {
    const html = renderFrontmatter('key: [unclosed\nother: x');
    expect(html).toContain('frontmatter-raw');
    expect(html).toContain('key: [unclosed');
  });

  // js-yaml rejects empty input as an error; a note with no metadata is not a
  // broken note.
  it('renders nothing for an empty block', () => {
    expect(renderFrontmatter('')).toBe('');
    expect(renderFrontmatter('  \n ')).toBe('');
  });

  it('escapes markup in keys and values', () => {
    const html = renderFrontmatter('title: <img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('<img');
  });
});

describe('escapeHtml', () => {
  it('escapes the five that matter', () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  });
});

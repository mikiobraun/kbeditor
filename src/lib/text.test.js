import { describe, it, expect } from 'vitest';
import { matchParts, pathParts, linkAddress, linkDisplay, visibleEntries } from './text.js';

describe('matchParts', () => {
  it('splits a line around the hits', () => {
    expect(matchParts('a needle here', 'needle')).toEqual([
      { t: 'a ', hit: false },
      { t: 'needle', hit: true },
      { t: ' here', hit: false },
    ]);
  });

  it('marks every occurrence', () => {
    expect(matchParts('xax', 'x').filter((p) => p.hit)).toHaveLength(2);
  });

  // Ripgrep's smart case, mirrored: a pattern with an uppercase letter matches
  // case-sensitively, so nothing is marked that the server didn't match.
  it('follows smart case', () => {
    expect(matchParts('Foo and foo', 'foo').filter((p) => p.hit)).toHaveLength(2);
    expect(matchParts('Foo and foo', 'Foo').filter((p) => p.hit)).toHaveLength(1);
  });

  it('returns the line whole when there is no term or no hit', () => {
    expect(matchParts('abc', '')).toEqual([{ t: 'abc', hit: false }]);
    expect(matchParts('abc', 'z')).toEqual([{ t: 'abc', hit: false }]);
  });
});

describe('pathParts', () => {
  it('splits folder from filename', () => {
    expect(pathParts('tax/2026-q3/x.md')).toEqual({ dir: 'tax/2026-q3', name: 'x.md' });
    expect(pathParts('top.md')).toEqual({ dir: '', name: 'top.md' });
  });
});

describe('wiki link text', () => {
  it('takes the address before an alias, heading or block ref', () => {
    expect(linkAddress('note')).toBe('note');
    expect(linkAddress('note|Label')).toBe('note');
    expect(linkAddress('note#Heading')).toBe('note');
    expect(linkAddress('note^block')).toBe('note');
    expect(linkAddress('  mails/x  ')).toBe('mails/x');
  });

  it('displays the alias when there is one', () => {
    expect(linkDisplay('note')).toBe('note');
    expect(linkDisplay('note|Some Label')).toBe('Some Label');
  });
});

describe('visibleEntries', () => {
  it('hides dot-files and puts folders first, each alphabetical', () => {
    const entries = [
      { name: 'b.md', is_dir: false },
      { name: '.hidden', is_dir: false },
      { name: 'zeta', is_dir: true },
      { name: 'a.md', is_dir: false },
      { name: 'alpha', is_dir: true },
    ];
    expect(visibleEntries(entries).map((e) => e.name)).toEqual(['alpha', 'zeta', 'a.md', 'b.md']);
  });
});

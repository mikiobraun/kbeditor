import { describe, it, expect } from 'vitest';
import { delimiterFor, parseDelimited, tableHtml } from './csv.js';

// renderTable is not tested here: it ends in DOMPurify, which needs a DOM.

describe('delimiterFor', () => {
  it('goes by extension only', () => {
    expect(delimiterFor('a/b.csv')).toBe(',');
    expect(delimiterFor('b.TSV')).toBe('\t');
    expect(delimiterFor('note.md')).toBe(null);
    expect(delimiterFor('csv')).toBe(null);
    expect(delimiterFor('dir.csv/file')).toBe(null);
  });
});

describe('parseDelimited', () => {
  it('splits rows and fields', () => {
    expect(parseDelimited('a,b\n1,2\n', ',')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('handles CRLF, a missing final newline and a BOM', () => {
    expect(parseDelimited('﻿a,b\r\n1,2', ',')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('keeps delimiters, newlines and doubled quotes inside quoted fields', () => {
    expect(parseDelimited('"x,y","line\none","say ""hi"""\n', ','))
      .toEqual([['x,y', 'line\none', 'say "hi"']]);
  });

  it('treats a quote that does not start a field as a character', () => {
    expect(parseDelimited('5" disk,ok', ',')).toEqual([['5" disk', 'ok']]);
  });

  it('keeps empty fields and blank lines', () => {
    expect(parseDelimited('a,,c\n\n,', ',')).toEqual([['a', '', 'c'], [''], ['', '']]);
  });

  it('keeps a quoted empty field as the last row', () => {
    expect(parseDelimited('a\n""', ',')).toEqual([['a'], ['']]);
  });

  it('uses the given delimiter', () => {
    expect(parseDelimited('a\tb,c', '\t')).toEqual([['a', 'b,c']]);
  });

  it('rejects an unclosed quote, naming its line', () => {
    expect(() => parseDelimited('a,b\n1,"oops\n2,3', ',')).toThrow('line 2');
  });

  it('returns no rows for an empty file', () => {
    expect(parseDelimited('', ',')).toEqual([]);
  });
});

describe('tableHtml', () => {
  it('uses the first row as header and escapes cells', () => {
    const html = tableHtml([['<b>', 'x'], ['1', '&']]);
    expect(html).toContain('<thead><tr><th>&lt;b&gt;</th><th>x</th></tr></thead>');
    expect(html).toContain('<tr><td>1</td><td>&amp;</td></tr>');
  });

  it('pads short rows and marks rows that disagree with the header', () => {
    const html = tableHtml([['a', 'b'], ['1'], ['1', '2', '3']]);
    expect(html).toContain('<th>a</th><th>b</th><th></th>');
    expect(html).toContain('<tr class="ragged" title="1 fields, header has 2"><td>1</td><td></td><td></td></tr>');
    expect(html).toContain('<tr class="ragged" title="3 fields, header has 2">');
  });

  it('says when the file is empty', () => {
    expect(tableHtml([])).toContain('Empty file');
  });
});

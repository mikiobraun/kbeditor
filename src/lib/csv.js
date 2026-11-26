// Turning a delimited file into the table the viewer shows. Like markdown.js,
// everything but renderTable is a pure function of its input.

import DOMPurify from 'dompurify';
import { escapeHtml } from './markdown.js';

// delimiterFor picks the delimiter from the extension alone: comma for .csv,
// tab for .tsv, null for anything that isn't a table. No sniffing — a
// semicolon-separated .csv shows as one column, which is at least predictable.
export function delimiterFor(path) {
  const m = /\.([^./]+)$/.exec(path || '');
  const ext = m ? m[1].toLowerCase() : '';
  if (ext === 'csv') return ',';
  if (ext === 'tsv') return '\t';
  return null;
}

// parseDelimited splits text into rows of fields, RFC 4180 style: a field that
// starts with `"` is quoted, may contain the delimiter and newlines, and writes
// a literal quote as `""`. A quote anywhere else is an ordinary character.
// Rows end at LF or CRLF; a final line break doesn't start an empty row.
//
// A quote that is never closed throws, since everything after it would
// otherwise land in one giant field.
export function parseDelimited(text, delim) {
  const s = (text || '').replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let i = 0;
  let atFieldStart = true;

  const endField = () => { row.push(field); field = ''; atFieldStart = true; };
  const endRow = () => { endField(); rows.push(row); row = []; };

  while (i < s.length) {
    const c = s[i];
    if (atFieldStart && c === '"') {
      const start = i;
      i++;
      for (;;) {
        if (i >= s.length) {
          const line = s.slice(0, start).split('\n').length;
          throw new Error(`Unclosed quote starting on line ${line}`);
        }
        if (s[i] === '"') {
          if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
          i++;
          break;
        }
        field += s[i++];
      }
      atFieldStart = false;
      continue;
    }
    if (c === delim) { endField(); i++; continue; }
    if (c === '\n' || (c === '\r' && s[i + 1] === '\n')) {
      endRow();
      i += c === '\r' ? 2 : 1;
      continue;
    }
    field += c;
    atFieldStart = false;
    i++;
  }
  // Anything after the last line break is a row; an empty remainder is not.
  if (field !== '' || row.length > 0 || !atFieldStart) endRow();
  return rows;
}

// tableHtml renders parsed rows with the first as the header. The table is as
// wide as its widest row and short rows are padded. A row whose length differs
// from the header's is marked `ragged`, so a broken line shows as broken rather
// than being silently squared off.
export function tableHtml(rows) {
  if (rows.length === 0) return '<p class="muted">Empty file.</p>';
  const width = Math.max(...rows.map((r) => r.length));
  const headLen = rows[0].length;
  const cells = (r, tag) => {
    let out = '';
    for (let j = 0; j < width; j++) out += `<${tag}>${escapeHtml(r[j] ?? '')}</${tag}>`;
    return out;
  };
  const body = rows.slice(1).map((r) => {
    if (r.length === headLen) return `<tr>${cells(r, 'td')}</tr>`;
    const title = `${r.length} fields, header has ${headLen}`;
    return `<tr class="ragged" title="${escapeHtml(title)}">${cells(r, 'td')}</tr>`;
  }).join('');
  return `<table class="csv"><thead><tr>${cells(rows[0], 'th')}</tr></thead><tbody>${body}</tbody></table>`;
}

// renderTable renders a delimited file to sanitized HTML. A file that won't
// parse is shown verbatim under a notice, the same stance as broken
// frontmatter. Needs a DOM, because DOMPurify does.
export function renderTable(text, delim) {
  let html;
  try {
    html = tableHtml(parseDelimited(text, delim));
  } catch (e) {
    html = `<p class="csv-error">${escapeHtml(e.message)} — showing the file as text.</p>`
      + `<pre>${escapeHtml(text || '')}</pre>`;
  }
  return DOMPurify.sanitize(html);
}

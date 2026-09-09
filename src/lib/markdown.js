// Turning a note's text into the HTML the viewer shows: the frontmatter card,
// then the markdown body. Everything here is a pure function of its input —
// no Vue, no DOM, no network — which is what makes it testable.

import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { load as loadYaml, FAILSAFE_SCHEMA } from 'js-yaml';

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// splitFrontmatter separates a leading YAML frontmatter block (--- … ---) from
// the note body, returning the block's text unparsed — what to do with a block
// that won't parse is the renderer's call. Without the split, marked renders the
// closing --- as a setext heading.
export function splitFrontmatter(text) {
  // The content group is optional so that an empty block (`---` then `---`)
  // still counts as frontmatter; without that the delimiters reach marked and
  // render as horizontal rules. Requiring the newline *inside* that group keeps
  // the closing `---` at the start of a line, so a value ending in `---`
  // doesn't close the block early.
  const m = /^---\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { raw: null, body: text };
  return { raw: m[1] || '', body: text.slice(m[0].length) };
}

// A frontmatter value is scalar for display purposes when it isn't a map or a
// list. Under the failsafe schema that means it's a string.
function isScalar(v) {
  return v === null || typeof v !== 'object';
}

// inlineValue renders the values that fit on the key's own row: a scalar, or a
// list of scalars joined with commas. Anything with structure returns null and
// gets a block instead.
function inlineValue(v) {
  const text = (x) => (x === null || x === undefined ? '' : String(x));
  if (isScalar(v)) return escapeHtml(text(v));
  if (Array.isArray(v) && v.every(isScalar)) return escapeHtml(v.map(text).join(', '));
  return null;
}

// fmRows renders a parsed frontmatter value as indented key/value rows. A map
// nests one level deeper; a list carrying structure (the vault's `attachments`,
// say) puts each element in its own group, so it stays visible which values
// belong together.
export function fmRows(v) {
  if (Array.isArray(v)) {
    return v.map((item) => `<div class="fm-item">${fmRows(item)}</div>`).join('');
  }
  if (isScalar(v)) {
    return `<div class="fm-row"><span class="fm-val">${escapeHtml(v === null ? '' : String(v))}</span></div>`;
  }
  return Object.entries(v)
    .map(([k, val]) => {
      const key = `<span class="fm-key">${escapeHtml(k)}</span>`;
      const inline = inlineValue(val);
      if (inline !== null) return `<div class="fm-row">${key}<span class="fm-val">${inline}</span></div>`;
      return `<div class="fm-row fm-parent">${key}</div><div class="fm-sub">${fmRows(val)}</div>`;
    })
    .join('');
}

// renderFrontmatter turns the raw block into the metadata card. The parse runs
// under YAML's failsafe schema, so every scalar stays the text that was written
// — nothing is guessed to be a date, a number or a boolean, which keeps what you
// see equal to what the file says. A block that won't parse is shown verbatim
// rather than dropped or turned into an error, the same line kbmcp takes.
export function renderFrontmatter(raw) {
  // An empty block (`---` immediately followed by `---`) is a note with no
  // metadata, not a broken one. js-yaml rejects empty input as an error, so
  // this has to be settled before parsing.
  if (!raw.trim()) return '';
  let data;
  try {
    data = loadYaml(raw, { schema: FAILSAFE_SCHEMA });
  } catch (e) {
    return `<pre class="frontmatter-raw">${escapeHtml(raw)}</pre>`;
  }
  const rows = data === null || data === undefined ? '' : fmRows(data);
  return rows ? `<div class="frontmatter">${rows}</div>` : '';
}

// renderNote renders a note to sanitized HTML: the frontmatter card (if any),
// then the markdown body.
//
// The only function here that needs a DOM, because DOMPurify does.
export function renderNote(text) {
  const { raw, body } = splitFrontmatter(text || '');
  const card = raw === null ? '' : renderFrontmatter(raw);
  // A marker between the card and the body gives the toolbar's Content button
  // something to scroll to. A class rather than an id: ids in note content
  // could collide, classes we query for can't.
  const html = card + (card ? '<div class="note-body-start"></div>' : '') + marked.parse(body);
  return DOMPurify.sanitize(html);
}

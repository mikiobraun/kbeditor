// Task-list lines in a note's source, and the commit messages a toggle writes.
//
// The scanning here has to agree with what marked renders as a checkbox, since
// a click is mapped to a source line by position. Where the two could disagree,
// the caller compares counts and refuses rather than guessing — see
// bindTaskBoxes.

// taskLines returns the note's task-list lines in source order, split so a
// toggle can rewrite just the marker. Fenced code blocks are skipped: marked
// doesn't render a `- [ ]` inside a fence as a checkbox, so counting one here
// would shift every index after it and tick the wrong line.
export function taskLines(text) {
  const out = [];
  let fence = null;
  const lines = String(text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = /^\s*(```+|~~~+)/.exec(line);
    if (f) {
      if (fence === null) fence = f[1];
      else if (line.trim().startsWith(fence[0].repeat(fence.length))) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const m = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\]\s?)(.*)$/.exec(line);
    if (m) out.push({ line: i, checked: m[2] !== ' ', open: m[1], close: m[3], text: m[4] });
  }
  return out;
}

// Task text as prose, for a commit message: link labels survive, emphasis and
// code markers don't.
export function plainText(md) {
  return String(md)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// One rule for the label, applied whatever the line looks like: the notes use
// em dashes, colons and full stops interchangeably, so there is no boundary
// worth detecting — just take the first 30 characters.
const TASK_LABEL_MAX = 30;

export function taskLabel(md) {
  const t = plainText(md);
  return t.length > TASK_LABEL_MAX ? `${t.slice(0, TASK_LABEL_MAX)}…` : t;
}

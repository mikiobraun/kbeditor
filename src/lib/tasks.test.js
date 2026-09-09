import { describe, it, expect } from 'vitest';
import { taskLines, plainText, taskLabel } from './tasks.js';

describe('taskLines', () => {
  it('finds the task lines and how each is written', () => {
    const note = ['# Todo', '', '- [ ] buy milk', '- [x] done thing', '* [X] star bullet', '1. [ ] ordered'].join('\n');
    const tasks = taskLines(note);
    expect(tasks.map((t) => [t.line, t.checked, t.text])).toEqual([
      [2, false, 'buy milk'],
      [3, true, 'done thing'],
      [4, true, 'star bullet'],
      [5, false, 'ordered'],
    ]);
  });

  it('keeps nested items, which carry their own indent', () => {
    const note = '- [x] parent\n  - [ ] child\n';
    expect(taskLines(note).map((t) => t.open)).toEqual(['- [', '  - [']);
  });

  // A checkbox is toggled by index, so anything counted here that marked does
  // not render as a checkbox shifts every later index and ticks the wrong line.
  it('ignores task-looking lines inside a fenced block', () => {
    const note = ['- [ ] real', '', '```sh', '- [ ] not real', '```', '', '- [ ] also real'].join('\n');
    expect(taskLines(note).map((t) => t.text)).toEqual(['real', 'also real']);
  });

  it('ignores lines that only look like tasks', () => {
    const note = ['- [] no space', '- [y] not a marker', 'text - [ ] mid-line', '- [ ] real'].join('\n');
    expect(taskLines(note).map((t) => t.text)).toEqual(['real']);
  });

  it('splits a line so only the marker is rewritten', () => {
    const t = taskLines('- [ ] buy `milk` — today')[0];
    expect(t.open + 'x' + t.close + t.text).toBe('- [x] buy `milk` — today');
  });
});

describe('taskLabel', () => {
  it('strips formatting and keeps link labels', () => {
    expect(plainText('see [the doc](http://x/y) and `code` and **bold**')).toBe('see the doc and code and bold');
  });

  it('cuts at 30 characters, whatever the punctuation', () => {
    // The cut is at exactly 30 characters, which here lands on the em dash.
    expect(taskLabel('**Description**: write the thing — with more text'))
      .toBe('Description: write the thing —…');
    expect(taskLabel('short one')).toBe('short one');
  });
});

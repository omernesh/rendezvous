// COPY_SCRIPT (the done page's Copy buttons) run against a mock DOM through node:vm.
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { COPY_SCRIPT } from '../src/pages.js';

const VALUE = 'https://rendezvous.example/i#abc-DEF_123';

type Clip = 'ok' | 'deny' | 'none';
function setup(clip: Clip) {
  const listeners: Array<[string, () => Promise<void>]> = [];
  const timers: Array<[() => void, number]> = [];
  const written: string[] = [];
  const box = { textContent: VALUE };
  const status = { textContent: '' };
  const button = {
    hidden: true,
    textContent: 'Copy',
    previousElementSibling: box,
    nextElementSibling: status,
    addEventListener: (t: string, f: () => Promise<void>) => listeners.push([t, f]),
  };
  const selection = { removed: 0, ranges: [] as unknown[], removeAllRanges() { this.removed++; }, addRange(r: unknown) { this.ranges.push(r); } };
  const range = { node: null as unknown, selectNodeContents(n: unknown) { this.node = n; } };
  const ctx = {
    document: { querySelectorAll: (q: string) => (q === 'button.copy' ? [button] : []), createRange: () => range },
    navigator: clip === 'none' ? {} : { clipboard: { writeText: async (t: string) => { if (clip === 'deny') throw new Error('NotAllowed'); written.push(t); } } },
    setTimeout: (f: () => void, ms: number) => timers.push([f, ms]),
    getSelection: () => selection,
  };
  vm.runInNewContext(COPY_SCRIPT, ctx);
  return { button, box, status, listeners, timers, written, selection, range };
}

describe('COPY_SCRIPT', () => {
  it('unhides the button and adds one click listener', () => {
    const s = setup('ok');
    expect(s.button.hidden).toBe(false);
    expect(s.listeners.map((l) => l[0])).toEqual(['click']);
  });

  it('writes exactly the previous sibling text, says Copied, and reverts after 2 s', async () => {
    const s = setup('ok');
    await s.listeners[0][1]();
    expect(s.written).toEqual([VALUE]);
    expect(s.status.textContent).toBe('Copied');
    expect(s.button.textContent).toBe('Copied');
    expect(s.timers.map((t) => t[1])).toEqual([2000]);
    s.timers.forEach((t) => t[0]());
    expect(s.status.textContent).toBe('');
    expect(s.button.textContent).toBe('Copy');
  });

  for (const clip of ['deny', 'none'] as const) {
    it(`selects the box and says Press Ctrl+C when the clipboard is ${clip === 'deny' ? 'rejected' : 'missing'}`, async () => {
      const s = setup(clip);
      await s.listeners[0][1]();
      expect(s.written).toEqual([]);
      expect(s.range.node).toBe(s.box);
      expect(s.selection.removed).toBe(1);
      expect(s.selection.ranges).toEqual([s.range]);
      expect(s.status.textContent).toBe('Press Ctrl+C');
      expect(s.timers).toEqual([]);
    });
  }
});

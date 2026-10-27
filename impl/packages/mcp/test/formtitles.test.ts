// Claude Code renders each approval-form field's `title` on one line and cuts it
// off. Titles stay short; the explanation goes in the field's `description`
// (which the form digest covers, like everything else in the properties).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MAX_TITLE = 40;
const SHORT_NAME_MAX = 22; // shortCapName() in server.ts caps the one interpolated capability word
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '../src/server.ts'), 'utf8');

/** Every `title: '...'`, `"..."` or `...` literal in the server, with interpolations counted at their worst case. */
function titles(): Array<{ text: string; worst: number }> {
  const out: Array<{ text: string; worst: number }> = [];
  const re = /\btitle:\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`)/g;
  for (const m of source.matchAll(re)) {
    const text = m[1] ?? m[2] ?? m[3] ?? '';
    const worst = text.replace(/\$\{[^}]*\}/g, '\u0000').split('\u0000').join('x'.repeat(SHORT_NAME_MAX)).length;
    out.push({ text, worst });
  }
  return out;
}

describe('approval form field titles', () => {
  it('finds the titles (the check is not vacuous)', () => {
    expect(titles().length).toBeGreaterThan(20);
  });

  it(`every title is at most ${MAX_TITLE} characters, so the client does not cut it`, () => {
    const long = titles().filter((t) => t.worst > MAX_TITLE);
    expect(long.map((t) => `${t.worst}: ${t.text}`)).toEqual([]);
  });
});

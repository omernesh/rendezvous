// A refused grant stays out of the event log but leaves one stderr line (issue #101, NOTES 95).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, vi } from 'vitest';
import { appendEvents, readEvents } from '../src/events.js';
import { Home } from '../src/home.js';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('refused grant trace', () => {
  it('is not logged as an event, but writes one cleaned stderr line', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rdv-rg-'));
    dirs.push(dir);
    const home = new Home(dir);
    const lines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    });
    const written = await appendEvents(home, [
      { event: 'dropped', reason: 'unexpected or invalid grant', detail: { peer: 'rdv1:abc\nINJECT' } },
      { event: 'dropped', reason: 'contact request' },
    ]);
    if (written.length !== 0 || readEvents(home).length !== 0) throw new Error('a stranger drop was logged');
    if (lines.length !== 1) throw new Error(`want one stderr line, got ${lines.length}`);
    if (!/^rdv: refused a grant: unexpected or invalid grant \(.*rdv1:abc.*\)\n$/.test(lines[0])) throw new Error(`bad line ${JSON.stringify(lines[0])}`);
    if (lines[0].slice(0, -1).includes('\n')) throw new Error('newline injected');
  });
});

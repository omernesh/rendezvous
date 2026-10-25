#!/usr/bin/env node
// Write the demo calendars for next week (PLAN §6.2), relative to today so they
// never go stale. Omer is busy Monday evening, John Monday and Tuesday:
// Omer's agent offers Tue/Wed/Thu 19:00, John's accepts Wednesday 19:00–21:00.
// Event titles are private and must never show up on the other side.
//
//   node demo/make-calendars.mjs [--out demo/calendars] [--tz +02:00]
// Run from impl/ after `npm run build`.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { parseOffset, parseWindow, toSlot } from '@rendezvous/a2a';

const { values } = parseArgs({ options: { out: { type: 'string', default: 'demo/calendars' }, tz: { type: 'string', default: '+02:00' } } });
const off = parseOffset(values.tz);
if (off === null) throw new Error(`--tz must be a fixed offset like +02:00, not ${values.tz}`);
const evenings = parseWindow('next week evenings', { now: new Date(), offsetMinutes: off }).map((s) => toSlot(s, off));
if (evenings.length < 7) throw new Error('expected 7 evenings next week');
const at = (d, from, to) => ({
  start: evenings[d].start.replace('T19:', `T${from}:`),
  end: evenings[d].end.replace('T23:', `T${to}:`),
});
const omer = {
  timezone: values.tz,
  busy: [
    { ...at(0, '19', '23'), title: 'Parents evening at school' },
    { ...at(4, '08', '10'), title: 'Dentist' },
  ],
};
const john = {
  timezone: values.tz,
  busy: [
    { ...at(0, '18', '22'), title: 'Choir rehearsal' },
    { ...at(1, '19', '23'), title: 'Board meeting dinner' },
  ],
};
mkdirSync(values.out, { recursive: true });
writeFileSync(join(values.out, 'omer.json'), JSON.stringify(omer, null, 2) + '\n');
writeFileSync(join(values.out, 'john.json'), JSON.stringify(john, null, 2) + '\n');
console.log(`wrote ${join(values.out, 'omer.json')} and ${join(values.out, 'john.json')} for the week of ${evenings[0].start.slice(0, 10)}`);
console.log(`expected agreement: ${at(2, '19', '21').start} – ${at(2, '19', '21').end}`);

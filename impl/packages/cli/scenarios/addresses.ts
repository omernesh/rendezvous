// Several addresses per agent, changed while it listens (`rdv address`).
//
//   1. Omer: `rdv init` with two emails and a phone, public pointer on; `rdv listen`.
//   2. John probes each address: Omer's listener sees a request for each one.
//   3. Omer adds a phone while listening: the listener re-subscribes, John's probe on it arrives.
//   4. Omer adds a private address: no topic, a probe on it never arrives.
//   5. Omer removes his work email: the listener drops its topic, a probe on it never
//      arrives, and a lookup for it finds no card (the new card replaced the old one).
//
// Run directly against real relays:
//   node packages/cli/dist/scenarios/addresses.js --relay wss://a [--relay wss://b]
import { randomBytes, randomInt } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { relaysFromEnv } from './contact.js';
import { assert, Listener, type Line, rdv } from './harness.js';

export interface AddressScenarioOptions {
  relays: string[];
  stepTimeoutMs?: number;
  /** How long a probe that must not arrive is given to show up anyway. */
  quietMs?: number;
  tag?: string;
  log?: (line: string) => void;
}

export interface AddressScenarioResult {
  steps: Array<{ step: string; ms: number }>;
}

export async function runAddressScenario(opts: AddressScenarioOptions): Promise<AddressScenarioResult> {
  if (opts.relays.length === 0) throw new Error('no relays given');
  const timeout = opts.stepTimeoutMs ?? 20_000;
  const quiet = opts.quietMs ?? 1500;
  const log = opts.log ?? (() => {});
  const tag = opts.tag ?? randomBytes(4).toString('hex');
  // Fictional 555 numbers, random so runs on shared public relays don't see each other.
  const phone = () => `+1555${String(randomInt(0, 10_000_000)).padStart(7, '0')}`;
  const omer = { email: `omer+${tag}@example.com`, work: `omer+${tag}@work.example.com`, phone: phone(), phone2: phone(), secret: `omer+${tag}-private@example.com` };
  const root = mkdtempSync(join(tmpdir(), 'rdv-addresses-'));
  const dirs = { omer: join(root, 'omer'), john: join(root, 'john') };
  const relayArgs = opts.relays.flatMap((r) => ['--relay', r]);
  const steps: AddressScenarioResult['steps'] = [];
  let listener: Listener | undefined;
  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const t0 = Date.now();
    log(`- ${name}`);
    const r = await fn();
    steps.push({ step: name, ms: Date.now() - t0 });
    return r;
  };

  try {
    await step('1. omer: init with two emails and a phone, listen', async () => {
      await rdv(['init', '--profile', 'omer', '--email', omer.email, '--email', omer.work.toUpperCase(), '--phone', omer.phone, '--public-pointer', ...relayArgs], dirs.omer);
      await rdv(['init', '--profile', 'john', '--email', `john+${tag}@doe.com`, ...relayArgs], dirs.john);
      const list = await rdv(['address', 'list'], dirs.omer);
      assert(list.lines.map((l) => l.value).join() === [omer.email, omer.work, omer.phone].join(), 'three canonical addresses, in order');
      assert(list.lines.every((l) => l.public === true), 'all public');
      await rdv(['card', 'publish'], dirs.omer, { timeoutMs: timeout });
      listener = new Listener('omer', dirs.omer);
      const ready = await listener.waitFor((l) => l.event === 'ready', 'omer ready', timeout);
      assert(ready.topics.length === 3, 'listening on three topics');
    });
    const l = listener!;

    // John probes `to`; Omer's listener must see it (then declines it: a sender gets only a few pending at once).
    const reaches = async (to: string) => {
      const sent = await rdv(['contact', 'request', to, '--greeting', `hi ${tag}`], dirs.john, { timeoutMs: timeout });
      const id = sent.lines.find((x) => x.event === 'request-sent')?.id as string;
      const req = await l.waitFor((x) => x.event === 'request' && x.id === id, `the probe on ${to}`, timeout);
      assert(req.to_hint === to, `request for ${to}`);
      await rdv(['contact', 'decline', id], dirs.omer);
    };
    // A probe on `to` must not arrive: send it, then one that must, and check the first never showed up.
    const missed = async (to: string) => {
      const sent = await rdv(['contact', 'request', to, '--greeting', `hi ${tag}`], dirs.john, { timeoutMs: timeout });
      const id = sent.lines.find((x) => x.event === 'request-sent')?.id as string;
      await reaches(omer.email);
      await new Promise((r) => setTimeout(r, quiet));
      assert(!l.lines.some((x: Line) => x.event === 'request' && x.id === id), `no request for ${to}`);
    };

    await step('2. a probe on each address reaches omer', async () => {
      for (const a of [omer.email, omer.work, omer.phone]) await reaches(a);
    });

    await step('3. an address added while listening: re-subscribed live', async () => {
      const add = await rdv(['address', 'add', omer.phone2], dirs.omer, { timeoutMs: timeout });
      assert(add.lines[0]?.event === 'address-added' && add.lines[0].published.length === 5, 'added, card published on 4 address topics + the agent ID');
      const t = await l.waitFor((x) => x.event === 'topics' && x.topics.length === 4, 'listener re-subscribes', timeout);
      assert(t.added.length === 1 && t.removed.length === 0, 'one topic added');
      await reaches(omer.phone2);
    });

    await step('4. a private address opens no topic', async () => {
      const add = await rdv(['address', 'add', omer.secret, '--private'], dirs.omer);
      assert(add.lines[0]?.address.public === false && add.lines[0].published.length === 0, 'private: nothing published');
      await missed(omer.secret);
    });

    await step('5. a removed address: no longer answered, its card replaced', async () => {
      const rm = await rdv(['address', 'remove', omer.work], dirs.omer, { timeoutMs: timeout });
      assert(rm.lines[0]?.event === 'address-removed' && rm.lines[0].published.length === 5, 'removed; new card on 3 topics + the removed one + the agent ID');
      const t = await l.waitFor((x) => x.event === 'topics' && x.removed.length === 1, 'listener drops the topic', timeout);
      assert(t.topics.length === 3, 'three topics left');
      await missed(omer.work);
      const gone = await rdv(['lookup', omer.work], dirs.john, { check: false, timeoutMs: timeout });
      assert(gone.code === 1, 'no card found for the removed address');
      const found = await rdv(['lookup', omer.email], dirs.john, { timeoutMs: timeout });
      const card = found.lines[0]?.card;
      assert(card && !card.discovery.addresses.some((a: { value: string }) => a.value === omer.work), 'the newest card, without the work email');
      // Contacts and the rest are untouched; the agent is the same.
      const who = await rdv(['whoami'], dirs.omer);
      assert(who.lines[0].id === card.id, 'same agent');
    });

    return { steps };
  } finally {
    await listener?.stop();
    rmSync(root, { recursive: true, force: true });
  }
}

// `node dist/scenarios/addresses.js --relay wss://…`
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { relay: { type: 'string', multiple: true }, timeout: { type: 'string' } } });
  const relays = values.relay?.length ? values.relay : relaysFromEnv();
  if (relays.length === 0) {
    console.error('usage: node dist/scenarios/addresses.js --relay wss://… [--relay …] [--timeout ms]');
    process.exit(2);
  }
  runAddressScenario({ relays, stepTimeoutMs: values.timeout ? Number(values.timeout) : 30_000, quietMs: 5000, log: (l) => console.log(l) }).then(
    (r) => {
      for (const s of r.steps) console.log(`  ok  ${s.step} (${s.ms} ms)`);
      console.log(`PASS address scenario on ${relays.join(', ')}`);
      process.exit(0);
    },
    (err: Error) => {
      console.error(`FAIL ${err.message}`);
      process.exit(1);
    },
  );
}

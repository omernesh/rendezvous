// Issue #141, accepting side: only the grant that answers an invite request this agent sent is marked.
import { describe, expect, it } from 'vitest';
import { ContactBook, createCard, createContactRequest, createGrant, generateKey, inviteRef, newInviteSecret } from '../src/index.js';

const hints = [{ type: 'nostr' as const, relay: 'ws://127.0.0.1:1', pref: 1 }];
const setup = () => {
  const me = generateKey();
  const peer = generateKey();
  const book = new ContactBook();
  const request = () => createContactRequest(me, createCard(me, { rendezvous: hints }), { toHint: peer.id, greeting: 'hi' });
  const grant = (req: ReturnType<typeof request>, from = peer) => createGrant(from, createCard(from, { rendezvous: hints }), req, { tier: 'friend', scope: {} });
  return { me, peer, book, request, grant };
};

describe('viaInvite on the accepting side', () => {
  it('marks the grant that answers an invite request, with the time the request stored; survives toJSON/fromJSON', () => {
    const { me, peer, book, request, grant } = setup();
    const ref = inviteRef(newInviteSecret());
    const req = request();
    book.trackOutstanding(req, 'claimed', peer.id, undefined, ref);
    const stored = book.state.outstanding[req.id].sent;
    const out = book.receiveGrant(grant(req), me.id);
    expect(out && 'contact' in out && out.contact.viaInvite).toEqual({ ref, accepted: stored });
    expect(ref).toMatch(/^[0-9a-f]{16}$/);
    const back = new ContactBook(JSON.parse(JSON.stringify(book.toJSON())));
    expect(back.contact(peer.id)?.viaInvite).toEqual({ ref, accepted: stored });
  });

  it('a plain request stays unmarked', () => {
    const { me, peer, book, request, grant } = setup();
    const req = request();
    book.trackOutstanding(req, 'claimed', peer.id);
    const out = book.receiveGrant(grant(req), me.id);
    expect(out && 'contact' in out && out.contact.viaInvite).toBeUndefined();
  });

  it('a grant from a different agent, or a replayed one, marks nothing', () => {
    const { me, peer, book, request, grant } = setup();
    const req = request();
    book.trackOutstanding(req, 'claimed', peer.id, undefined, inviteRef(newInviteSecret()));
    expect(book.receiveGrant(grant(req, generateKey()), me.id)).toBeNull();
    expect(book.contact(peer.id)).toBeUndefined();
    const g = grant(req);
    expect(book.receiveGrant(g, me.id)).not.toBeNull();
    const before = JSON.stringify(book.contact(peer.id));
    expect(book.receiveGrant(g, me.id)).toBeNull();
    expect(JSON.stringify(book.contact(peer.id))).toBe(before);
  });

  it('a later plain request\'s grant does not inherit the old mark', () => {
    const { me, peer, book, request, grant } = setup();
    const first = request();
    book.trackOutstanding(first, 'claimed', peer.id, undefined, inviteRef(newInviteSecret()));
    book.receiveGrant(grant(first), me.id);
    expect(book.contact(peer.id)?.viaInvite).toBeDefined();
    const second = request();
    book.trackOutstanding(second, 'claimed', peer.id);
    const out = book.receiveGrant(grant(second), me.id);
    expect(out && 'contact' in out && out.contact.viaInvite).toBeUndefined();
    expect(book.contact(peer.id)?.viaInvite).toBeUndefined();
  });
});

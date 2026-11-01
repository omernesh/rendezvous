// The invite landing page (/i#<payload>, NOTES 101, 105): reads the invite from the URL fragment, in this browser only,
// and fills in who it is from and the lines to copy. Nothing is sent anywhere; text goes in with textContent only.
// Reads v2 (binary) and v1 (JSON) links. This is a display: the agent that accepts the link checks it in full.
(function () {
  'use strict';
  var MAX = 1024;
  // SPEC 5.2.3: v2's relay bits, fixed for version 2.
  var KNOWN_RELAYS = ['wss://relay.nesher.co', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://relay.nostr.net', 'wss://nostr.oxtr.dev', 'wss://nostr.mom', 'wss://relay.damus.io'];
  var BAD_NAME = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}]/u;
  var EXPIRY_MAX_S = 32503680000; // the year 3000, as the agent
  function byId(id) { return document.getElementById(id); }

  function bytesOf(payload) {
    var b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  // RFC 4648 base32, lowercase, no padding: the agent ID's form (rdv1:<52 characters>).
  function base32(bytes) {
    var abc = 'abcdefghijklmnopqrstuvwxyz234567', out = '', bits = 0, value = 0;
    for (var i = 0; i < bytes.length; i++) {
      value = (value << 8) | bytes[i];
      bits += 8;
      while (bits >= 5) { out += abc[(value >>> (bits - 5)) & 31]; bits -= 5; }
    }
    if (bits > 0) out += abc[(value << (5 - bits)) & 31];
    return out;
  }

  function cleanName(n) {
    return typeof n === 'string' && n.length > 0 && n.length <= 64 && n.trim() === n && !BAD_NAME.test(n) ? n : '';
  }

  function b64url(bytes) {
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  // A custom relay in its one spelling, as the agent requires (lowercase host, no lone "/" path, ASCII).
  function canonRelay(r) {
    if (r.length > 200 || !/^wss?:\/\/[^\s/?#]+[^\s]*$/.test(r)) return null;
    var u = new URL(r);
    if (u.username || u.password || /\.$/.test(u.hostname)) return null;
    var root = u.protocol + '//' + u.host + '/';
    var href = u.href === root ? root.slice(0, -1) : u.href;
    return href.length <= 200 && /^[\x21-\x7e]+$/.test(href) ? href : null;
  }

  // v2: version 2, Ed25519 key (32), secret (16), expiry in Unix minutes (4, big-endian), relay bits (1),
  // then records (1 type, 1 length, bytes: type 1 a relay URL, type 2 the name), then 2 check bytes.
  // The same structure checks as the agent; the 2 check bytes are verified by checkV2 (async: crypto.subtle).
  function decodeV2(b) {
    if (b.length < 56) return null;
    var end = b.length - 2;
    var minutes = b[49] * 0x1000000 + b[50] * 0x10000 + b[51] * 0x100 + b[52];
    if (minutes === 0 || minutes * 60 > EXPIRY_MAX_S || b[53] >= 1 << KNOWN_RELAYS.length) return null;
    var relays = [];
    for (var i = 0; i < KNOWN_RELAYS.length; i++) if (b[53] & (1 << i)) relays.push(KNOWN_RELAYS[i]);
    var name = '', at = 54, utf8 = new TextDecoder('utf-8', { fatal: true });
    while (at < end) {
      var type = b[at], len = b[at + 1];
      if (!len || at + 2 + len > end) return null;
      var value = utf8.decode(b.subarray(at + 2, at + 2 + len));
      if (type === 1 && !name) {
        if (canonRelay(value) !== value || relays.indexOf(value) >= 0 || KNOWN_RELAYS.indexOf(value) >= 0) return null;
        relays.push(value);
      } else if (type === 2 && !name) {
        name = cleanName(value);
        if (!name) return null;
      } else return null;
      at += 2 + len;
    }
    if (relays.length < 1 || relays.length > 3) return null;
    return { agent: 'rdv1:' + base32(b.subarray(1, 33)), expires: new Date(minutes * 60000), name: name };
  }

  function decodeV1(bytes) {
    var p = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!p || typeof p !== 'object' || p.v !== 1) return null;
    if (typeof p.a !== 'string' || !/^rdv1:[a-z2-7]{52}$/.test(p.a)) return null;
    if (typeof p.s !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(p.s)) return null;
    if (typeof p.e !== 'number' || !isFinite(p.e) || p.e <= 0 || p.e > EXPIRY_MAX_S) return null;
    if (!Array.isArray(p.r) || p.r.length === 0) return null;
    return { agent: p.a, expires: new Date(p.e * 1000), name: cleanName(p.n) };
  }

  function decode(payload) {
    if (!payload || payload.length > MAX || !/^[A-Za-z0-9_-]+$/.test(payload)) return null;
    try {
      var bytes = bytesOf(payload);
      // Stray low bits in the last character: not the link the agent made.
      if (b64url(bytes) !== payload) return null;
      if (bytes[0] === 2) return decodeV2(bytes);
      if (bytes[0] === 0x7b) return decodeV1(bytes);
      return null;
    } catch (e) {
      return null;
    }
  }

  // v2's check bytes: the first 2 of SHA-256("rdv1/invite-link\u0000" + everything before them). They catch a link that was
  // cut at a record boundary or had a character changed. Resolves true for v1 (no check bytes) and where there is no
  // crypto.subtle (the agent checks anyway).
  function checkV2(payload) {
    var bytes = bytesOf(payload);
    if (bytes[0] !== 2) return Promise.resolve(true);
    var subtle = typeof crypto !== 'undefined' && crypto.subtle;
    if (!subtle) return Promise.resolve(true);
    var tag = new TextEncoder().encode('rdv1/invite-link\u0000');
    var all = new Uint8Array(tag.length + bytes.length - 2);
    all.set(tag);
    all.set(bytes.subarray(0, bytes.length - 2), tag.length);
    return subtle.digest('SHA-256', all).then(function (d) {
      var h = new Uint8Array(d);
      return h[0] === bytes[bytes.length - 2] && h[1] === bytes[bytes.length - 1];
    }, function () { return true; });
  }

  // Outside a browser (the repo's tests), only hand over the decoder.
  if (typeof document === 'undefined') {
    if (typeof globalThis !== 'undefined') {
      globalThis.rdvInviteDecode = decode;
      globalThis.rdvInviteCheck = checkV2;
    }
    return;
  }

  function show(inv, hash) {
    var link = window.location.origin + '/i#' + hash;
    var fp = 'rdv1:' + inv.agent.slice(5, 9) + '…' + inv.agent.slice(-4);

    if (inv.name) {
      byId('invite-title').textContent = inv.name + ' invites you to connect your AI agent';
      document.title = inv.name + ' invites you | Rendezvous';
    }
    byId('invite-fp').textContent = fp;
    byId('invite-name').textContent = inv.name || '(none)';
    byId('invite-expires').textContent = inv.expires.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    byId('invite-facts').hidden = false;
    if (inv.expires.getTime() <= Date.now()) byId('invite-expired').hidden = false;

    var sentence = 'Accept my Rendezvous invite ' + link;
    byId('invite-sentence').textContent = sentence;
    byId('invite-claude-line').textContent =
      'claude plugin marketplace add omernesh/rendezvous; claude plugin install rendezvous@rendezvous; claude "' + sentence + '"';
    byId('invite-terminal-line').textContent = 'rdv init --profile yourname --invite "' + link + '"';
  }

  var hash = window.location.hash.replace(/^#/, '');
  if (!hash) return; // no invite: the page reads as general instructions
  var inv = decode(hash);
  if (!inv) {
    byId('invite-broken').hidden = false;
    return;
  }
  checkV2(hash).then(function (ok) {
    if (ok) show(inv, hash);
    else byId('invite-broken').hidden = false;
  });
})();

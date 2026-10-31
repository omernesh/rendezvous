// The invite landing page (/i#<payload>, NOTES 101): reads the invite from the URL fragment, in this browser only,
// and fills in who it is from and the lines to copy. Nothing is sent anywhere; text goes in with textContent only.
(function () {
  'use strict';
  var MAX = 1024;
  function byId(id) { return document.getElementById(id); }

  function decode(payload) {
    if (!payload || payload.length > MAX || !/^[A-Za-z0-9_-]+$/.test(payload)) return null;
    try {
      var b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      var bin = atob(b64);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      var p = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!p || typeof p !== 'object' || p.v !== 1) return null;
      if (typeof p.a !== 'string' || !/^rdv1:[a-z2-7]{52}$/.test(p.a)) return null;
      if (typeof p.s !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(p.s)) return null;
      if (typeof p.e !== 'number' || !isFinite(p.e) || p.e <= 0) return null;
      if (!Array.isArray(p.r) || p.r.length === 0) return null;
      var name = typeof p.n === 'string' && p.n.length <= 64 && !/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(p.n) ? p.n.trim() : '';
      return { agent: p.a, expires: new Date(p.e * 1000), name: name };
    } catch (e) {
      return null;
    }
  }

  var hash = window.location.hash.replace(/^#/, '');
  if (!hash) return; // no invite: the page reads as general instructions
  var inv = decode(hash);
  if (!inv) {
    byId('invite-broken').hidden = false;
    return;
  }
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
})();

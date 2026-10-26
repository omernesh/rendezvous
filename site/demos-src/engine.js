// Rendezvous chat demos: a deterministic timeline. seek(t) rebuilds the stage for time t (seconds),
// so render.mjs can film any frame exactly; play() runs it live in a browser for previewing.
(function () {
  'use strict';
  var T0 = 1.9; // the title card holds the first T0 seconds; script times are after it
  var TAIL = 0.9;

  var MARK = '<svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><path class="mk-a" d="M18.98 27.11A11.5 11.5 0 0 1 4.89 13.02"/><path class="mk-a" d="M13.02 4.89A11.5 11.5 0 0 1 27.11 18.98"/><path class="mk-d" d="M16 10.6Q16.6 10.6 17 11L21 15Q21.4 15.4 21.4 16Q21.4 16.6 21 17L17 21Q16.6 21.4 16 21.4Q15.4 21.4 15 21L11 17Q10.6 16.6 10.6 16Q10.6 15.4 11 15L15 11Q15.4 10.6 16 10.6Z"/></svg>';
  var LOCK = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
  var CHECK = '<svg class="ok" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  var CHECK_PLAIN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  var SEND = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6"/></svg>';
  var RELAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8M8.5 8.5a4.5 4.5 0 0 0 0 7M15.5 8.5a4.5 4.5 0 0 1 0 7"/></svg>';
  var CURSOR = '<svg class="cursor" viewBox="0 0 18 22" aria-hidden="true"><path d="M1 1l15 11.5-6.6 1.1 3.9 7.3-2.6 1.3-3.9-7.4L1.5 19z" fill="#fff" stroke="#111" stroke-width="1.3" stroke-linejoin="round"/></svg>';

  function clamp(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
  function easeOut(x) { x = clamp(x); return 1 - Math.pow(1 - x, 3); }
  function easeInOut(x) { x = clamp(x); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }

  function typeDur(ev) { return ev.paste ? 0.55 : Math.min(ev.text.length / 40, 1.4); }

  function Scene(def, root) {
    this.def = def;
    this.root = root;
    var k = def.pace || 1; // pace < 1 tightens a whole script without retiming every line
    this.duration = T0 + def.length * k + TAIL;
    this.events = def.events.map(function (e) { var c = Object.assign({}, e); c.t = e.t * k + T0; return c; });
    this.build();
  }

  Scene.prototype.build = function () {
    var d = this.def;
    var s = el('div', 'stage layout-' + d.layout);
    s.innerHTML =
      '<svg class="rings" viewBox="0 0 800 800" aria-hidden="true"><circle cx="400" cy="400" r="130"/><circle cx="400" cy="400" r="250"/><circle cx="400" cy="400" r="370"/></svg>' +
      '<div class="band">' + MARK + '<span class="word">rendezvous</span><span class="sep"></span><span class="title">' + esc(d.title) + '</span><span class="tag">' + esc(d.tag) + '</span></div>';
    var self = this;
    this.panes = {};
    Object.keys(d.panes).forEach(function (k) {
      var p = d.panes[k];
      if (p.kind === 'term') {
        var t = el('div', 'term', '<div class="tbar"><i></i><i></i><i></i><span>' + esc(p.title) + '</span></div><div class="tbody"></div>');
        s.appendChild(t);
        self.panes[k] = { def: p, node: t, body: t.querySelector('.tbody') };
        return;
      }
      var w = el('div', 'win ' + k,
        '<div class="wbar"><span class="avatar ' + (p.initial === 'J' ? 'j' : '') + '">' + p.initial + '</span><div><div class="who">' + esc(p.title) + '</div><div class="sub">' + esc(p.sub) + '</div></div></div>' +
        '<div class="msgs"></div>' +
        '<div class="comp"><div class="field"></div><span class="send">' + SEND + '</span></div>');
      s.appendChild(w);
      self.panes[k] = { def: p, node: w, msgs: w.querySelector('.msgs'), field: w.querySelector('.field'), bar: w.querySelector('.wbar') };
    });
    if (d.layout === 'split') {
      var lane = el('div', 'lane', '<div class="line"></div><div class="relay"><div class="disc">' + RELAY + '</div>relay<br>sees ciphertext</div>');
      s.appendChild(lane);
      this.lane = lane;
    }
    if (d.layout === 'trio') {
      // Three agents in one group: the relay is a strip under the panes; a sealed copy goes to each other member.
      var strip = el('div', 'lane lane-trio', '<div class="plabel"></div><div class="line"></div><div class="relay"><div class="disc">' + RELAY + '</div>relay sees ciphertext</div>');
      s.appendChild(strip);
      this.lane = strip;
    }
    this.cursor = el('div', null, CURSOR).firstChild;
    this.cursor.style.display = 'none';
    s.appendChild(this.cursor);
    this.title = el('div', 'titlecard', MARK + '<div class="k">' + esc(d.tag) + '</div><h1>' + esc(d.title) + '</h1><p>' + esc(d.blurb) + '</p>');
    s.appendChild(this.title);
    this.fadeEl = el('div', 'fade');
    s.appendChild(this.fadeEl);
    this.stage = s;
    this.root.innerHTML = '';
    this.root.appendChild(s);
  };

  // ---- one chat pane --------------------------------------------------------
  Scene.prototype.renderChat = function (key, t) {
    var pane = this.panes[key];
    var evs = this.events.filter(function (e) { return e.p === key; });
    var items = [];
    var composer = null;
    var lockOn = false;
    var forms = [];
    evs.forEach(function (e) {
      if (e.t > t) return;
      var age = t - e.t;
      switch (e.k) {
        case 'user': {
          var td = typeDur(e);
          if (age < td + 0.25) composer = e.text.slice(0, Math.round(e.text.length * clamp(age / td)));
          if (age >= td + 0.25) items.push({ at: e.t + td + 0.25, cls: 'user', html: '<div class="bubble">' + (e.html || esc(e.text)) + '</div>' });
          break;
        }
        case 'agent':
          items.push({ at: e.t, cls: 'agent', html: '<div class="bubble">' + e.html + '</div>' });
          break;
        case 'typing':
          if (age < e.d) items.push({ at: e.t, cls: 'agent typing', html: '<div class="bubble"><i></i><i></i><i></i></div>', bounce: age });
          break;
        case 'tool': {
          var done = age >= (e.d || 0.9);
          items.push({
            at: e.t,
            cls: 'toolrow',
            html: '<span class="tool' + (e.wait ? ' wait' : '') + '">' + (done ? CHECK : '<span class="spin" style="transform:rotate(' + Math.round(age * 540) + 'deg)"></span>') +
              '<span class="nm">' + esc(e.name) + '</span>' + (e.args ? '<span class="args">' + esc(e.args) + '</span>' : '') +
              (done && e.res ? '<span class="res">→ ' + esc(e.res) + '</span>' : '') + '</span>',
          });
          break;
        }
        case 'note':
          items.push({ at: e.t, cls: 'note' + (e.info ? ' info' : ''), html: '<span>' + (e.info ? '' : LOCK) + e.html + '</span>' });
          break;
        case 'lock':
          lockOn = true;
          break;
        case 'form':
          if (age < e.d) forms.push({ e: e, age: age });
          break;
      }
    });
    items.sort(function (a, b) { return a.at - b.at; });

    // header lock badge
    var badge = pane.bar.querySelector('.lock');
    if (lockOn && !badge) pane.bar.appendChild(el('span', 'lock', LOCK + '<span class="lt">end-to-end encrypted</span><span class="ls">E2E</span>'));

    // composer
    pane.field.innerHTML = composer == null
      ? '<span class="ph">Message your agent…</span>'
      : '<span class="txt"><span>' + esc(composer) + '</span></span><span class="caret" style="opacity:' + (Math.floor(t * 2.4) % 2 === 0 || composer.length < 999 ? 1 : 0) + '"></span>';

    // messages, each growing in over 0.32 s
    pane.msgs.innerHTML = '';
    var nodes = items.map(function (it) {
      var item = el('div', 'item ' + it.cls);
      var inner = el('div', 'in', it.html);
      item.appendChild(inner);
      pane.msgs.appendChild(item);
      if (it.bounce != null) {
        Array.prototype.forEach.call(inner.querySelectorAll('i'), function (dot, i) {
          var ph = (it.bounce * 3 - i * 0.18) % 1;
          dot.style.transform = 'translateY(' + (-3 * Math.max(0, Math.sin(ph * Math.PI * 2))).toFixed(2) + 'px)';
          dot.style.opacity = 0.55 + 0.45 * Math.max(0, Math.sin(ph * Math.PI * 2));
        });
      }
      return { item: item, inner: inner, age: t - it.at };
    });
    nodes.forEach(function (n) {
      if (n.age >= 0.32) return;
      var e = easeOut(n.age / 0.32);
      var h = n.inner.offsetHeight;
      n.item.style.height = (h * e).toFixed(2) + 'px';
      n.inner.style.opacity = e.toFixed(3);
      n.inner.style.transform = 'translateY(' + ((1 - e) * 10).toFixed(2) + 'px)';
    });

    // consent form
    var old = pane.node.querySelector('.scrim');
    if (old) old.remove();
    forms.forEach(function (f) { this.renderForm(pane, f.e, f.age); }, this);
  };

  Scene.prototype.renderForm = function (pane, e, age) {
    var fadeIn = easeOut(age / 0.3);
    var fadeOut = 1 - easeOut((age - (e.d - 0.3)) / 0.3);
    var vis = Math.min(fadeIn, fadeOut);
    var checked = age >= e.tChk;
    var pressed = age >= e.tBtn && age < e.tBtn + 0.18;
    var rows = (e.rows || []).map(function (r) { return '<dt>' + esc(r[0]) + '</dt><dd>' + r[1] + '</dd>'; }).join('');
    var scrim = el('div', 'scrim',
      '<div class="form"><div class="fh">' + MARK + 'Approval form<span class="only">only you see this</span></div>' +
      '<div class="fb"><h4>' + esc(e.title) + '</h4><dl>' + rows + '</dl>' +
      (e.extra ? '<div class="note2">' + e.extra + '</div>' : '') +
      (e.label != null ? '<div class="lbl">Local label: how your assistant finds them</div><div class="inp">' + esc(e.label) + '</div>' : '') +
      '<div class="chk"><span class="box' + (checked ? ' on' : '') + '">' + (checked ? CHECK_PLAIN : '') + '</span>' + esc(e.chk) + '</div></div>' +
      '<div class="fa"><span class="btn">Decline</span><span class="btn go' + (pressed ? ' press' : '') + '">' + esc(e.btn || 'Submit') + '</span></div></div>');
    scrim.style.opacity = vis.toFixed(3);
    scrim.firstChild.style.transform = 'translateY(' + ((1 - fadeIn) * 14).toFixed(2) + 'px) scale(' + (0.97 + 0.03 * fadeIn).toFixed(4) + ')';
    pane.node.appendChild(scrim);
    this.formCursor = { scrim: scrim, e: e, age: age, vis: vis };
  };

  Scene.prototype.renderCursor = function () {
    var c = this.cursor;
    var fc = this.formCursor;
    if (!fc) { c.style.display = 'none'; return; }
    var sr = this.stage.getBoundingClientRect();
    function centre(node) { var r = node.getBoundingClientRect(); return { x: r.left - sr.left + r.width / 2, y: r.top - sr.top + r.height / 2 }; }
    var box = centre(fc.scrim.querySelector('.box'));
    var btn = centre(fc.scrim.querySelector('.btn.go'));
    var start = { x: btn.x + 90, y: btn.y + 70 };
    var e = fc.e, a = fc.age, p;
    if (a < e.tChk - 0.75) p = start;
    else if (a < e.tChk - 0.05) p = lerp(start, box, easeInOut((a - (e.tChk - 0.75)) / 0.7));
    else if (a < e.tBtn - 0.75) p = box;
    else if (a < e.tBtn - 0.05) p = lerp(box, btn, easeInOut((a - (e.tBtn - 0.75)) / 0.7));
    else p = btn;
    function lerp(p0, p1, k) { return { x: p0.x + (p1.x - p0.x) * k, y: p0.y + (p1.y - p0.y) * k }; }
    var click = (a >= e.tChk - 0.05 && a < e.tChk + 0.12) || (a >= e.tBtn - 0.05 && a < e.tBtn + 0.12);
    c.style.display = 'block';
    c.style.left = (p.x - 3).toFixed(2) + 'px';
    c.style.top = (p.y - 2).toFixed(2) + 'px';
    c.style.opacity = fc.vis.toFixed(3);
    c.style.transform = click ? 'scale(0.86)' : 'none';
  };

  // ---- terminal ---------------------------------------------------------------
  Scene.prototype.renderTerm = function (key, t) {
    var pane = this.panes[key];
    var show = this.events.filter(function (e) { return e.p === key && e.k === 'show'; })[0];
    var vis = show ? easeOut((t - show.t) / 0.45) : 1;
    pane.node.style.opacity = vis.toFixed(3);
    pane.node.style.transform = 'translateX(' + ((1 - vis) * 40).toFixed(2) + 'px)';
    var html = '';
    var typingNow = false;
    this.events.forEach(function (e) {
      if (e.p !== key || e.t > t) return;
      var age = t - e.t;
      if (e.k === 'cmd') {
        var n = Math.round(e.text.length * clamp(age / (e.text.length / 34)));
        typingNow = n < e.text.length;
        html += '<div><span class="p">$ </span>' + esc(e.text.slice(0, n)) + (typingNow ? '<span class="tcaret"></span>' : '') + '</div>';
      } else if (e.k === 'out') {
        html += '<div class="' + (e.cls || '') + '">' + e.html + '</div>';
      }
    });
    if (!typingNow) html += '<div><span class="p">$ </span><span class="tcaret" style="opacity:' + (Math.floor(t * 2.2) % 2 ? 0 : 1) + '"></span></div>';
    pane.body.innerHTML = html;
  };

  // ---- relay lane -------------------------------------------------------------
  Scene.prototype.renderLane = function (t) {
    var lane = this.lane;
    if (this.def.layout === 'trio') { this.renderTrioLane(t); return; }
    Array.prototype.forEach.call(lane.querySelectorAll('.packet,.plabel'), function (n) { n.remove(); });
    this.events.forEach(function (e) {
      if (e.p !== 'lane' || e.t > t) return;
      var age = t - e.t, D = 1.5;
      if (age > D) return;
      var k = easeInOut(age / D);
      var x = e.from === 'a' ? -70 + k * 186 : 116 - k * 186;
      var op = Math.min(clamp(age / 0.2), clamp((D - age) / 0.2));
      var pk = el('div', 'packet' + (e.blue ? ' blue' : ''));
      pk.style.left = x.toFixed(2) + 'px';
      pk.style.opacity = op.toFixed(3);
      lane.appendChild(pk);
      var lb = el('div', 'plabel', e.label);
      lb.style.opacity = op.toFixed(3);
      lane.appendChild(lb);
    });
  };

  // The group lane: one signed message leaves the sender sealed once per recipient (SPEC 7.8.3), so two chips
  // go to the relay and on to the two other members. Column centres are the panes' centres in lane pixels.
  var COLX = { a: 100, b: 360, c: 620 }; // relative to the strip, which starts 20 px in from the stage edge
  Scene.prototype.renderTrioLane = function (t) {
    var lane = this.lane;
    Array.prototype.forEach.call(lane.querySelectorAll('.packet'), function (n) { n.remove(); });
    var label = lane.querySelector('.plabel');
    var text = '', lop = 0;
    this.events.forEach(function (e) {
      if (e.p !== 'lane' || e.t > t) return;
      var age = t - e.t, D = 1.8;
      if (age > D) return;
      var f = e.from, others = e.to ? [e.to] : ['a', 'b', 'c'].filter(function (k) { return k !== f; });
      var spread = others.length > 1 ? 7 : 0; // two chips side by side when the message is sealed twice
      var k1 = easeInOut(clamp(age / 0.8)), k2 = easeInOut(clamp((age - 0.8) / 0.8));
      var op = Math.min(clamp(age / 0.2), clamp((D - age) / 0.25));
      var mid = 360;
      others.forEach(function (o, i) {
        var off = i ? spread : -spread;
        var x = age < 0.8 ? COLX[f] + (mid - COLX[f]) * k1 + off * k1 : mid + off + (COLX[o] - mid - off) * k2;
        var pk = el('div', 'packet blue');
        pk.style.left = (x - 11).toFixed(2) + 'px';
        pk.style.opacity = op.toFixed(3);
        lane.appendChild(pk);
      });
      text = e.label;
      lop = op;
    });
    label.innerHTML = text;
    label.style.opacity = lop.toFixed(3);
  };

  Scene.prototype.seek = function (t) {
    this.formCursor = null;
    var self = this;
    Object.keys(this.panes).forEach(function (k) {
      if (self.panes[k].def.kind === 'term') self.renderTerm(k, t);
      else self.renderChat(k, t);
    });
    if (this.lane) this.renderLane(t);
    this.renderCursor();
    var tc = 1 - easeOut((t - (T0 - 0.45)) / 0.45);
    this.title.style.opacity = tc.toFixed(3);
    this.title.style.display = tc <= 0 ? 'none' : 'flex';
    var f = Math.max(clamp((t - (this.duration - 0.5)) / 0.5), 0);
    this.fadeEl.style.opacity = f.toFixed(3);
  };

  window.RDV = {
    T0: T0,
    mount: function (def, root) { return new Scene(def, root); },
    find: function (id) { return (window.RDV_SCENES || []).filter(function (s) { return s.id === id; })[0]; },
  };
})();

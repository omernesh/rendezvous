// Rendezvous site: copy buttons, install tabs, card flip, theme toggle. No dependencies.
(function () {
  'use strict';
  var live = document.getElementById('live');
  function announce(msg) {
    if (!live) return;
    live.textContent = '';
    setTimeout(function () { live.textContent = msg; }, 30);
  }

  // ---- copy buttons on every command ------------------------------------
  var SVG_NS = 'http://www.w3.org/2000/svg';
  // Builds a small stroked icon from constant path data (no HTML parsing).
  function icon(cls, shapes) {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.setAttribute('class', cls);
    shapes.forEach(function (s) {
      var el = document.createElementNS(SVG_NS, s[0]);
      Object.keys(s[1]).forEach(function (k) { el.setAttribute(k, s[1][k]); });
      svg.appendChild(el);
    });
    return svg;
  }
  function copyIcon() {
    return icon('i-copy', [
      ['rect', { x: '8', y: '8', width: '12', height: '12', rx: '2' }],
      ['path', { d: 'M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2' }],
    ]);
  }
  function doneIcon() {
    return icon('i-done', [['path', { d: 'M5 12.5l4.5 4.5L19 7.5' }]]);
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.className = 'sr-only';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      if (ok) resolve(); else reject(new Error('copy failed'));
    });
  }

  Array.prototype.forEach.call(document.querySelectorAll('.cmd, .codeblock'), function (block) {
    var code = block.querySelector('code');
    if (!code) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'copy';
    btn.setAttribute('aria-label', block.classList.contains('codeblock') ? 'Copy code' : 'Copy command');
    var label = document.createElement('span');
    label.className = 'copy-label';
    label.textContent = 'Copy';
    btn.appendChild(copyIcon());
    btn.appendChild(doneIcon());
    btn.appendChild(label);
    var timer = null;
    btn.addEventListener('click', function () {
      copyText(code.textContent).then(function () {
        btn.classList.add('done');
        label.textContent = 'Copied';
        announce('Copied to the clipboard');
        clearTimeout(timer);
        timer = setTimeout(function () {
          btn.classList.remove('done');
          label.textContent = 'Copy';
        }, 1800);
      }, function () {
        var range = document.createRange();
        range.selectNodeContents(code);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        announce('Copy is blocked here. The command is selected: press Ctrl+C or Cmd+C.');
      });
    });
    block.appendChild(btn);
  });

  // ---- tabs (WAI-ARIA tabs pattern), synced across both install blocks ---
  var tabGroups = Array.prototype.slice.call(document.querySelectorAll('[data-tabs]'));
  // A selection only touches the groups that offer it (OS tabs sync; the setup mode tabs stand alone).
  function selectOs(os, focusGroup) {
    tabGroups.forEach(function (group) {
      if (!group.querySelector('[role="tab"][data-os="' + os + '"]')) return;
      Array.prototype.forEach.call(group.querySelectorAll('[role="tab"]'), function (tab) {
        var on = tab.getAttribute('data-os') === os;
        tab.setAttribute('aria-selected', on ? 'true' : 'false');
        tab.tabIndex = on ? 0 : -1;
        document.getElementById(tab.getAttribute('aria-controls')).hidden = !on;
        if (on && group === focusGroup) tab.focus();
      });
    });
  }
  tabGroups.forEach(function (group) {
    var tabs = Array.prototype.slice.call(group.querySelectorAll('[role="tab"]'));
    tabs.forEach(function (tab, i) {
      tab.addEventListener('click', function () { selectOs(tab.getAttribute('data-os'), null); });
      tab.addEventListener('keydown', function (e) {
        var next = null;
        if (e.key === 'ArrowRight') next = tabs[(i + 1) % tabs.length];
        else if (e.key === 'ArrowLeft') next = tabs[(i - 1 + tabs.length) % tabs.length];
        else if (e.key === 'Home') next = tabs[0];
        else if (e.key === 'End') next = tabs[tabs.length - 1];
        if (next) { e.preventDefault(); selectOs(next.getAttribute('data-os'), group); }
      });
    });
  });
  var ua = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent || '';
  if (/win/i.test(ua)) selectOs('win', null);

  // ---- calling card flip --------------------------------------------------
  var flip = document.querySelector('.flip');
  var card = document.querySelector('.calling-card');
  if (flip && card) {
    var front = card.querySelector('.cc-front');
    var back = card.querySelector('.cc-back');
    var backPre = back.querySelector('pre');
    function setFace(showBack) {
      card.setAttribute('data-face', showBack ? 'back' : 'front');
      flip.setAttribute('aria-pressed', showBack ? 'true' : 'false');
      flip.textContent = showBack ? 'Turn it back' : 'Turn the card over';
      front.setAttribute('aria-hidden', showBack ? 'true' : 'false');
      back.setAttribute('aria-hidden', showBack ? 'false' : 'true');
      backPre.tabIndex = showBack ? 0 : -1;
    }
    setFace(false);
    flip.addEventListener('click', function () { setFace(card.getAttribute('data-face') !== 'back'); });
  }

  // ---- theme toggle: system -> light -> dark -> system ---------------------
  var toggle = document.querySelector('.theme-toggle');
  var root = document.documentElement;
  function current() { return root.getAttribute('data-theme') || 'system'; }
  function apply(mode) {
    if (mode === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', mode);
    toggle.setAttribute('aria-label', 'Color theme: ' + mode);
    toggle.setAttribute('data-mode', mode);
    try {
      if (mode === 'system') localStorage.removeItem('rdv-theme'); else localStorage.setItem('rdv-theme', mode);
    } catch (e) { /* not persisted; still applied for this visit */ }
  }
  if (toggle) {
    toggle.setAttribute('data-mode', current());
    toggle.setAttribute('aria-label', 'Color theme: ' + current());
    toggle.addEventListener('click', function () {
      var order = ['system', 'light', 'dark'];
      var next = order[(order.indexOf(current()) + 1) % order.length];
      apply(next);
      announce('Color theme: ' + next);
    });
  }
})();

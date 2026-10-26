// index.html?scene=<id> plays a scene live; &t=<s> freezes it at one time; &capture=1 leaves
// it to render.mjs, which calls window.seek(t) per frame.
(function () {
  'use strict';
  var qs = new URLSearchParams(location.search);
  var id = qs.get('scene') || window.RDV_SCENES[0].id;
  var def = window.RDV.find(id);
  var scene = window.RDV.mount(def, document.getElementById('root'));
  window.sceneDuration = scene.duration;
  window.seek = function (t) { scene.seek(t); };
  var dev = document.getElementById('dev');
  if (qs.get('capture')) { dev.remove(); scene.seek(0); return; }
  window.RDV_SCENES.forEach(function (s) {
    var a = document.createElement('a');
    a.href = '?scene=' + s.id;
    a.textContent = s.id;
    dev.appendChild(a);
  });
  if (qs.get('t') != null) { scene.seek(parseFloat(qs.get('t'))); return; }
  var start = performance.now();
  (function tick(now) {
    scene.seek(((now - start) / 1000) % scene.duration);
    requestAnimationFrame(tick);
  })(start);
})();

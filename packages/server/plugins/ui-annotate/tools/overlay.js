/* UI Annotate overlay — drop into ANY web page:
 *   <script src="http://127.0.0.1:<port>/overlay.js"></script>      (or use the dashboard's bookmarklet)
 * A floating toolbar toggles "Annotate" mode: hover highlights an element, click opens a comment box,
 * Save posts {selector, text, rect, url, comment} to the collector this script was loaded from.
 * Browse mode (default) leaves the page fully clickable. Optional: data-session="name" on the script tag. */
(function () {
  if (window.__uiAnnotate) return window.__uiAnnotate.toggleToolbar();
  var scriptEl = document.currentScript;
  var BASE = (scriptEl && scriptEl.src ? new URL(scriptEl.src) : new URL('http://127.0.0.1')).origin;
  var SESSION = (scriptEl && scriptEl.getAttribute('data-session')) || 'default';
  var annotating = false, hovered = null, pending = null, pins = [];

  var host = document.createElement('div');
  host.id = '__ui-annotate-host';
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;top:0;left:0;width:0;height:0';
  var root = host.attachShadow({ mode: 'open' });
  root.innerHTML =
    '<style>' +
    ':host{font:13px/1.4 system-ui,sans-serif}' +
    '.bar{position:fixed;right:12px;bottom:12px;display:flex;gap:6px;align-items:center;background:#1c2330;color:#fff;' +
    'padding:6px 8px;border-radius:10px;box-shadow:0 4px 18px rgba(0,0,0,.35)}' +
    'button{font:inherit;border:0;border-radius:6px;padding:4px 10px;cursor:pointer;background:#374157;color:#fff}' +
    'button.on{background:#2563eb}button.primary{background:#2563eb}' +
    '.hl{position:fixed;pointer-events:none;border:2px solid #2563eb;background:rgba(37,99,235,.12);border-radius:3px}' +
    '.pin{position:fixed;width:20px;height:20px;margin:-10px 0 0 -10px;border-radius:50%;background:#d97706;color:#fff;' +
    'font-size:11px;font-weight:600;display:flex;align-items:center;justify-content:center;cursor:default}' +
    '.pin.resolved{background:#16a34a}' +
    '.box{position:fixed;width:300px;background:#fff;color:#1c2330;border-radius:10px;padding:10px;' +
    'box-shadow:0 6px 24px rgba(0,0,0,.35)}' +
    '.box small{display:block;color:#68707f;margin-bottom:6px;word-break:break-all}' +
    'textarea{width:100%;height:70px;box-sizing:border-box;font:inherit;border:1px solid #dde1e8;border-radius:6px;padding:6px}' +
    '.row{display:flex;gap:6px;justify-content:flex-end;margin-top:6px}' +
    '.row button:first-child{background:#e5e8ee;color:#1c2330}' +
    '.msg{font-size:12px;opacity:.85}' +
    '</style>' +
    '<div class="hl" hidden></div><div class="pins"></div>' +
    '<div class="bar"><button class="mode">Annotate</button><span class="msg"></span><button class="close" title="Hide toolbar">×</button></div>';
  document.documentElement.appendChild(host);
  var hl = root.querySelector('.hl'), pinsEl = root.querySelector('.pins'), modeBtn = root.querySelector('.mode');
  var msg = root.querySelector('.msg'), bar = root.querySelector('.bar');

  function inOverlay(el) { return el === host || host.contains(el); }
  function say(t) { msg.textContent = t || ''; }

  function selectorFor(el) {
    var parts = [];
    while (el && el.nodeType === 1 && el !== document.documentElement) {
      var attr = el.getAttribute('data-testid') || el.getAttribute('data-test');
      if (attr) { parts.unshift(el.tagName.toLowerCase() + '[data-testid="' + attr + '"]'); break; }
      if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) { parts.unshift('#' + CSS.escape(el.id)); break; }
      var tag = el.tagName.toLowerCase(), i = 1, sib = el;
      while ((sib = sib.previousElementSibling)) if (sib.tagName === el.tagName) i++;
      var aria = el.getAttribute('aria-label');
      parts.unshift(tag + (aria ? '[aria-label="' + aria.replace(/"/g, '\\"') + '"]' : ':nth-of-type(' + i + ')'));
      el = el.parentElement;
    }
    return parts.join(' > ');
  }

  function api(method, path, body) {
    return fetch(BASE + path, {
      method: method, headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) { return r.json(); });
  }

  function place(rect) {
    hl.hidden = !rect;
    if (!rect) return;
    hl.style.left = rect.left + 'px'; hl.style.top = rect.top + 'px';
    hl.style.width = rect.width + 'px'; hl.style.height = rect.height + 'px';
  }

  function onMove(e) {
    if (!annotating || pending) return;
    var el = e.target;
    if (inOverlay(el)) { hovered = null; place(null); return; }
    hovered = el; place(el.getBoundingClientRect());
  }

  function onClick(e) {
    if (!annotating || pending || inOverlay(e.target)) return;
    e.preventDefault(); e.stopPropagation();
    openBox(e.target, e.clientX, e.clientY);
  }

  function openBox(el, x, y) {
    var r = el.getBoundingClientRect(), sel = selectorFor(el);
    place(r);
    var box = document.createElement('div');
    box.className = 'box';
    box.style.left = Math.max(8, Math.min(x + 12, window.innerWidth - 316)) + 'px';
    box.style.top = Math.max(8, Math.min(y + 12, window.innerHeight - 170)) + 'px';
    var hint = document.createElement('small'); hint.textContent = sel;
    var ta = document.createElement('textarea'); ta.placeholder = 'What is wrong / what should change here?';
    var row = document.createElement('div'); row.className = 'row';
    var cancel = document.createElement('button'); cancel.textContent = 'Cancel';
    var save = document.createElement('button'); save.className = 'primary'; save.textContent = 'Save';
    row.appendChild(cancel); row.appendChild(save);
    box.appendChild(hint); box.appendChild(ta); box.appendChild(row);
    root.appendChild(box);
    pending = box; ta.focus();
    function close() { box.remove(); pending = null; place(null); }
    cancel.onclick = close;
    ta.onkeydown = function (ev) {
      ev.stopPropagation();
      if (ev.key === 'Escape') close();
      if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) save.click();
    };
    save.onclick = function () {
      var comment = ta.value.trim();
      if (!comment) { ta.focus(); return; }
      save.disabled = true;
      api('POST', '/api/annotations', {
        session: SESSION, url: location.href, title: document.title, selector: sel, tag: el.tagName.toLowerCase(),
        text: (el.innerText || el.getAttribute('aria-label') || el.getAttribute('alt') || '').trim().slice(0, 300),
        comment: comment, rect: { x: r.left, y: r.top, w: r.width, h: r.height },
        viewport: { w: window.innerWidth, h: window.innerHeight },
      }).then(function () { close(); say('Saved'); loadPins(); })
        .catch(function () { save.disabled = false; say('Collector unreachable'); });
    };
  }

  function loadPins() {
    api('GET', '/api/annotations?session=' + encodeURIComponent(SESSION)).then(function (res) {
      pinsEl.textContent = ''; pins = [];
      (res.annotations || []).filter(function (a) { return a.url === location.href; }).forEach(function (a) {
        var el; try { el = document.querySelector(a.selector); } catch (e) { el = null; }
        if (!el) return;
        var p = document.createElement('div');
        p.className = 'pin' + (a.status === 'resolved' ? ' resolved' : '');
        p.textContent = a.id; p.title = a.comment;
        pinsEl.appendChild(p); pins.push({ el: el, pin: p });
      });
      layoutPins();
    }).catch(function () { say('Collector unreachable'); });
  }
  function layoutPins() {
    pins.forEach(function (p) {
      var r = p.el.getBoundingClientRect();
      p.pin.style.left = r.left + 'px'; p.pin.style.top = r.top + 'px';
    });
  }

  function setMode(on) {
    annotating = on; modeBtn.classList.toggle('on', on);
    modeBtn.textContent = on ? 'Annotating — click an element' : 'Annotate';
    document.documentElement.style.cursor = on ? 'crosshair' : '';
    if (!on) place(null);
  }
  modeBtn.onclick = function () { setMode(!annotating); };
  root.querySelector('.close').onclick = function () { bar.hidden = true; setMode(false); };

  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  window.addEventListener('scroll', layoutPins, true);
  window.addEventListener('resize', layoutPins);
  setInterval(function () { if (!document.hidden) loadPins(); }, 10000);
  loadPins();

  window.__uiAnnotate = { toggleToolbar: function () { bar.hidden = !bar.hidden; } };
})();

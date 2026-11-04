(function () {
  var SIZE = 1024;
  var BASE = new URL('.', location.href).href;
  var MODEL_PARTS = ['model/isnet_q.part0.wasm', 'model/isnet_q.part1.wasm', 'model/isnet_q.part2.wasm', 'model/isnet_q.part3.wasm'];
  var MODEL_BYTES = 46360717;
  var ORT_URL = 'ort/ort.wasm.min.js';
  var $ = function (id) { return document.getElementById(id); };

  var items = [], current = null, nextId = 1, viewBox = null;
  var opts = { backdrop: 'mat', bg: 'none', edge: 45, trim: true, pad: 2, fmt: 'png', tool: 'none', brush: 40 };
  var downloadsP = (window.claude && window.claude.use) ? window.claude.use('downloads').catch(function () { return null; }) : Promise.resolve(null);

  /* ---------- UI helpers ---------- */
  var toastTimer;
  function toast(msg) { var t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, 3600); }
  function busy(on, text, sub, frac) {
    $('busy').hidden = !on; if (!on) return;
    $('busyText').textContent = text || ''; $('busySub').textContent = sub || '';
    var m = $('meter');
    if (frac == null) { m.classList.add('indeterminate'); $('meterFill').style.width = ''; }
    else { m.classList.remove('indeterminate'); $('meterFill').style.width = Math.round(frac * 100) + '%'; }
  }
  function fmtPx(w, h) { return w.toLocaleString('en-US') + ' × ' + h.toLocaleString('en-US') + ' px'; }
  function baseName(n) { return (n || 'image').replace(/\.[^.]+$/, '').replace(/[^\w\-]+/g, '-').replace(/^-+|-+$/g, '') || 'image'; }
  function mb(n) { return (n / 1048576).toFixed(1) + ' MB'; }
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  /* ---------- Engine: preloads on page load, shows a small chip instead of blocking ---------- */
  var enginePromise = null, engineReady = false, lastEngine = { text: 'Getting the cutout engine ready', sub: '', frac: null }, chipTimer;
  function engineProgress(text, sub, frac, chipText) {
    lastEngine = { text: text, sub: sub, frac: frac };
    var chip = $('engineChip'); chip.hidden = false; chip.classList.toggle('indet', frac == null);
    $('engineText').textContent = chipText || (frac == null ? 'Starting engine' : 'Loading engine ' + Math.round(frac * 100) + '%');
    $('engineBar').style.width = frac == null ? '' : Math.round(frac * 100) + '%';
    if (!engineReady && current && (current.status === 'queued' || current.status === 'cutting')) busy(true, text, sub, frac);
  }
  async function fetchModel() {
    var cache = null;
    try { cache = await caches.open('background-killer-model-v1'); } catch (e) {}
    var chunks = [], loaded = 0;
    for (var i = 0; i < MODEL_PARTS.length; i++) {
      var url = MODEL_PARTS[i], res = null;
      if (cache) { try { res = await cache.match(url); } catch (e) {} }
      var fromCache = !!res;
      if (!res) {
        res = await fetch(url);
        if (!res.ok) throw new Error('Could not download the model (' + res.status + ')');
        if (cache) { try { await cache.put(url, res.clone()); } catch (e) {} }
      }
      var label = fromCache ? 'Loading the cutout model' : 'Downloading the cutout model';
      if (fromCache || !res.body) {
        var b = new Uint8Array(await res.arrayBuffer()); chunks.push(b); loaded += b.length;
        engineProgress(label, mb(loaded) + ' of ' + mb(MODEL_BYTES) + (fromCache ? '' : ' · one time only'), loaded / MODEL_BYTES);
      } else {
        var reader = res.body.getReader();
        for (;;) {
          var r = await reader.read(); if (r.done) break;
          chunks.push(r.value); loaded += r.value.length;
          engineProgress(label, mb(loaded) + ' of ' + mb(MODEL_BYTES) + ' · one time only', loaded / MODEL_BYTES);
        }
      }
    }
    var all = new Uint8Array(loaded), off = 0;
    chunks.forEach(function (c) { all.set(c, off); off += c.length; });
    return all;
  }
  function loadScript(src) {
    return new Promise(function (res, rej) { var s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = function () { rej(new Error('Could not load ' + src)); }; document.head.appendChild(s); });
  }
  function startEngine() {
    if (enginePromise) return enginePromise;
    enginePromise = (async function () {
      engineProgress('Downloading the cutout model', 'one time only', 0);
      var model = await fetchModel();
      engineProgress('Warming up', 'Setting up the cutting engine on your device', null, 'Starting engine');
      var eng;
      try { eng = await workerEngine(model.slice(0)); }
      catch (err) {
        console.warn('Worker engine failed, using main thread:', err);
        await loadScript(ORT_URL);
        await loadScript('engine.js');
        await self.CleanCutEngine.init(model, BASE);
        eng = { run: function (rgba) { return self.CleanCutEngine.run(rgba); } };
      }
      engineReady = true;
      $('engineChip').classList.remove('indet'); $('engineBar').style.width = '100%'; $('engineText').textContent = 'Engine ready';
      clearTimeout(chipTimer); chipTimer = setTimeout(function () { $('engineChip').hidden = true; }, 2600);
      return eng;
    })();
    enginePromise.catch(function () { enginePromise = null; $('engineChip').hidden = false; $('engineChip').classList.remove('indet'); $('engineText').textContent = 'Engine failed. Reload to retry.'; });
    return enginePromise;
  }
  function workerEngine(model) {
    return new Promise(function (resolve, reject) {
      var w;
      try { w = new Worker('worker.js'); } catch (e) { reject(e); return; }
      var pending = {}, ready = false, seq = 0;
      var timer = setTimeout(function () { if (!ready) { w.terminate(); reject(new Error('Worker did not start')); } }, 60000);
      w.onerror = function (e) { if (!ready) { clearTimeout(timer); reject(new Error(e.message || 'Worker error')); } };
      w.onmessage = function (e) {
        var d = e.data;
        if (d.type === 'ready') { ready = true; clearTimeout(timer); resolve({ run: run }); }
        else if (d.type === 'mask') { pending[d.id].res(d.mask); delete pending[d.id]; }
        else if (d.type === 'error') {
          if (!ready) { clearTimeout(timer); w.terminate(); reject(new Error(d.message)); }
          else if (pending[d.id]) { pending[d.id].rej(new Error(d.message)); delete pending[d.id]; }
        }
      };
      function run(rgba) {
        return new Promise(function (res, rej) { var id = ++seq; pending[id] = { res: res, rej: rej }; w.postMessage({ type: 'run', id: id, rgba: rgba }, [rgba.buffer]); });
      }
      w.postMessage({ type: 'init', model: model, base: BASE }, [model.buffer]);
    });
  }
  function preload() { startEngine().catch(function () {}); }
  if (document.readyState === 'complete') setTimeout(preload, 300);
  else window.addEventListener('load', function () { setTimeout(preload, 300); });

  /* ---------- Adding images ---------- */
  async function decode(file) {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch (e) {
      var url = URL.createObjectURL(file);
      var img = new Image(); img.src = url;
      await img.decode();
      return img;
    }
  }
  async function addFiles(files, selectNew) {
    files = Array.prototype.filter.call(files, function (f) { return f && f.type && f.type.indexOf('image/') === 0; });
    if (!files.length) { toast('Those files are not images this browser can read.'); return; }
    document.body.classList.add('working'); window.scrollTo(0, 0);
    for (var i = 0; i < files.length; i++) {
      var f = files[i], it = { id: nextId++, name: f.name || ('pasted-' + Date.now() + '.png'), file: f, status: 'queued', strokes: [], redo: [] };
      try { it.img = await decode(f); it.w = it.img.width; it.h = it.img.height; }
      catch (e) { it.status = 'error'; it.error = 'This browser cannot open that file.'; }
      items.push(it);
      if (!current || (selectNew && i === files.length - 1)) select(it);
    }
    renderTray();
    processQueue();
  }

  var processing = false;
  async function processQueue() {
    if (processing) return; processing = true;
    try {
      var engine;
      try { engine = await startEngine(); }
      catch (err) {
        busy(false); toast('The cutout engine could not load. ' + err.message);
        items.forEach(function (x) { if (x.status === 'queued') { x.status = 'error'; x.error = 'The cutout engine could not load. Reload the page and try again.'; } });
        renderTray(); render(); processing = false; return;
      }
      for (;;) {
        var it = items.find(function (x) { return x.status === 'queued'; });
        if (!it) break;
        it.status = 'cutting'; renderTray();
        if (current === it) busy(true, 'Cutting out ' + it.name, 'Usually 5 to 20 seconds per image', null);
        try {
          var c = document.createElement('canvas'); c.width = SIZE; c.height = SIZE;
          var x = c.getContext('2d', { willReadFrequently: true });
          x.drawImage(it.img, 0, 0, SIZE, SIZE);
          var rgba = x.getImageData(0, 0, SIZE, SIZE).data;
          it.mask = await engine.run(new Uint8ClampedArray(rgba.buffer));
          it.status = 'done';
          it.thumb = null;
        } catch (err) { it.status = 'error'; it.error = err.message; console.error(err); }
        if (current === it) { busy(false); render(); }
        renderTray();
      }
    } finally { processing = false; busy(false); updateButtons(); }
  }

  /* ---------- Compositing ---------- */
  function lut() {
    // Edge slider: 0 = soft, 100 = crisp. Steepens the alpha curve around the midpoint.
    var k = 1 + (opts.edge / 100) * 7, t = new Uint8ClampedArray(256);
    for (var i = 0; i < 256; i++) { var v = (i / 255 - 0.5) * k + 0.5; t[i] = Math.max(0, Math.min(1, v)) * 255; }
    return t;
  }
  function maskCanvas(it) {
    var key = opts.edge;
    if (it._mc && it._mcKey === key) return it._mc;
    var t = lut(), c = document.createElement('canvas'); c.width = SIZE; c.height = SIZE;
    var ctx = c.getContext('2d'), id = ctx.createImageData(SIZE, SIZE), d = id.data, m = it.mask;
    for (var i = 0, j = 3; i < m.length; i++, j += 4) d[j] = t[m[i]];
    ctx.putImageData(id, 0, 0);
    it._mc = c; it._mcKey = key;
    return c;
  }
  function baseBounds(it) {
    // Bounding box of the model's mask in mask pixels, cached per edge setting.
    if (it._bb !== undefined && it._bbKey === opts.edge) return it._bb;
    var m = it.mask, minX = SIZE, minY = SIZE, maxX = -1, maxY = -1, t = lut();
    for (var y = 0; y < SIZE; y++) for (var x = 0; x < SIZE; x++) {
      if (t[m[y * SIZE + x]] > 24) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    }
    it._bb = maxX < 0 ? null : { minX: minX, minY: minY, maxX: maxX, maxY: maxY };
    it._bbKey = opts.edge;
    return it._bb;
  }
  function restoreBounds(it) {
    var b = null;
    it.strokes.forEach(function (s) {
      if (s.mode !== 'restore') return;
      var r = s.r * it.w;
      s.pts.forEach(function (p) {
        var x = p[0] * it.w, y = p[1] * it.h;
        if (!b) b = { x0: x - r, y0: y - r, x1: x + r, y1: y + r };
        else { b.x0 = Math.min(b.x0, x - r); b.y0 = Math.min(b.y0, y - r); b.x1 = Math.max(b.x1, x + r); b.y1 = Math.max(b.y1, y + r); }
      });
    });
    return b;
  }
  function cropBox(it, wholeFrame) {
    var w = it.w, h = it.h, full = { x: 0, y: 0, w: w, h: h };
    if (!opts.trim || wholeFrame) return full;
    var bb = baseBounds(it); if (!bb) return full;
    var x0 = Math.floor(bb.minX * w / SIZE), y0 = Math.floor(bb.minY * h / SIZE);
    var x1 = Math.ceil((bb.maxX + 1) * w / SIZE), y1 = Math.ceil((bb.maxY + 1) * h / SIZE);
    var rb = restoreBounds(it);
    if (rb) { x0 = Math.min(x0, Math.floor(rb.x0)); y0 = Math.min(y0, Math.floor(rb.y0)); x1 = Math.max(x1, Math.ceil(rb.x1)); y1 = Math.max(y1, Math.ceil(rb.y1)); }
    var p = Math.round(Math.max(x1 - x0, y1 - y0) * opts.pad / 100);
    return { x: x0 - p, y: y0 - p, w: (x1 - x0) + 2 * p, h: (y1 - y0) + 2 * p };
  }
  function paintStroke(ctx, s, dx, dy, dw, dh) {
    var pts = s.pts, lw = Math.max(1, s.r * 2 * dw);
    ctx.save();
    ctx.globalCompositeOperation = s.mode === 'erase' ? 'destination-out' : 'source-over';
    ctx.strokeStyle = '#fff'; ctx.fillStyle = '#fff'; ctx.lineWidth = lw; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath();
    if (pts.length === 1) { ctx.arc(dx + pts[0][0] * dw, dy + pts[0][1] * dh, lw / 2, 0, Math.PI * 2); ctx.fill(); }
    else { ctx.moveTo(dx + pts[0][0] * dw, dy + pts[0][1] * dh); for (var i = 1; i < pts.length; i++) ctx.lineTo(dx + pts[i][0] * dw, dy + pts[i][1] * dh); ctx.stroke(); }
    ctx.restore();
  }
  /* flags.edit: show the whole frame (needed while painting). flags.noBg: skip the background fill. */
  function compose(it, maxDim, flags) {
    flags = flags || {};
    var b = cropBox(it, flags.edit), s = maxDim ? Math.min(1, maxDim / Math.max(b.w, b.h)) : 1;
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(b.w * s)); c.height = Math.max(1, Math.round(b.h * s));
    var ctx = c.getContext('2d');
    if (!ctx) throw new Error('This browser cannot make an image that large.');
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    var dx = -b.x * s, dy = -b.y * s, dw = it.w * s, dh = it.h * s;
    ctx.drawImage(it.img, dx, dy, dw, dh);
    ctx.globalCompositeOperation = 'destination-in';
    if (it.strokes.length) {
      var a = document.createElement('canvas'); a.width = c.width; a.height = c.height;
      var actx = a.getContext('2d'); actx.imageSmoothingEnabled = true; actx.imageSmoothingQuality = 'high';
      actx.drawImage(maskCanvas(it), dx, dy, dw, dh);
      it.strokes.forEach(function (st) { paintStroke(actx, st, dx, dy, dw, dh); });
      ctx.drawImage(a, 0, 0);
    } else {
      ctx.drawImage(maskCanvas(it), dx, dy, dw, dh);
    }
    if (opts.bg !== 'none' && !flags.noBg) {
      ctx.globalCompositeOperation = 'destination-over';
      ctx.fillStyle = opts.bg; ctx.fillRect(0, 0, c.width, c.height);
    }
    c._box = b; c._s = s;
    return c;
  }

  /* ---------- Rendering ---------- */
  function setTool(v) {
    opts.tool = v;
    var r = document.querySelector('input[name="tool"][value="' + v + '"]'); if (r) r.checked = true;
    $('ring').hidden = true; setReveal(0); $('reveal').value = 0;
  }
  function setReveal(v) {
    $('piece').style.setProperty('--rv', v + '%');
    $('divider').hidden = !(v > 0 && v < 100);
  }
  function select(it) {
    current = it; $('exampleView').hidden = true; $('piece').hidden = false;
    setReveal(0); $('reveal').value = 0;
    render(); renderTray();
  }
  var rafId = 0;
  function schedule() { if (!rafId) rafId = requestAnimationFrame(function () { rafId = 0; render(true); }); }
  function render(fast) {
    var it = current; if (!it) return;
    var view = $('view'), piece = $('piece');
    if (!fast) {
      if (it.status !== 'done' && opts.tool !== 'none') setTool('none');
      updateButtons();
      $('fileName').textContent = it.name;
      $('dims').textContent = it.w ? fmtPx(it.w, it.h) : '';
      piece.className = 'piece ' + (opts.backdrop === 'checker' ? 'checker' : 'onmat') + (opts.tool !== 'none' ? ' painting' : '');
      $('compare').hidden = true;
    }
    if (it.status === 'error') { busy(false); drawOriginal(view, it); $('outSize').textContent = 'Could not cut this one. ' + (it.error || ''); drawRuler(it.w); viewBox = null; return; }
    if (it.status !== 'done') {
      drawOriginal(view, it); viewBox = null;
      if (it.status === 'cutting') busy(true, 'Cutting out ' + it.name, 'Usually 5 to 20 seconds per image', null);
      else if (!engineReady) busy(true, lastEngine.text, lastEngine.sub, lastEngine.frac);
      $('outSize').textContent = 'Same pixels as your original. Nothing is scaled down.';
      drawRuler(it.w); return;
    }
    if (!fast) busy(false);
    var editing = opts.tool !== 'none';
    var c = compose(it, 1600, { edit: editing, noBg: editing });
    var b = c._box, s = c._s;
    view.width = c.width; view.height = c.height;
    var ctx = view.getContext('2d');
    if (opts.tool === 'restore') { ctx.save(); ctx.globalAlpha = 0.38; ctx.drawImage(it.img, -b.x * s, -b.y * s, it.w * s, it.h * s); ctx.restore(); }
    ctx.drawImage(c, 0, 0);
    viewBox = b;
    if (fast) return;
    var o = $('orig'); o.width = c.width; o.height = c.height;
    o.getContext('2d').drawImage(it.img, -b.x * s, -b.y * s, it.w * s, it.h * s);
    $('compare').hidden = editing;
    setOutSize(it, cropBox(it));
    drawRuler(b.w);
  }
  function drawOriginal(view, it) {
    if (!it.img) return;
    var s = Math.min(1, 1600 / Math.max(it.w, it.h));
    view.width = Math.round(it.w * s); view.height = Math.round(it.h * s);
    var ctx = view.getContext('2d'); ctx.globalAlpha = it.status === 'done' ? 1 : .55; ctx.drawImage(it.img, 0, 0, view.width, view.height); ctx.globalAlpha = 1;
  }
  function setOutSize(it, b) {
    $('outSize').textContent = (b && opts.trim) ? 'Trimmed from your full-size original. Nothing is scaled down.' : 'Same pixels as your original. Nothing is scaled down.';
  }
  function drawRuler(pxWidth) {
    var r = $('ruler'); r.innerHTML = '';
    if (!pxWidth) return;
    var steps = [10, 20, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000], major = steps[steps.length - 1];
    for (var i = 0; i < steps.length; i++) if (pxWidth / steps[i] <= 6) { major = steps[i]; break; }
    var minor = major / 5, html = '';
    for (var v = 0; v <= pxWidth + 0.01; v += minor) {
      var isMajor = Math.abs(v / major - Math.round(v / major)) < 1e-6, left = (v / pxWidth * 100).toFixed(3);
      html += '<i class="' + (isMajor ? 'major' : '') + '" style="left:' + left + '%">' + (isMajor && v < pxWidth * 0.92 ? '<b>' + Math.round(v).toLocaleString('en-US') + '</b>' : '') + '</i>';
    }
    r.innerHTML = html;
  }

  function renderTray() {
    var tray = $('tray'); tray.innerHTML = '';
    items.forEach(function (it) {
      var b = document.createElement('div');
      b.className = 'chip'; b.dataset.st = it.status; b.tabIndex = 0; b.setAttribute('role', 'button');
      b.setAttribute('aria-current', it === current ? 'true' : 'false');
      b.setAttribute('aria-label', it.name + ', ' + label(it.status));
      var th = document.createElement('div'); th.className = 'thumb';
      if (it.status === 'done') { if (!it.thumb) it.thumb = compose(it, 160).toDataURL(); th.style.backgroundImage = 'url(' + it.thumb + ')'; }
      else if (it.img) { if (!it.thumbO) { var c = document.createElement('canvas'), s = 160 / Math.max(it.w, it.h); c.width = it.w * s; c.height = it.h * s; c.getContext('2d').drawImage(it.img, 0, 0, c.width, c.height); it.thumbO = c.toDataURL('image/jpeg', .7); } th.style.backgroundImage = 'url(' + it.thumbO + ')'; th.style.opacity = .6; }
      var st = document.createElement('span'); st.className = 'st'; st.textContent = label(it.status);
      var x = document.createElement('button'); x.className = 'x'; x.type = 'button'; x.textContent = '×'; x.setAttribute('aria-label', 'Remove ' + it.name);
      x.onclick = function (e) { e.stopPropagation(); removeItem(it); };
      b.onclick = function () { select(it); };
      b.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(it); } };
      b.append(th, st, x); tray.appendChild(b);
    });
    var done = items.filter(function (i) { return i.status === 'done'; }).length;
    $('trayCount').textContent = items.length ? (done + ' of ' + items.length + ' cut') : '0 images';
    updateButtons();
  }
  function label(s) { return { queued: 'Waiting', cutting: 'Cutting', done: 'Ready', error: 'Failed' }[s]; }
  function removeItem(it) {
    if (it.status === 'cutting') { toast('Wait for this one to finish, then remove it.'); return; }
    items = items.filter(function (x) { return x !== it; });
    if (current === it) {
      current = items[items.length - 1] || null;
      if (current) render();
      else { $('piece').hidden = true; $('exampleView').hidden = false; $('fileName').textContent = 'example · astronaut.jpg'; $('dims').textContent = '512 × 512 px'; $('compare').hidden = true; setTool('none'); viewBox = null; }
    }
    renderTray(); updateButtons();
  }
  function updateButtons() {
    var it = current, ok = !!(it && it.status === 'done');
    var size = ok ? (function () { var b = cropBox(it); return fmtPx(Math.round(b.w), Math.round(b.h)); })() : '';
    [['saveOne', 'Download full size'], ['saveOneM', 'Download']].forEach(function (p) {
      var el = $(p[0]); el.disabled = !ok; el.innerHTML = p[1] + (size ? '<small>' + size + '</small>' : '');
    });
    $('copyOne').disabled = !ok; $('copyOneM').disabled = !ok;
    $('actionbar').hidden = !ok;
    document.body.classList.toggle('working', items.length > 0);
    var n = items.filter(function (i) { return i.status === 'done'; }).length;
    $('saveAll').disabled = n < 2;
    $('saveAll').textContent = n >= 2 ? 'Download all ' + n + ' as .zip' : 'Download all as .zip';
    document.querySelectorAll('input[name="tool"]').forEach(function (r) { r.disabled = !ok; });
    $('brush').disabled = !ok || opts.tool === 'none';
    $('undoBtn').disabled = !ok || !it.strokes.length;
    $('redoBtn').disabled = !ok || !it.redo.length;
    $('resetBtn').disabled = !ok || !it.strokes.length;
    $('fixHint').textContent = !ok ? 'Available once a cutout is ready.' :
      opts.tool === 'erase' ? 'Paint over anything that should go.' :
      opts.tool === 'restore' ? 'Paint over parts the cutout lost. The faded area shows what was removed.' :
      'Pick Erase or Restore, then paint on the photo.';
  }

  /* ---------- Brush: erase and restore with undo ---------- */
  var viewEl = $('view'), ring = $('ring'), pieceEl = $('piece'), painting = null;
  function pointFromEvent(e) {
    var r = viewEl.getBoundingClientRect(), it = current, b = viewBox;
    return [(b.x + (e.clientX - r.left) / r.width * b.w) / it.w, (b.y + (e.clientY - r.top) / r.height * b.h) / it.h];
  }
  function moveRing(e) {
    if (opts.tool === 'none') { ring.hidden = true; return; }
    var pr = pieceEl.getBoundingClientRect();
    ring.hidden = false;
    ring.style.width = ring.style.height = opts.brush + 'px';
    ring.style.left = (e.clientX - pr.left) + 'px';
    ring.style.top = (e.clientY - pr.top) + 'px';
  }
  function endStroke() {
    if (!painting) return;
    painting = null;
    if (current) current.thumb = null;
    render(); renderTray();
  }
  viewEl.addEventListener('pointerdown', function (e) {
    var it = current;
    if (!it || it.status !== 'done' || opts.tool === 'none' || !viewBox) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    try { viewEl.setPointerCapture(e.pointerId); } catch (x) {}
    var r = viewEl.getBoundingClientRect();
    painting = { mode: opts.tool, r: (opts.brush / 2) * (viewBox.w / r.width) / it.w, pts: [pointFromEvent(e)] };
    it.strokes.push(painting); it.redo = [];
    moveRing(e); schedule();
  });
  viewEl.addEventListener('pointermove', function (e) {
    moveRing(e);
    if (!painting || !viewBox) return;
    painting.pts.push(pointFromEvent(e)); schedule();
  });
  viewEl.addEventListener('pointerup', endStroke);
  viewEl.addEventListener('pointercancel', endStroke);
  viewEl.addEventListener('pointerleave', function () { if (!painting) ring.hidden = true; });

  function afterEdit() { if (current) current.thumb = null; render(); renderTray(); }
  function undo() { var it = current; if (!it || it.status !== 'done' || !it.strokes.length) return; it.redo.push(it.strokes.pop()); afterEdit(); }
  function redo() { var it = current; if (!it || it.status !== 'done' || !it.redo.length) return; it.strokes.push(it.redo.pop()); afterEdit(); }
  function resetStrokes() { var it = current; if (!it || !it.strokes.length) return; it.redo = it.redo.concat(it.strokes.slice().reverse()); it.strokes = []; afterEdit(); }
  $('undoBtn').onclick = undo; $('redoBtn').onclick = redo; $('resetBtn').onclick = resetStrokes;
  document.addEventListener('keydown', function (e) {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    var k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); redo(); }
  });
  document.querySelectorAll('input[name="tool"]').forEach(function (r) { r.onchange = function () { setTool(r.value); render(); }; });
  $('brush').oninput = function () { opts.brush = +this.value; $('brushOut').textContent = opts.brush + ' px'; };

  /* ---------- Export ---------- */
  function toBlob(c) {
    var type = opts.fmt === 'webp' ? 'image/webp' : 'image/png';
    return new Promise(function (res, rej) { c.toBlob(function (b) { b ? res(b) : rej(new Error('This browser could not encode the image.')); }, type, opts.fmt === 'webp' ? 0.95 : undefined); });
  }
  async function saveBlob(blob, filename) {
    var dl = await downloadsP;
    if (dl) {
      try { await dl.save({ filename: filename, data: blob }); toast('Saved ' + filename); }
      catch (e) { if (e && e.code === 'declined') return; toast(e && e.code === 'unavailable' ? 'Saving is not available in this view.' : 'Could not save: ' + ((e && e.message) || e)); }
      return;
    }
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 10000);
  }
  function ext() { return opts.fmt === 'webp' ? 'webp' : 'png'; }
  async function saveOne() {
    var it = current; if (!it || it.status !== 'done') return;
    try { var b = cropBox(it); busy(true, 'Rendering at full size', fmtPx(Math.round(b.w), Math.round(b.h)), null); var blob = await toBlob(compose(it)); busy(false); await saveBlob(blob, baseName(it.name) + '-cutout.' + ext()); }
    catch (e) { busy(false); toast(e.message || 'Export failed.'); }
  }
  async function copyOne() {
    var it = current; if (!it || it.status !== 'done') return;
    if (!(navigator.clipboard && window.ClipboardItem)) { toast('This browser cannot copy images. Use Download instead.'); return; }
    try {
      var promise = new Promise(function (res, rej) { try { compose(it).toBlob(function (b) { b ? res(b) : rej(new Error('encode')); }, 'image/png'); } catch (e) { rej(e); } });
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': promise })]);
      toast('Copied. Paste it straight into your design app.');
    } catch (e) { toast('Copying was blocked here. Use Download instead.'); }
  }
  $('saveOne').onclick = saveOne; $('saveOneM').onclick = saveOne;
  $('copyOne').onclick = copyOne; $('copyOneM').onclick = copyOne;
  $('saveAll').onclick = async function () {
    var done = items.filter(function (i) { return i.status === 'done'; });
    if (!window.JSZip) { toast('The zip tool did not load. Download pieces one at a time.'); return; }
    try {
      var zip = new JSZip(), used = {};
      for (var i = 0; i < done.length; i++) {
        busy(true, 'Rendering ' + (i + 1) + ' of ' + done.length, done[i].name, i / done.length);
        var n = baseName(done[i].name), k = n, c = 2; while (used[k]) k = n + '-' + c++; used[k] = 1;
        zip.file(k + '-cutout.' + ext(), await toBlob(compose(done[i])));
      }
      busy(true, 'Packing the zip', '', 1);
      var blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
      busy(false); await saveBlob(blob, 'background-killer-' + done.length + '-pieces.zip');
    } catch (e) { busy(false); toast(e.message || 'Export failed.'); }
  };

  /* ---------- Controls ---------- */
  document.querySelectorAll('input[name="backdrop"]').forEach(function (r) { r.onchange = function () { opts.backdrop = r.value; render(); }; });
  document.querySelectorAll('input[name="fmt"]').forEach(function (r) { r.onchange = function () { opts.fmt = r.value; }; });
  function setBg(v, btn) {
    opts.bg = v;
    document.querySelectorAll('.sw').forEach(function (s) { s.setAttribute('aria-pressed', s === btn ? 'true' : 'false'); });
    items.forEach(function (i) { i.thumb = null; }); render(); renderTray();
  }
  document.querySelectorAll('.sw[data-bg]').forEach(function (s) { s.onclick = function () { setBg(s.dataset.bg, s); }; });
  $('bgColor').oninput = function () { setBg(this.value, $('customSw')); };
  $('bgColor').onclick = function () { setBg(this.value, $('customSw')); };
  var edgeTimer;
  $('edge').oninput = function () {
    opts.edge = +this.value; $('edgeOut').textContent = opts.edge < 25 ? 'Soft' : opts.edge > 70 ? 'Crisp' : 'Natural';
    clearTimeout(edgeTimer); edgeTimer = setTimeout(function () { items.forEach(function (i) { i.thumb = null; }); render(); renderTray(); }, 60);
  };
  $('trim').onchange = function () { opts.trim = this.checked; $('pad').disabled = !this.checked; items.forEach(function (i) { i.thumb = null; }); render(); renderTray(); };
  $('pad').oninput = function () { opts.pad = +this.value; $('padOut').textContent = opts.pad + '%'; render(); };
  $('reveal').oninput = function () { setReveal(+this.value); };

  ['pickBtn', 'pickBtn2'].forEach(function (id) { $(id).onclick = function () { $('fileInput').click(); }; });
  $('fileInput').onchange = function () { addFiles(this.files); this.value = ''; };
  document.querySelectorAll('.sample').forEach(function (btn) {
    btn.onclick = async function () {
      try { var r = await fetch(btn.dataset.src); var b = await r.blob(); addFiles([new File([b], btn.dataset.name, { type: 'image/jpeg' })], true); }
      catch (e) { toast('Could not load the sample photo.'); }
    };
  });
  var mat = $('mat'), stage = $('stage');
  ['dragenter', 'dragover'].forEach(function (ev) { mat.addEventListener(ev, function (e) { e.preventDefault(); stage.classList.add('drag'); }); });
  ['dragleave', 'drop'].forEach(function (ev) { mat.addEventListener(ev, function (e) { e.preventDefault(); if (ev === 'dragleave' && mat.contains(e.relatedTarget)) return; stage.classList.remove('drag'); }); });
  mat.addEventListener('drop', function (e) { if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files); });
  document.addEventListener('dragover', function (e) { e.preventDefault(); document.body.classList.add('dragging'); });
  ['dragleave', 'drop'].forEach(function (ev) { document.addEventListener(ev, function (e) { if (ev === 'dragleave' && e.relatedTarget) return; document.body.classList.remove('dragging'); }); });
  document.addEventListener('drop', function (e) { e.preventDefault(); if (!mat.contains(e.target) && e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files); });
  document.addEventListener('paste', function (e) {
    var fs = [];
    Array.prototype.forEach.call((e.clipboardData && e.clipboardData.items) || [], function (i) { if (i.kind === 'file') { var f = i.getAsFile(); if (f) fs.push(f); } });
    if (fs.length) addFiles(fs);
  });
  updateButtons();
})();

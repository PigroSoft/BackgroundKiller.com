(function () {
  var SIZE = 1024;
  var BASE = new URL('.', location.href).href;
  var MODEL_PARTS = ['model/isnet_w8.part0.wasm', 'model/isnet_w8.part1.wasm', 'model/isnet_w8.part2.wasm', 'model/isnet_w8.part3.wasm'];
  var MODEL_BYTES = 46731734;
  var ORT_URL = 'ort/ort.wasm.min.js';
  var $ = function (id) { return document.getElementById(id); };

  var items = [], current = null, nextId = 1, viewBox = null;
  var WORK = 1800;
  var opts = { backdrop: 'checker', refine: true, bg: 'none', edge: 45, trim: true, pad: 2, fmt: 'png', tool: 'none', brush: 40 };
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
    /* v2 is the weights-only 8-bit model. Drop the old v1 copy so it does not sit on the visitor's disk. */
    try { caches.delete('background-killer-model-v1').catch(function () {}); } catch (e) {}
    try { cache = await caches.open('background-killer-model-v2'); } catch (e) {}
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
      var eng, usedWorker = true;
      try { eng = await workerEngine(model.slice(0)); }
      catch (err) {
        usedWorker = false;
        console.warn('Worker engine failed, using main thread:', err);
        await loadScript(ORT_URL);
        await loadScript('engine.js');
        await self.CleanCutEngine.init(model, BASE);
        eng = { run: function (rgba) { return self.CleanCutEngine.run(rgba); } };
      }
      engineReady = true; modelBytes = model; pool.push({ eng: eng, busy: false, main: !usedWorker });
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
    if (files.length >= 3) setView('batch'); else if (view === 'batch' && items.length) setView('batch');
    for (var i = 0; i < files.length; i++) {
      var f = files[i], it = { id: nextId++, name: f.name || ('pasted-' + Date.now() + '.png'), file: f, status: 'queued', strokes: [], redo: [], masks: {}, mattes: {}, matte: null, method: 'standard', rerun: null };
      try {
        var im = await decode(f); it.w = im.width; it.h = im.height;
        var ss = Math.min(1, 1400 / Math.max(it.w, it.h)); it.small = newCanvas(Math.max(1, Math.round(it.w * ss)), Math.max(1, Math.round(it.h * ss)));
        ctx2d(it.small).drawImage(im, 0, 0, it.small.width, it.small.height);
        if (im.close) im.close();
      }
      catch (e) { it.status = 'error'; it.error = 'This browser cannot open that file.'; }
      items.push(it);
      if (i === files.length - 1 || !current) select(it);
      renderTray(); processQueue();
    }
  }

  /* Only a few full-size photos are held in memory at once, so a batch of 20 big photos stays light. */
  function loadImg(it) {
    if (it.img) return Promise.resolve(it.img);
    if (!it._loading) it._loading = decode(it.file).then(function (im) { it.img = im; it._loading = null; trimImgs(); return im; }, function (e) { it._loading = null; throw e; });
    return it._loading;
  }
  function releaseImg(it) { if (it.img) { try { if (it.img.close) it.img.close(); } catch (e) {} it.img = null; } }
  function trimImgs() { items.forEach(function (x) { if (x !== current && !isActive(x) && x.img) releaseImg(x); }); }
  /* ---------- Job runner: a few engines work side by side, newest request first ---------- */
  var pool = [], modelBytes = null, workersOk = true, starting = false, growing = false;
  function isActive(x) { return x.status === 'cutting' || !!x.running; }
  function jobFor(it) {
    if (it.status === 'queued') return { it: it, method: 'standard' };
    if (it.status === 'done' && it.rerun && !it.running) return { it: it, method: it.rerun };
    return null;
  }
  /* The photo on screen goes first, then the rest in the order they were added. */
  function nextJob() {
    var j = current && jobFor(current); if (j) return j;
    for (var i = 0; i < items.length; i++) { j = jobFor(items[i]); if (j) return j; }
    return null;
  }
  function jobsWaiting() { return items.filter(function (x) { return x.status === 'queued' || (x.status === 'done' && x.rerun && !x.running); }).length; }
  function waitingNote() { return { text: 'Next in line', sub: 'Other photos are being cut out first. This one starts as soon as it can.' }; }
  function wantWorkers() {
    if (!workersOk || (pool[0] && pool[0].main)) return 1;
    return Math.max(1, Math.min(3, Math.floor(((navigator.hardwareConcurrency || 4)) / 2)));
  }
  async function growPool() {
    if (growing || !modelBytes) return; growing = true;
    try {
      while (pool.length < wantWorkers() && jobsWaiting() + pool.filter(function (s) { return s.busy; }).length > pool.length) {
        try { var e = await workerEngine(modelBytes.slice(0)); pool.push({ eng: e, busy: false }); pump(); }
        catch (err) { workersOk = false; break; }
      }
    } finally { growing = false; }
  }
  function processQueue() { pump(); }
  function pump() {
    if (!pool.length) {
      if (!starting) {
        starting = true;
        startEngine().then(function () { starting = false; pump(); }, function (err) {
          starting = false; busy(false); toast('The cutout engine could not load. ' + err.message);
          items.forEach(function (x) { if (x.status === 'queued') { x.status = 'error'; x.error = 'The cutout engine could not load. Reload the page and try again.'; } x.rerun = null; });
          renderTray(); render();
        });
      }
      return;
    }
    for (;;) {
      var slot = pool.find(function (s) { return !s.busy; }); if (!slot) break;
      var job = nextJob(); if (!job) break;
      runJob(slot, job);
    }
    if (jobsWaiting() > 0 && pool.length < wantWorkers()) growPool();
  }
  async function runJob(slot, job) {
    slot.busy = true;
    var it = job.it, method = job.method, first = it.status === 'queued', t0 = Date.now();
    if (first) it.status = 'cutting'; else it.running = method;
    it.t0 = Date.now(); renderTray();
    if (current === it) render();
    try {
      await loadImg(it);
      var mask = await cutWith(slot.eng, it, method);
      it.masks[method] = mask;
      await new Promise(function (r) { setTimeout(r, 0); });
      it.mattes[method] = buildMatte(it, mask);
      if (first || it.method === method || it.rerun === method) { it.method = method; it.mask = mask; it.matte = it.mattes[method]; }
      if (first) it.status = 'done';
      it.thumb = null; it._mc = null; it._bb = undefined;
      jobMs.push(Date.now() - t0);
    } catch (err) {
      console.error(err);
      if (first) { it.status = 'error'; it.error = err.message; }
      else { toast('That way did not work: ' + err.message); it.method = Object.keys(it.masks).indexOf(it.method) >= 0 ? it.method : 'standard'; it.mask = it.masks[it.method]; it.matte = it.mattes[it.method] || null; }
    }
    if (!first) { it.running = null; if (it.rerun === method) it.rerun = null; }
    slot.busy = false;
    trimImgs();
    if (current === it) { busy(false); render(); }
    renderTray(); updateButtons();
    pump();
  }
  var jobMs = [];


  /* ---------- Batch view: progress for big jobs, so nobody gives up on a long wait ---------- */
  var view = 'editor', tiles = {}, batchT0 = 0, batchTimer = 0, lineIdx = 0, lineTick = 0, baseTitle = document.title;
  var LINES = ['Questioning the backgrounds.', 'The backgrounds are not talking.', 'Dusting for fingerprints.', 'Cutting along the dotted line.', 'Straightening the little fedora.', 'Tearing things off at the edges.', 'Taking each background aside for a word.', 'Nobody leaves this alley with a background.'];
  function setView(v) {
    view = v; document.body.classList.toggle('batch-view', v === 'batch');
    $('backBatch').hidden = !(v === 'editor' && items.length >= 3);
    if (v === 'batch') { window.scrollTo(0, 0); updateBatch(); } else render();
  }
  function pendingCount() { return items.filter(function (x) { return x.status === 'queued' || x.status === 'cutting' || x.running || x.rerun; }).length; }
  function fmtEta(ms) { var s = Math.max(5, Math.round(ms / 1000)); if (s < 60) return 'under a minute'; var m = Math.round(s / 60); return 'about ' + m + (m === 1 ? ' minute' : ' minutes'); }
  function updateBatch() {
    var n = items.length, pend = pendingCount();
    if (wasPending && !pend) batchFinished(items.filter(function (x) { return x.status === 'done'; }).length);
    wasPending = pend > 0;
    if (exporting) return;
    $('backBatch').hidden = !(view === 'editor' && n >= 3);
    document.title = pend ? '(' + (n - pend) + '/' + n + ') Cutting out… · Background Killer' : (n >= 3 && view === 'batch' ? 'Done · ' + baseTitle : baseTitle);
    if (view !== 'batch') return;
    var sec = $('batch'), done = items.filter(function (x) { return x.status === 'done'; }).length, fin = n - pend;
    if (pend && !batchT0) batchT0 = Date.now(); if (!pend) batchT0 = 0;
    sec.hidden = false; sec.classList.toggle('finished', !pend && done > 0);
    var partial = 0, now = Date.now(), avg = jobMs.length ? jobMs.reduce(function (p, q) { return p + q; }, 0) / jobMs.length : 14000;
    items.forEach(function (x) { if (x.status === 'cutting' && x.t0) partial += Math.min(0.9, (now - x.t0) / avg); });
    var frac = n ? Math.min(1, (fin + partial) / n) : 0;
    $('batchFill').style.width = Math.round(frac * 100) + '%'; $('bmeter').setAttribute('aria-valuenow', Math.round(frac * 100));
    if (pend) {
      $('batchTitle').textContent = 'Cutting out ' + n + ' photos';
      var rate = fin > 0 && batchT0 ? (now - batchT0) / fin : avg / Math.max(1, pool.length || 1);
      $('batchSub').textContent = (fin + ' of ' + n + ' done') + (fin > 0 ? ' · ' + fmtEta(rate * pend) + ' left' : ' · warming up') + '. Keep this tab open.';
      if (now - lineTick > 3200) { lineTick = now; lineIdx = (lineIdx + 1) % LINES.length; }
      $('batchLine').textContent = LINES[lineIdx];
    } else {
      $('batchTitle').textContent = done + ' cutout' + (done === 1 ? '' : 's') + ' ready';
      $('batchSub').textContent = 'Download them all as one zip, or open any photo to touch it up.';
      $('batchLine').textContent = '';
    }
    $('batchZip').disabled = done < 2; $('batchZip').textContent = done >= 2 ? 'Download all ' + done + ' as .zip' : 'Download all as .zip';
    // tiles, keyed so animations are not restarted
    var grid = $('batchGrid'), seen = {};
    items.forEach(function (it) {
      seen[it.id] = 1; var t = tiles[it.id];
      if (!t) {
        t = tiles[it.id] = document.createElement('div'); t.className = 'btile'; t.tabIndex = 0; t.setAttribute('role', 'button');
        t.innerHTML = '<div class="bimg"></div><div class="bscan"></div><div class="bfoot"><i></i><b></b></div><button class="bx" type="button" aria-label="Remove">×</button>';
        t.onclick = function () { select(it); setView('editor'); };
        t.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(it); setView('editor'); } };
        t.querySelector('.bx').onclick = function (e) { e.stopPropagation(); removeItem(it); };
        grid.appendChild(t);
      }
      if (t.dataset.st !== it.status) { if (it.status === 'done') { t.classList.add('fresh'); setTimeout(function () { t.classList.remove('fresh'); }, 600); } t.dataset.st = it.status; t.querySelector('.bfoot b').textContent = it.name + ' · ' + label(it.status); }
      var img = t.querySelector('.bimg'), src = null;
      if (it.status === 'done') { if (!it.thumb) it.thumb = compose(it, 160).toDataURL(); src = it.thumb; }
      else if (it.small) { if (!it.thumbO) { var c = newCanvas(Math.max(1, Math.round(it.w * 160 / Math.max(it.w, it.h))), Math.max(1, Math.round(it.h * 160 / Math.max(it.w, it.h)))); ctx2d(c).drawImage(it.small, 0, 0, c.width, c.height); it.thumbO = c.toDataURL(); } src = it.thumbO; }
      if (src && t._src !== src) { img.style.backgroundImage = 'url(' + src + ')'; t._src = src; }
    });
    Object.keys(tiles).forEach(function (id) { if (!seen[id]) { tiles[id].remove(); delete tiles[id]; } });
    clearInterval(batchTimer); if (pend) batchTimer = setInterval(updateBatch, 700);
  }
  var notifyOn = false, wasPending = false;
  try { notifyOn = localStorage.getItem('bk-notify') === '1' && window.Notification && Notification.permission === 'granted'; } catch (e) {}
  function syncNotifyBtn() {
    var b = $('batchNotify'); if (!window.Notification) { b.hidden = true; return; }
    b.textContent = notifyOn ? '✓ Will notify you' : 'Notify me when done'; b.setAttribute('aria-pressed', notifyOn ? 'true' : 'false');
  }
  $('batchNotify').onclick = async function () {
    if (notifyOn) { notifyOn = false; try { localStorage.setItem('bk-notify', '0'); } catch (e) {} syncNotifyBtn(); return; }
    var p = Notification.permission; if (p === 'default') { try { p = await Notification.requestPermission(); } catch (e) {} }
    notifyOn = p === 'granted'; try { localStorage.setItem('bk-notify', notifyOn ? '1' : '0'); } catch (e) {}
    if (!notifyOn) toast('Notifications are blocked for this site. You can allow them in your browser settings.');
    syncNotifyBtn();
  };
  function chime() {
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext, ac = new Ctx(), t = ac.currentTime;
      [[659.25, 0], [880, 0.14]].forEach(function (n) {
        var o = ac.createOscillator(), g = ac.createGain(); o.type = 'sine'; o.frequency.value = n[0];
        g.gain.setValueAtTime(0.0001, t + n[1]); g.gain.exponentialRampToValueAtTime(0.12, t + n[1] + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + n[1] + 0.5);
        o.connect(g); g.connect(ac.destination); o.start(t + n[1]); o.stop(t + n[1] + 0.55);
      });
      setTimeout(function () { try { ac.close(); } catch (e) {} }, 1500);
    } catch (e) {}
  }
  function batchFinished(n) {
    if (n < 3) return;
    if (document.hidden) chime();
    if (notifyOn && window.Notification && Notification.permission === 'granted' && document.hidden) {
      try { var nt = new Notification('Your cutouts are ready', { body: n + ' backgrounds removed. Come back to download them.', icon: '/apple-touch-icon.png', tag: 'bk-done' }); nt.onclick = function () { window.focus(); nt.close(); }; } catch (e) {}
    }
  }
  syncNotifyBtn();
  if (!window.showDirectoryPicker) $('batchFolder').hidden = true;
  $('backBatch').onclick = function () { setView('batch'); };
  $('batchAdd').onclick = function () { $('fileInput').click(); };
  $('batchZip').onclick = function () { $('saveAll').onclick(); };
  window.addEventListener('beforeunload', function (e) { if (pendingCount() > 0) { e.preventDefault(); e.returnValue = ''; } });

  /* ---------- Cutout methods. All of them feed 1024x1024 frames to the same model. ---------- */
  function newCanvas(w, h) { var c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  function ctx2d(c) { var x = c.getContext('2d', { willReadFrequently: true }); x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high'; return x; }
  async function runFrame(engine, canvas) {
    var rgba = ctx2d(canvas).getImageData(0, 0, SIZE, SIZE).data;
    return engine.run(new Uint8ClampedArray(rgba.buffer));
  }
  function maskToCanvas(m) {
    var c = newCanvas(SIZE, SIZE), x = ctx2d(c), id = x.createImageData(SIZE, SIZE), d = id.data;
    for (var i = 0, j = 0; i < m.length; i++, j += 4) { d[j] = d[j + 1] = d[j + 2] = m[i]; d[j + 3] = 255; }
    x.putImageData(id, 0, 0); return c;
  }
  function canvasToMask(c) {
    var d = ctx2d(c).getImageData(0, 0, SIZE, SIZE).data, m = new Uint8ClampedArray(SIZE * SIZE);
    for (var i = 0, j = 0; i < m.length; i++, j += 4) m[i] = d[j];
    return m;
  }
  /* Draw a source rectangle of the photo into a 1024 frame, keeping its proportions on a mid-grey ground. */
  function letterFrame(img, sx, sy, sw, sh, filter) {
    var c = newCanvas(SIZE, SIZE), x = ctx2d(c), s = Math.min(SIZE / sw, SIZE / sh), dw = sw * s, dh = sh * s, ox = (SIZE - dw) / 2, oy = (SIZE - dh) / 2;
    x.fillStyle = '#808080'; x.fillRect(0, 0, SIZE, SIZE);
    if (filter) x.filter = filter;
    x.drawImage(img, sx, sy, sw, sh, ox, oy, dw, dh);
    return { canvas: c, ox: ox, oy: oy, dw: dw, dh: dh };
  }
  /* Take the letterboxed result back to a full 1024x1024 mask of the source rectangle. */
  function unletter(mask, f) {
    var out = newCanvas(SIZE, SIZE), x = ctx2d(out);
    x.drawImage(maskToCanvas(mask), f.ox, f.oy, f.dw, f.dh, 0, 0, SIZE, SIZE);
    return canvasToMask(out);
  }
  function flipMask(m) { var o = new Uint8ClampedArray(m.length); for (var y = 0; y < SIZE; y++) for (var x = 0; x < SIZE; x++) o[y * SIZE + x] = m[y * SIZE + (SIZE - 1 - x)]; return o; }
  async function standardMask(engine, it) {
    var c = newCanvas(SIZE, SIZE); ctx2d(c).drawImage(it.img, 0, 0, SIZE, SIZE);
    return runFrame(engine, c);
  }
  async function cutWith(engine, it, method) {
    var w = it.w, h = it.h;
    if (method === 'standard') return standardMask(engine, it);
    if (method === 'keep') { var f = letterFrame(it.img, 0, 0, w, h); return unletter(await runFrame(engine, f.canvas), f); }
    if (method === 'flip') {
      var a = it.masks.standard || await standardMask(engine, it); it.masks.standard = a;
      var c = newCanvas(SIZE, SIZE), x = ctx2d(c); x.translate(SIZE, 0); x.scale(-1, 1); x.drawImage(it.img, 0, 0, SIZE, SIZE);
      var b = flipMask(await runFrame(engine, c)), o = new Uint8ClampedArray(a.length);
      for (var i = 0; i < o.length; i++) o[i] = (a[i] + b[i]) >> 1;
      return o;
    }
    if (method === 'contrast') {
      var f2 = letterFrame(it.img, 0, 0, w, h, 'contrast(1.35) saturate(1.1) brightness(1.05)');
      return unletter(await runFrame(engine, f2.canvas), f2);
    }
    if (method === 'zoom') {
      var base = it.masks.standard || await standardMask(engine, it); it.masks.standard = base;
      var minX = SIZE, minY = SIZE, maxX = -1, maxY = -1;
      for (var yy = 0; yy < SIZE; yy++) for (var xx = 0; xx < SIZE; xx++) if (base[yy * SIZE + xx] > 110) { if (xx < minX) minX = xx; if (xx > maxX) maxX = xx; if (yy < minY) minY = yy; if (yy > maxY) maxY = yy; }
      if (maxX < 0) return base;
      var m = Math.max(maxX - minX, maxY - minY) * 0.1 + 8;
      minX = Math.max(0, minX - m); minY = Math.max(0, minY - m); maxX = Math.min(SIZE - 1, maxX + m); maxY = Math.min(SIZE - 1, maxY + m);
      var sx = minX / SIZE * w, sy = minY / SIZE * h, sw = (maxX - minX + 1) / SIZE * w, sh = (maxY - minY + 1) / SIZE * h;
      var f3 = letterFrame(it.img, sx, sy, sw, sh), zoomed = await runFrame(engine, f3.canvas);
      var crop = unletter(zoomed, f3);
      /* Put the zoomed result back where it came from, and keep the standard mask everywhere else. */
      var out = newCanvas(SIZE, SIZE), ox = ctx2d(out);
      ox.drawImage(maskToCanvas(base), 0, 0);
      ox.fillStyle = '#000'; ox.fillRect(minX, minY, maxX - minX + 1, maxY - minY + 1);
      ox.drawImage(maskToCanvas(crop), 0, 0, SIZE, SIZE, minX, minY, maxX - minX + 1, maxY - minY + 1);
      return canvasToMask(out);
    }
    throw new Error('Unknown method');
  }
  /* Snap the model's mask to the photo's real edges and clean the colors at the rim (see matte.js). */
  function buildMatte(it, mask) {
    if (!window.BKMatte) return null;
    try {
      var s = Math.min(1, WORK / Math.max(it.w, it.h)), W = Math.max(1, Math.round(it.w * s)), H = Math.max(1, Math.round(it.h * s));
      var c = newCanvas(W, H), x = ctx2d(c); x.drawImage(it.img, 0, 0, W, H);
      var rgba = x.getImageData(0, 0, W, H).data;
      var mc = newCanvas(W, H), mx = ctx2d(mc); mx.drawImage(maskToCanvas(mask), 0, 0, W, H);
      var md = mx.getImageData(0, 0, W, H).data, p = new Float32Array(W * H);
      for (var i = 0, j = 0; i < p.length; i++, j += 4) p[i] = md[j] / 255;
      return BKMatte.refine(rgba, p, W, H);
    } catch (e) { console.warn('Edge refinement skipped:', e); return null; }
  }
  function fgCanvas(m) {
    if (m._fgc) return m._fgc;
    var c = newCanvas(m.w, m.h); c.getContext('2d').putImageData(new ImageData(m.fg, m.w, m.h), 0, 0);
    return (m._fgc = c);
  }
  function setMethod(method) {
    var it = current; if (!it || it.status !== 'done') return;
    if (it.masks[method]) {
      it.method = method; it.mask = it.masks[method]; it.matte = it.mattes[method] || null; it.rerun = null; it.thumb = null; it._mc = null; it._bb = undefined;
      render(); renderTray(); return;
    }
    it.rerun = method; render(); processQueue();
  }
  document.querySelectorAll('.method').forEach(function (b) { b.onclick = function () { setMethod(b.dataset.method); }; });

  /* ---------- Compositing ---------- */
  function lut() {
    // Edge slider: 0 = soft, 100 = crisp. Steepens the alpha curve around the midpoint.
    var k = 1 + (opts.edge / 100) * 7, t = new Uint8ClampedArray(256);
    for (var i = 0; i < 256; i++) { var v = (i / 255 - 0.5) * k + 0.5; t[i] = Math.max(0, Math.min(1, v)) * 255; }
    return t;
  }
  function maskCanvas(it) {
    var key = opts.edge + (opts.refine && it.matte ? 'r' : 'p');
    if (it._mc && it._mcKey === key) return it._mc;
    if (opts.refine && it.matte) {
      var m2 = it.matte, e2 = opts.edge / 100, lo2 = e2 * 0.08, hi2 = 1 - e2 * 0.1, t2 = new Uint8ClampedArray(256);
      // Keep faint wisps of fur: only trim the very bottom and top of the range, never the middle.
      for (var q = 0; q < 256; q++) { var v2 = (q / 255 - lo2) / (hi2 - lo2); t2[q] = Math.max(0, Math.min(1, v2)) * 255; }
      var c2 = newCanvas(m2.w, m2.h), x2 = c2.getContext('2d'), id2 = x2.createImageData(m2.w, m2.h), d2 = id2.data;
      for (var i2 = 0, j2 = 3; i2 < m2.alpha.length; i2++, j2 += 4) d2[j2] = t2[m2.alpha[i2]];
      x2.putImageData(id2, 0, 0); it._mc = c2; it._mcKey = key; return c2;
    }
    var t = lut(), c = document.createElement('canvas'); c.width = SIZE; c.height = SIZE;
    var ctx = c.getContext('2d'), id = ctx.createImageData(SIZE, SIZE), d = id.data, m = it.mask;
    for (var i = 0, j = 3; i < m.length; i++, j += 4) d[j] = t[m[i]];
    ctx.putImageData(id, 0, 0);
    it._mc = c; it._mcKey = key;
    return c;
  }
  function baseBounds(it) {
    // Bounding box of the model's mask in mask pixels, cached per edge setting.
    var bbKey = opts.edge + (opts.refine && it.matte ? 'r' : 'p');
    if (it._bb !== undefined && it._bbKey === bbKey) return it._bb;
    if (opts.refine && it.matte) {
      /* Use the cleaned matte, so stray haze does not stretch the crop. Matte pixels are scaled back to mask pixels. */
      var mt = it.matte, ax = mt.w, ay = mt.h, a = mt.alpha, x0 = ax, y0 = ay, x1 = -1, y1 = -1;
      for (var yy = 0; yy < ay; yy++) for (var xx = 0; xx < ax; xx++) {
        if (a[yy * ax + xx] > 24) { if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (yy < y0) y0 = yy; if (yy > y1) y1 = yy; }
      }
      it._bb = x1 < 0 ? null : { minX: Math.floor(x0 * SIZE / ax), minY: Math.floor(y0 * SIZE / ay), maxX: Math.min(SIZE - 1, Math.ceil((x1 + 1) * SIZE / ax) - 1), maxY: Math.min(SIZE - 1, Math.ceil((y1 + 1) * SIZE / ay) - 1) };
      it._bbKey = bbKey;
      return it._bb;
    }
    var m = it.mask, minX = SIZE, minY = SIZE, maxX = -1, maxY = -1, t = lut();
    for (var y = 0; y < SIZE; y++) for (var x = 0; x < SIZE; x++) {
      if (t[m[y * SIZE + x]] > 24) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    }
    it._bb = maxX < 0 ? null : { minX: minX, minY: minY, maxX: maxX, maxY: maxY };
    it._bbKey = bbKey;
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
    var srcImg = (!it.img || (maxDim && maxDim <= 320)) && it.small ? it.small : it.img;
    ctx.drawImage(srcImg, dx, dy, dw, dh);
    if (opts.refine && it.matte) ctx.drawImage(fgCanvas(it.matte), dx, dy, dw, dh);
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
    if (it.status === 'done' && !it.img) { drawOriginal(view, it); viewBox = null; loadImg(it).then(function () { if (current === it) render(); }, function () { toast('Could not reopen that photo.'); }); return; }
    if (it.status === 'error') { busy(false); drawOriginal(view, it); $('outSize').textContent = 'Could not cut this one. ' + (it.error || ''); drawRuler(it.w); viewBox = null; return; }
    if (it.status !== 'done') {
      drawOriginal(view, it); viewBox = null;
      if (it.status === 'cutting') busy(true, 'Cutting out ' + it.name, 'Usually 5 to 20 seconds per image', null);
      else if (!engineReady) busy(true, lastEngine.text, lastEngine.sub, lastEngine.frac);
      else if (it.status === 'queued') { var wn = waitingNote(); busy(true, wn.text, wn.sub, null); }
      $('outSize').textContent = 'Same pixels as your original. Nothing is scaled down.';
      drawRuler(it.w); return;
    }
    if (!fast) busy(false);
    if (!fast && it.rerun) { busy(true, it.running === it.rerun ? 'Trying another way' : 'Next in line', it.running === it.rerun ? 'Cutting this photo again with a different method' : 'Another photo is being cut out first', null); }
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
    var src = it.img || it.small; if (!src) return;
    var s = Math.min(1, 1600 / Math.max(it.w, it.h));
    view.width = Math.round(it.w * s); view.height = Math.round(it.h * s);
    var ctx = view.getContext('2d'); ctx.globalAlpha = it.status === 'done' ? 1 : .55; ctx.drawImage(src, 0, 0, view.width, view.height); ctx.globalAlpha = 1;
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
      else if (it.small) { if (!it.thumbO) { var c = document.createElement('canvas'), s = 160 / Math.max(it.w, it.h); c.width = it.w * s; c.height = it.h * s; c.getContext('2d').drawImage(it.small, 0, 0, c.width, c.height); it.thumbO = c.toDataURL('image/jpeg', .7); } th.style.backgroundImage = 'url(' + it.thumbO + ')'; th.style.opacity = .6; }
      var st = document.createElement('span'); st.className = 'st'; st.textContent = label(it.status);
      var x = document.createElement('button'); x.className = 'x'; x.type = 'button'; x.textContent = '×'; x.setAttribute('aria-label', 'Remove ' + it.name);
      x.onclick = function (e) { e.stopPropagation(); removeItem(it); };
      b.onclick = function () { select(it); };
      b.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(it); } };
      b.append(th, st, x); tray.appendChild(b);
    });
    var done = items.filter(function (i) { return i.status === 'done'; }).length;
    updateBatch();
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
      else { $('piece').hidden = true; $('exampleView').hidden = false; $('fileName').textContent = 'example'; $('dims').textContent = '512 × 512 px'; $('compare').hidden = true; setTool('none'); viewBox = null; }
    }
    if (view === 'batch' && !items.length) setView('editor');
    renderTray(); updateButtons();
  }
  var lockupInView = true;
  if ('IntersectionObserver' in window) new IntersectionObserver(function (es) { lockupInView = es[0].isIntersecting; updateButtons(); }, { threshold: 0.2 }).observe($('lockup'));
  function updateButtons() {
    var it = current, ok = !!(it && it.status === 'done');
    var size = ok ? (function () { var b = cropBox(it); return fmtPx(Math.round(b.w), Math.round(b.h)); })() : '';
    [['saveOne', 'Download full size'], ['saveOneM', 'Download']].forEach(function (p) {
      var el = $(p[0]); el.disabled = !ok; el.innerHTML = p[1] + (size ? '<small>' + size + '</small>' : '');
    });
    $('copyOne').disabled = !ok; $('copyOneM').disabled = !ok;
    $('actionbar').hidden = !ok || lockupInView;
    /* Say plainly which mode the editor is in, so it reads as an edit screen once the cutout is ready. */
    var mode = !ok ? 'cutting' : opts.tool === 'erase' ? 'erase' : opts.tool === 'restore' ? 'restore' : 'edit';
    $('mat').dataset.mode = mode;
    $('modeText').textContent = mode === 'edit' ? 'Edit mode' : mode === 'erase' ? 'Erase brush' : mode === 'restore' ? 'Restore brush' : (it ? label(it.status) : 'Cutting');
    var note = $('editNote'); note.hidden = !ok;
    note.textContent = mode === 'erase' ? 'Paint over anything that should go.' : mode === 'restore' ? 'Paint over parts the cutout lost. The faded area shows what was removed.' : 'Cutout ready. Drag the slider to compare, then fix anything it missed.';
    document.body.classList.toggle('working', items.length > 0);
    var nd = items.filter(function (i) { return i.status === 'done'; }).length;
    $('saveAll').disabled = nd < 2; $('saveAll').textContent = nd >= 2 ? 'Download all ' + nd + ' as .zip' : 'Download all as .zip';
    document.querySelectorAll('.method').forEach(function (b) { b.disabled = !ok; b.setAttribute('aria-pressed', ok && it.method === b.dataset.method ? 'true' : 'false'); b.classList.toggle('has', !!(ok && it.masks[b.dataset.method])); });
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
    try { await loadImg(it); var b = cropBox(it); busy(true, 'Rendering at full size', fmtPx(Math.round(b.w), Math.round(b.h)), null); var blob = await toBlob(compose(it)); busy(false); await saveBlob(blob, baseName(it.name) + '-cutout.' + ext()); }
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

  var exporting = false;
  function expBusy(on, text, sub, frac) {
    exporting = on;
    if (view === 'batch') {
      if (on) { $('batchTitle').textContent = text; $('batchSub').textContent = sub || ''; $('batchFill').style.width = Math.round((frac || 0) * 100) + '%'; $('batchLine').textContent = ''; }
      else updateBatch();
    } else busy(on, text, sub, frac);
  }
  async function saveFolder() {
    var done = items.filter(function (i) { return i.status === 'done'; });
    var dir; try { dir = await window.showDirectoryPicker({ mode: 'readwrite' }); } catch (e) { return; }
    try {
      var used = {};
      for (var i = 0; i < done.length; i++) {
        var it = done[i];
        expBusy(true, 'Saving ' + (i + 1) + ' of ' + done.length, it.name + ' · full size', i / done.length);
        await new Promise(function (r) { setTimeout(r, 20); });
        await loadImg(it);
        var c = compose(it), blob = await toBlob(c); c.width = c.height = 1;
        var n = baseName(it.name), k = n, q = 2; while (used[k]) k = n + '-' + q++; used[k] = 1;
        var fh = await dir.getFileHandle(k + '-cutout.' + ext(), { create: true }), w = await fh.createWritable();
        await w.write(blob); await w.close();
        if (it !== current) releaseImg(it);
      }
      expBusy(false); toast('Saved ' + done.length + ' images to ' + dir.name);
    } catch (e) { expBusy(false); console.error(e); toast('Could not save to that folder: ' + (e.message || e)); }
  }
  $('batchFolder').onclick = saveFolder;
  $('saveAll').onclick = async function () {
    var done = items.filter(function (i) { return i.status === 'done'; });
    if (!window.JSZip) { toast('The zip tool did not load. Reload the page and try again.'); return; }
    try {
      var zip = new JSZip(), used = {};
      for (var i = 0; i < done.length; i++) {
        var it = done[i];
        expBusy(true, 'Rendering ' + (i + 1) + ' of ' + done.length, it.name + ' · full size', i / done.length);
        await new Promise(function (r) { setTimeout(r, 20); });
        await loadImg(it);
        var c = compose(it), blob = await toBlob(c);
        c.width = c.height = 1;
        var n = baseName(it.name), k = n, q = 2; while (used[k]) k = n + '-' + q++; used[k] = 1;
        zip.file(k + '-cutout.' + ext(), blob);
        if (it !== current) releaseImg(it);
      }
      expBusy(true, 'Packing the zip', done.length + ' images', 1);
      var out = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
      expBusy(false); await saveBlob(out, 'background-killer-' + done.length + '-cutouts.zip');
    } catch (e) { expBusy(false); console.error(e); toast(e.message || 'Export failed.'); }
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
  $('refine').onchange = function () { opts.refine = this.checked; items.forEach(function (i) { i.thumb = null; i._mc = null; }); render(); renderTray(); };
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

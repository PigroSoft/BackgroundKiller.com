/* Edge refinement for Background Killer.
   The model gives a coarse 1024 px mask. This step turns it into a real alpha matte at working resolution:
   1. A guided filter snaps the coarse mask to the photo's edges and gives a first guess.
   2. Around the edge, foreground and background colors are estimated from nearby pixels that are clearly one or the
      other (blur fusion, Forte and Pitie). Each uncertain pixel is then unmixed: alpha is how far its color lies
      between the local background color and the local foreground color. This is what brings back wisps of fur
      and hair that the model mask misses. It runs a few times, because a better alpha gives better color estimates.
   3. Where foreground and background look alike, the unmixing is unreliable, so the guided mask is kept there.
   4. Foreground colors are cleaned so the old background does not leave a halo on semi-transparent pixels.
   5. Where the background near the subject is busy, unmixing is unreliable, so the guided result is used there. */
(function (g) {
  function box(src, w, h, r, out, tmp) {
    // Mean filter with edge-normalised window, separable, running sums.
    var x, y, s, c, lo, hi;
    for (y = 0; y < h; y++) {
      var row = y * w; s = 0; c = 0;
      for (x = 0; x <= r && x < w; x++) { s += src[row + x]; c++; }
      for (x = 0; x < w; x++) {
        tmp[row + x] = s / c;
        hi = x + r + 1; lo = x - r;
        if (hi < w) { s += src[row + hi]; c++; }
        if (lo >= 0) { s -= src[row + lo]; c--; }
      }
    }
    // Vertical pass, row by row so memory is read in order (much faster than walking down columns).
    var col = new Float64Array(w), cnt = 0, yy;
    for (yy = 0; yy <= r && yy < h; yy++) { var ro = yy * w; for (x = 0; x < w; x++) col[x] += tmp[ro + x]; cnt++; }
    for (y = 0; y < h; y++) {
      var o = y * w, inv = 1 / cnt;
      for (x = 0; x < w; x++) out[o + x] = col[x] * inv;
      hi = y + r + 1; lo = y - r;
      if (hi < h) { var rh = hi * w; for (x = 0; x < w; x++) col[x] += tmp[rh + x]; cnt++; }
      if (lo >= 0) { var rl = lo * w; for (x = 0; x < w; x++) col[x] -= tmp[rl + x]; cnt--; }
    }
    return out;
  }
  function Blur(w, h) {
    var tmp = new Float32Array(w * h);
    return function (src, r) { return box(src, w, h, r, new Float32Array(w * h), tmp); };
  }
  function guided(I, p, w, h, r, eps, blur) {
    var n = w * h, Ip = new Float32Array(n), II = new Float32Array(n), i;
    for (i = 0; i < n; i++) { Ip[i] = I[i] * p[i]; II[i] = I[i] * I[i]; }
    var mI = blur(I, r), mp = blur(p, r), mIp = blur(Ip, r), mII = blur(II, r);
    var a = new Float32Array(n), b = new Float32Array(n);
    for (i = 0; i < n; i++) {
      var v = mII[i] - mI[i] * mI[i], cv = mIp[i] - mI[i] * mp[i];
      a[i] = cv / (v + eps); b[i] = mp[i] - a[i] * mI[i];
    }
    var ma = blur(a, r), mb = blur(b, r), q = new Float32Array(n);
    for (i = 0; i < n; i++) { var t = ma[i] * I[i] + mb[i]; q[i] = t < 0 ? 0 : t > 1 ? 1 : t; }
    return q;
  }
  // ---- Guided-filter result (used where the background is busy) ----
  /* rgba: Uint8ClampedArray w*h*4 of the photo at working size. p: Float32Array w*h, mask 0..1 at the same size.
     Returns { w, h, alpha: Uint8ClampedArray, fg: Uint8ClampedArray (RGBA, A = where to use the cleaned color) }. */
  function refineBase(rgba, p, w, h, opts) {
    opts = opts || {};
    var n = w * h, blur = Blur(w, h), i, j, k;
    var gray = new Float32Array(n);
    for (i = 0, j = 0; i < n; i++, j += 4) gray[i] = (0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2]) / 255;
    var big = (opts && opts.big) || Math.max(w, h), r1 = Math.max(3, Math.round(big * 0.0045)), r2 = Math.max(2, Math.round(big * 0.0016));
    var q = guided(gray, p, w, h, r1, 0.0012, blur);
    q = guided(gray, q, w, h, r2, 0.0002, blur);
    // Anything the model was sure about stays sure: refinement only works on the uncertain band.
    var alpha = new Uint8ClampedArray(n);
    for (i = 0; i < n; i++) {
      var pv = p[i], qv = q[i];
      if (pv > 0.985) qv = Math.max(qv, 0.97 + (pv - 0.985) * 2);
      else if (pv < 0.015) qv = Math.min(qv, (pv) * 2);
      // Toe the curve so faint haze from the old background drops out, while real wisps of hair survive.
      qv = (qv - 0.16) / 0.72; qv = qv < 0 ? 0 : qv > 1 ? 1 : qv;
      alpha[i] = qv * 255 + 0.5;
    }
    // Drop haze and specks that sit far from the solid subject: keep alpha only near confident pixels.
    var core = new Float32Array(n);
    for (i = 0; i < n; i++) core[i] = alpha[i] > 150 ? 1 : 0;
    var near = blur(core, Math.max(8, Math.round(big * 0.03)));
    for (i = 0; i < n; i++) { var gate = near[i] > 0.012 ? 1 : near[i] / 0.012; alpha[i] = alpha[i] * gate; }
    // Foreground color estimate: two blur-fusion passes, wide then tight.
    var A = new Float32Array(n), ch = [], F = [];
    for (i = 0; i < n; i++) A[i] = alpha[i] / 255;
    for (k = 0; k < 3; k++) { var c = new Float32Array(n); for (i = 0, j = k; i < n; i++, j += 4) c[i] = rgba[j] / 255; ch.push(c); F.push(c); }
    var rr = [Math.max(6, Math.round(big * 0.02)), Math.max(2, Math.round(big * 0.003))];
    for (var pass = 0; pass < 2; pass++) {
      var r = rr[pass], bA = blur(A, r), inv = new Float32Array(n), bBA = null;
      for (i = 0; i < n; i++) inv[i] = 1 - A[i];
      var bInv = blur(inv, r), nextF = [];
      for (k = 0; k < 3; k++) {
        var fa = new Float32Array(n), ba = new Float32Array(n), Fk = F[k], Ik = ch[k];
        for (i = 0; i < n; i++) { fa[i] = Fk[i] * A[i]; ba[i] = Ik[i] * inv[i]; }
        var bFa = blur(fa, r), bBa = blur(ba, r), o = new Float32Array(n);
        for (i = 0; i < n; i++) {
          var bF = bFa[i] / (bA[i] + 1e-5), bB = bBa[i] / (bInv[i] + 1e-5), a = A[i];
          var v = bF + a * (Ik[i] - a * bF - (1 - a) * bB);
          o[i] = v < 0 ? 0 : v > 1 ? 1 : v;
        }
        nextF.push(o);
      }
      F = nextF;
    }
    var fg = new Uint8ClampedArray(n * 4);
    for (i = 0, j = 0; i < n; i++, j += 4) {
      fg[j] = F[0][i] * 255; fg[j + 1] = F[1][i] * 255; fg[j + 2] = F[2][i] * 255;
      var a2 = A[i], wgt = a2 >= 0.985 ? 0 : a2 > 0.9 ? (0.985 - a2) / 0.085 : 1;   // interior pixels keep the original
      fg[j + 3] = wgt * 255;
    }
    return { w: w, h: h, alpha: alpha, fg: fg };
  }
  // ---- Unmixing result (used where the background is smooth) ----
  var TUNE = { tau: 0.05, rOut: 0.03, rIn: 0.006, iters: 3, toe: 0.03, pf: 3, pb: 2, smooth: 1, kv: 15, vlo: 0.003, vhi: 0.012, hiT: 0.5, rP: 0.012, pLo: 0.02, pHi: 0.2 };
  /* rgba: Uint8ClampedArray w*h*4 of the photo at working size. p: Float32Array w*h, mask 0..1 at the same size.
     Returns { w, h, alpha: Uint8ClampedArray, fg: Uint8ClampedArray (RGBA, A = where to use the cleaned color) }. */
  function refineNew(rgba, p, w, h, opts) {
    var T = {}; for (var kk in TUNE) T[kk] = (g.BK_TUNE && g.BK_TUNE[kk] !== undefined) ? g.BK_TUNE[kk] : TUNE[kk];
    var n = w * h, blur = Blur(w, h), i, j, k, it;
    var big = (opts && opts.big) || Math.max(w, h);
    var I = [new Float32Array(n), new Float32Array(n), new Float32Array(n)], gray = new Float32Array(n);
    for (i = 0, j = 0; i < n; i++, j += 4) {
      I[0][i] = rgba[j] / 255; I[1][i] = rgba[j + 1] / 255; I[2][i] = rgba[j + 2] / 255;
      gray[i] = 0.299 * I[0][i] + 0.587 * I[1][i] + 0.114 * I[2][i];
    }
    // 1. First guess: the model mask snapped to the photo's edges.
    var r1 = Math.max(3, Math.round(big * 0.0045)), r2 = Math.max(2, Math.round(big * 0.0016));
    var q = guided(gray, p, w, h, r1, 0.0012, blur);
    q = guided(gray, q, w, h, r2, 0.0002, blur);
    // Regions: certain foreground (deep inside), certain background (far outside), uncertain band between.
    var hiM = new Float32Array(n), midM = new Float32Array(n);
    for (i = 0; i < n; i++) { hiM[i] = p[i] > T.hiT ? 1 : 0; midM[i] = p[i] > 0.3 ? 1 : 0; }
    var rIn = Math.max(2, Math.round(big * T.rIn)), rOut = Math.max(6, Math.round(big * T.rOut));
    var er = blur(hiM, rIn), dl = blur(midM, rOut);
    var state = new Uint8Array(n);   // 0 unknown, 1 sure foreground, 2 sure background
    var A = new Float32Array(n);
    for (i = 0; i < n; i++) {
      if (er[i] > 0.999) { state[i] = 1; A[i] = 1; }
      else if (dl[i] < 0.0003) { state[i] = 2; A[i] = 0; }
      else A[i] = q[i];
    }
    // How close is each pixel to the model's mask? Faint smears far from it are background, not fur.
    var near = blur(midM, Math.max(3, Math.round(big * T.rP)));
    er = null; dl = null; hiM = null; midM = null;
    // 2. Unmix: estimate local foreground and background colors, then solve alpha per pixel.
    var radii = [Math.round(big * 0.04), Math.round(big * 0.012), Math.round(big * 0.005)].slice(0, T.iters);
    var uvar = null;
    var F = null, B = null, inv = new Float32Array(n), fa = new Float32Array(n), ba = new Float32Array(n);
    for (it = 0; it < radii.length; it++) {
      var r = Math.max(2, radii[it]);
      var wf = new Float32Array(n);
      for (i = 0; i < n; i++) { var av = A[i]; wf[i] = Math.pow(av, T.pf); inv[i] = Math.pow(1 - av, T.pb); }
      var bA = blur(wf, r), bInv = blur(inv, r);
      F = []; B = [];
      for (k = 0; k < 3; k++) {
        var Ik = I[k];
        for (i = 0; i < n; i++) { fa[i] = Ik[i] * wf[i]; ba[i] = Ik[i] * inv[i]; }
        var bFa = blur(fa, r), bBa = blur(ba, r), Fk = new Float32Array(n), Bk = new Float32Array(n);
        for (i = 0; i < n; i++) { Fk[i] = bFa[i] / (bA[i] + 1e-4); Bk[i] = bBa[i] / (bInv[i] + 1e-4); }
        F.push(Fk); B.push(Bk);
      }
      // How busy is the background around each pixel? Unmixing only works where it is fairly uniform.
      var g2 = new Float32Array(n);
      for (i = 0; i < n; i++) g2[i] = gray[i] * gray[i] * inv[i];
      var bG2 = blur(g2, r);
      if (it === Math.min(1, radii.length - 1)) { uvar = new Float32Array(n); for (i = 0; i < n; i++) { var bgl = 0.299 * B[0][i] + 0.587 * B[1][i] + 0.114 * B[2][i]; var vv0 = bG2[i] / (bInv[i] + 1e-4) - bgl * bgl; uvar[i] = vv0 < 0 ? 0 : vv0; } }
      var An = new Float32Array(n), tau = T.tau, kv = T.kv;
      for (i = 0; i < n; i++) {
        if (state[i] !== 0) { An[i] = A[i]; continue; }
        var d0 = F[0][i] - B[0][i], d1 = F[1][i] - B[1][i], d2 = F[2][i] - B[2][i];
        var dd = d0 * d0 + d1 * d1 + d2 * d2;
        if (bA[i] < 0.01 || bInv[i] < 0.01) { An[i] = A[i]; continue; }
        var dot = (I[0][i] - B[0][i]) * d0 + (I[1][i] - B[1][i]) * d1 + (I[2][i] - B[2][i]) * d2;
        var au = dot / (dd + 1e-5); au = au < 0 ? 0 : au > 1 ? 1 : au;
        var bg = 0.299 * B[0][i] + 0.587 * B[1][i] + 0.114 * B[2][i];
        var varB = bG2[i] / (bInv[i] + 1e-4) - bg * bg; if (varB < 0) varB = 0;
        var conf = dd / (dd + tau + kv * varB);
        An[i] = conf * au + (1 - conf) * A[i];
      }
      if (T.smooth) {
        var sm = guided(gray, An, w, h, T.smooth, 0.0008, blur);
        for (i = 0; i < n; i++) if (state[i] === 0) An[i] = sm[i];
      }
      A = An;
    }
    // 3. Final alpha: drop faint noise, keep wisps.
    var alpha = new Uint8ClampedArray(n), toe = T.toe;
    for (i = 0; i < n; i++) {
      var v = A[i];
      if (state[i] === 2) v = 0; else if (state[i] === 1) v = 1;
      else {
        v = (v - toe) / (1 - toe); v = v < 0 ? 0 : v > 1 ? 1 : v;
        var nr = near[i]; if (nr < T.pHi) v *= nr <= T.pLo ? 0 : (nr - T.pLo) / (T.pHi - T.pLo);
      }
      A[i] = v; alpha[i] = v * 255 + 0.5;
    }
    // 4. Clean foreground colors. Take the color of the subject from pixels that are clearly subject, spread it out to
    //    the semi-transparent pixels at the rim, then add back each pixel's own detail (blur fusion).
    var wS = new Float32Array(n);
    for (i = 0; i < n; i++) wS[i] = (state[i] === 1 || A[i] > 0.95) ? 1 : 0;
    var rf1 = Math.max(3, Math.round(big * 0.015)), rf2 = Math.max(6, Math.round(big * 0.045));
    var s1 = blur(wS, rf1), s2 = blur(wS, rf2), Fs = [];
    for (k = 0; k < 3; k++) {
      var wi = new Float32Array(n);
      for (i = 0; i < n; i++) wi[i] = I[k][i] * wS[i];
      var c1 = blur(wi, rf1), c2 = blur(wi, rf2), Fk2 = new Float32Array(n);
      for (i = 0; i < n; i++) Fk2[i] = s1[i] > 0.02 ? c1[i] / s1[i] : (s2[i] > 0.002 ? c2[i] / s2[i] : -1);
      Fs.push(Fk2);
    }
    var fg = new Uint8ClampedArray(n * 4);
    for (i = 0, j = 0; i < n; i++, j += 4) {
      var a = A[i];
      if (a >= 0.985 || a < 0.003) { fg[j + 3] = 0; continue; }
      for (k = 0; k < 3; k++) {
        var fs = Fs[k][i], bb = B ? B[k][i] : 0;
        var vv = fs < 0 ? I[k][i] : fs + a * (I[k][i] - a * fs - (1 - a) * bb);
        fg[j + k] = (vv < 0 ? 0 : vv > 1 ? 1 : vv) * 255;
      }
      fg[j + 3] = (a > 0.9 ? (0.985 - a) / 0.085 : 1) * 255;
    }
    return { w: w, h: h, alpha: alpha, fg: fg, uvar: uvar, state: state };
  }

  /* Blend the two: the unmixing result where the background around the subject is smooth, the plain guided result
     where it is busy (unmixing cannot tell subject from clutter there). */
  function refineFull(rgba, p, w, h, opts) {
    var T = {}; for (var kk in TUNE) T[kk] = (g.BK_TUNE && g.BK_TUNE[kk] !== undefined) ? g.BK_TUNE[kk] : TUNE[kk];
    var base = refineBase(rgba, p, w, h, opts);
    var nu = refineNew(rgba, p, w, h, opts);
    if (!nu.uvar) return base;
    var n = w * h, big = (opts && opts.big) || Math.max(w, h), i, j, blur = Blur(w, h);
    var u = new Float32Array(n), lo = T.vlo, hi = T.vhi;
    for (i = 0; i < n; i++) { var t = (nu.uvar[i] - lo) / (hi - lo); t = t < 0 ? 0 : t > 1 ? 1 : t; u[i] = 1 - t * t * (3 - 2 * t); }
    u = blur(u, Math.max(4, Math.round(big * 0.01)));
    var alpha = new Uint8ClampedArray(n), fg = new Uint8ClampedArray(n * 4);
    for (i = 0, j = 0; i < n; i++, j += 4) {
      var m = nu.state[i] === 1 || nu.state[i] === 2 ? 1 : u[i];   // certain pixels agree in both anyway
      alpha[i] = nu.alpha[i] * m + base.alpha[i] * (1 - m) + 0.5;
      fg[j] = nu.fg[j] * m + base.fg[j] * (1 - m); fg[j + 1] = nu.fg[j + 1] * m + base.fg[j + 1] * (1 - m);
      fg[j + 2] = nu.fg[j + 2] * m + base.fg[j + 2] * (1 - m); fg[j + 3] = nu.fg[j + 3] * m + base.fg[j + 3] * (1 - m);
    }
    return { w: w, h: h, alpha: alpha, fg: fg };
  }
  /* Some blurry things next to the subject (a window frame, a lamp pole) get a faint, unsure mask that runs off the
     edge of the photo. Real parts of the subject are either solid or small fringes around the solid part. So find
     patches where the model was never sure (mask between 5% and 50%), that are thick enough to be more than a fringe,
     and that reach the photo's border, and drop them. Works on a coarse grid. */
  function dropBorderStrips(p, w, h) {
    var S = 4, cw = Math.ceil(w / S), ch = Math.ceil(h / S), cn = cw * ch, i, x, y, blur = Blur(cw, ch);
    var big = Math.max(cw, ch), r3 = Math.max(3, Math.round(big * 0.012));
    var prot = new Float32Array(cn), cnt = new Float32Array(cn), any = false;
    for (y = 0; y < h; y++) for (x = 0, i = y * w; x < w; x++, i++) { var ci = ((y / S) | 0) * cw + ((x / S) | 0); cnt[ci]++; if (p[i] > 0.05 && p[i] < 0.5) prot[ci]++; }
    for (i = 0; i < cn; i++) { prot[i] = prot[i] / cnt[i] > 0.5 ? 1 : 0; if (prot[i]) any = true; }
    if (!any) return p;
    var core = blur(prot, r3); for (i = 0; i < cn; i++) core[i] = core[i] > 0.999 ? 1 : 0;
    // Keep only the cores that reach the border; flood fill through the protrusion from them.
    var rm = new Uint8Array(cn), stack = [], found = false, edge = 2;
    for (y = 0; y < ch; y++) for (x = 0; x < cw; x++) {
      i = y * cw + x;
      if (core[i] && (x < edge || y < edge || x >= cw - edge || y >= ch - edge)) { rm[i] = 1; stack.push(i); found = true; }
    }
    if (!found) return p;
    while (stack.length) {
      i = stack.pop(); x = i % cw; y = (i / cw) | 0;
      for (var d = 0; d < 4; d++) {
        var nx = x + (d === 0 ? 1 : d === 1 ? -1 : 0), ny = y + (d === 2 ? 1 : d === 3 ? -1 : 0);
        if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue;
        var ni = ny * cw + nx;
        if (!rm[ni] && core[ni]) { rm[ni] = 1; stack.push(ni); }
      }
    }
    // Grow the kept cores back out to the full strip, but only across protrusion pixels.
    var seedF = new Float32Array(cn); for (i = 0; i < cn; i++) seedF[i] = rm[i];
    var grown = blur(seedF, r3 + 1);
    var out = new Float32Array(p.length); out.set(p);
    for (y = 0; y < h; y++) for (x = 0, i = y * w; x < w; x++, i++) {
      var c2 = ((y / S) | 0) * cw + ((x / S) | 0);
      if (prot[c2] && grown[c2] > 0.001) out[i] = 0;
    }
    return out;
  }
  /* Label 8-connected regions of a binary map. Returns { lab: Int32Array (0 = empty), areas: [0, a1, a2, ...] }. */
  function components(bin, w, h) {
    var n = w * h, lab = new Int32Array(n), q = new Int32Array(n), areas = [0], id = 0, s, qh, qt, v, x, y, a, dx, dy, nx, ny, u;
    for (s = 0; s < n; s++) {
      if (!bin[s] || lab[s]) continue;
      id++; qh = 0; qt = 0; q[qt++] = s; lab[s] = id; a = 0;
      while (qh < qt) {
        v = q[qh++]; a++; x = v % w; y = (v - x) / w;
        for (dy = -1; dy <= 1; dy++) {
          ny = y + dy; if (ny < 0 || ny >= h) continue;
          for (dx = -1; dx <= 1; dx++) {
            nx = x + dx; if (nx < 0 || nx >= w) continue;
            u = ny * w + nx;
            if (bin[u] && !lab[u]) { lab[u] = id; q[qt++] = u; }
          }
        }
      }
      areas.push(a);
    }
    return { lab: lab, areas: areas };
  }
  /* Plain backdrops (white sweeps, grey paper) make the model draw faint clouds where it has nothing to look at.
     If the photo's border is one even color, find the backdrop by flood fill from the border and clear any pixel in it
     that sits away from what the model is sure about. Pixels near the subject keep their soft edge. */
  function backdropGuard(rgba, p, alpha, w, h, blur, big) {
    var n = w * h, i, x, y, tol = 18, ring = [], r = [], g2 = [], b = [];
    for (x = 0; x < w; x++) { ring.push(x); ring.push((h - 1) * w + x); }
    for (y = 1; y < h - 1; y++) { ring.push(y * w); ring.push(y * w + w - 1); }
    for (i = 0; i < ring.length; i++) { var o = ring[i] * 4; r.push(rgba[o]); g2.push(rgba[o + 1]); b.push(rgba[o + 2]); }
    function med(a) { a.sort(function (m, k) { return m - k; }); return a[a.length >> 1]; }
    var mr = med(r), mg = med(g2), mb = med(b);
    function like(k) { var o = k * 4; return Math.max(Math.abs(rgba[o] - mr), Math.abs(rgba[o + 1] - mg), Math.abs(rgba[o + 2] - mb)) <= tol; }
    var hit = 0; for (i = 0; i < ring.length; i++) if (like(ring[i])) hit++;
    if (hit < ring.length * 0.6) return false;
    var seen = new Uint8Array(n), q = new Int32Array(n), qh = 0, qt = 0, v;
    for (i = 0; i < ring.length; i++) if (!seen[ring[i]] && like(ring[i])) { seen[ring[i]] = 1; q[qt++] = ring[i]; }
    while (qh < qt) {
      v = q[qh++]; x = v % w; y = (v - x) / w;
      if (x > 0 && !seen[v - 1] && like(v - 1)) { seen[v - 1] = 1; q[qt++] = v - 1; }
      if (x < w - 1 && !seen[v + 1] && like(v + 1)) { seen[v + 1] = 1; q[qt++] = v + 1; }
      if (y > 0 && !seen[v - w] && like(v - w)) { seen[v - w] = 1; q[qt++] = v - w; }
      if (y < h - 1 && !seen[v + w] && like(v + w)) { seen[v + w] = 1; q[qt++] = v + w; }
    }
    q = null;
    /* "Sure" means a solid patch of the subject. Lone confident pixels inside the haze do not count. */
    var hi = new Uint8Array(n), sure = new Float32Array(n), cnt = 0;
    for (i = 0; i < n; i++) hi[i] = p[i] > 0.9 ? 1 : 0;
    var cc = components(hi, w, h), top = 0, id;
    for (id = 1; id < cc.areas.length; id++) if (cc.areas[id] > top) top = cc.areas[id];
    for (i = 0; i < n; i++) if (cc.lab[i] && cc.areas[cc.lab[i]] >= top * 0.05) { sure[i] = 1; cnt++; }
    if (cnt < n * 0.005) return false;   // the model found nothing solid: do not risk erasing the subject
    var near = blur(sure, Math.max(3, Math.round(big * 0.008)));
    for (i = 0; i < n; i++) {
      if (!seen[i] || near[i] >= 0.004) continue;
      var k = (p[i] - 0.85) / 0.12; k = k < 0 ? 0 : k > 1 ? 1 : k;
      alpha[i] = alpha[i] * k;
    }
    return true;
  }
  /* Remove small, see-through islands that float away from the subject. Real small parts are solid, and loose hair sits
     close to the head, but ghosts from the old background are neither. */
  function dropSpecks(alpha, w, h, blur, span) {
    var n = w * h, i, bin = new Uint8Array(n);
    for (i = 0; i < n; i++) bin[i] = alpha[i] > 128 ? 1 : 0;
    var c = components(bin, w, h), nc = c.areas.length - 1, top = 0, main = 0, sum = new Float64Array(nc + 1), id;
    for (id = 1; id <= nc; id++) if (c.areas[id] > top) { top = c.areas[id]; main = id; }
    if (nc < 2) return;
    for (i = 0; i < n; i++) if (c.lab[i]) sum[c.lab[i]] += alpha[i] / 255;
    var body = new Float32Array(n);
    for (i = 0; i < n; i++) body[i] = c.lab[i] === main ? 1 : 0;
    var near = blur(body, Math.max(6, Math.round(span * 0.04))), tied = new Uint8Array(nc + 1);
    for (i = 0; i < n; i++) if (c.lab[i] && near[i] > 0.0004) tied[c.lab[i]] = 1;
    var drop = new Uint8Array(nc + 1), any = false;
    for (id = 1; id <= nc; id++) if (id !== main && !tied[id] && c.areas[id] < top * 0.05 && sum[id] / c.areas[id] < 0.9) { drop[id] = 1; any = true; }
    if (!any) return;
    for (i = 0; i < n; i++) if (c.lab[i] && drop[c.lab[i]]) alpha[i] = 0;
  }
  /* Final cleanup on the finished matte. */
  function tidy(rgba, p, r, w, h) {
    var blur = Blur(w, h), big = Math.max(w, h);
    backdropGuard(rgba, p, r.alpha, w, h, blur, big);
    dropSpecks(r.alpha, w, h, blur, big);
    // Faint dust far from any solid part of the subject goes too, so it cannot stretch the crop or show as flecks.
    var n = w * h, solid = new Float32Array(n), i;
    for (i = 0; i < n; i++) solid[i] = r.alpha[i] > 128 ? 1 : 0;
    var near = blur(solid, Math.max(6, Math.round(big * 0.03)));
    for (i = 0; i < n; i++) if (near[i] < 0.0004) r.alpha[i] = 0;
    return r;
  }
  /* Only the area around the subject needs work, so cut it out, refine that, and paste the result back. */
  function refine(rgba, p, w, h, opts) {
    p = dropBorderStrips(p, w, h);
    var n = w * h, i, x, y, x0 = w, x1 = -1, y0 = h, y1 = -1;
    for (y = 0; y < h; y++) for (x = 0, i = y * w; x < w; x++, i++) if (p[i] > 0.01) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 < 0) return { w: w, h: h, alpha: new Uint8ClampedArray(n), fg: new Uint8ClampedArray(n * 4) };
    var m = Math.round(Math.max(w, h) * 0.08);
    x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m); x1 = Math.min(w - 1, x1 + m); y1 = Math.min(h - 1, y1 + m);
    var cw = x1 - x0 + 1, ch = y1 - y0 + 1;
    if (cw * ch > n * 0.85) return tidy(rgba, p, refineFull(rgba, p, w, h, opts), w, h);
    var cr = new Uint8ClampedArray(cw * ch * 4), cp = new Float32Array(cw * ch);
    for (y = 0; y < ch; y++) {
      cr.set(rgba.subarray(((y + y0) * w + x0) * 4, ((y + y0) * w + x0 + cw) * 4), y * cw * 4);
      cp.set(p.subarray((y + y0) * w + x0, (y + y0) * w + x0 + cw), y * cw);
    }
    var r = refineFull(cr, cp, cw, ch, { big: Math.max(w, h) });
    var alpha = new Uint8ClampedArray(n), fg = new Uint8ClampedArray(n * 4);
    for (y = 0; y < ch; y++) {
      alpha.set(r.alpha.subarray(y * cw, (y + 1) * cw), (y + y0) * w + x0);
      fg.set(r.fg.subarray(y * cw * 4, (y + 1) * cw * 4), ((y + y0) * w + x0) * 4);
    }
    return tidy(rgba, p, { w: w, h: h, alpha: alpha, fg: fg }, w, h);
  }
  g.BKMatte = { refine: refine };
})(self);

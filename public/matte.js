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
    for (x = 0; x < w; x++) {
      s = 0; c = 0;
      for (y = 0; y <= r && y < h; y++) { s += tmp[y * w + x]; c++; }
      for (y = 0; y < h; y++) {
        out[y * w + x] = s / c;
        hi = y + r + 1; lo = y - r;
        if (hi < h) { s += tmp[hi * w + x]; c++; }
        if (lo >= 0) { s -= tmp[lo * w + x]; c--; }
      }
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
    var big = Math.max(w, h), r1 = Math.max(3, Math.round(big * 0.0045)), r2 = Math.max(2, Math.round(big * 0.0016));
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
  var TUNE = { tau: 0.05, rOut: 0.03, rIn: 0.006, iters: 3, toe: 0.03, pf: 3, pb: 2, smooth: 1, kv: 15, vlo: 0.003, vhi: 0.012, hiT: 0.5 };
  /* rgba: Uint8ClampedArray w*h*4 of the photo at working size. p: Float32Array w*h, mask 0..1 at the same size.
     Returns { w, h, alpha: Uint8ClampedArray, fg: Uint8ClampedArray (RGBA, A = where to use the cleaned color) }. */
  function refineNew(rgba, p, w, h, opts) {
    var T = {}; for (var kk in TUNE) T[kk] = (g.BK_TUNE && g.BK_TUNE[kk] !== undefined) ? g.BK_TUNE[kk] : TUNE[kk];
    var n = w * h, blur = Blur(w, h), i, j, k, it;
    var big = Math.max(w, h);
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
      else { v = (v - toe) / (1 - toe); v = v < 0 ? 0 : v > 1 ? 1 : v; }
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
  function refine(rgba, p, w, h, opts) {
    var T = {}; for (var kk in TUNE) T[kk] = (g.BK_TUNE && g.BK_TUNE[kk] !== undefined) ? g.BK_TUNE[kk] : TUNE[kk];
    var base = refineBase(rgba, p, w, h, opts);
    var nu = refineNew(rgba, p, w, h, opts);
    if (!nu.uvar) return base;
    var n = w * h, big = Math.max(w, h), i, j, blur = Blur(w, h);
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
  g.BKMatte = { refine: refine };
})(self);

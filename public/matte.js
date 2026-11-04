/* Edge refinement for Background Killer.
   1. The model's 1024 px mask is upscaled, then snapped to the real edges of the photo with a guided filter (He et al.),
      so the outline follows hair and fur instead of the blocky model output.
   2. Foreground colors are re-estimated near the edge with blur fusion (Forte and Pitie), so the old background does not
      leave a halo on semi-transparent pixels. */
(function (g) {
  function box(src, w, h, r, out, tmp) {
    // Mean filter with edge-normalised window, separable, running sums.
    var x, y, i, s, c, lo, hi;
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
  /* rgba: Uint8ClampedArray w*h*4 of the photo at working size. p: Float32Array w*h, mask 0..1 at the same size.
     Returns { w, h, alpha: Uint8ClampedArray, fg: Uint8ClampedArray (RGBA, A = where to use the cleaned color) }. */
  function refine(rgba, p, w, h, opts) {
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
  g.BKMatte = { refine: refine };
})(self);

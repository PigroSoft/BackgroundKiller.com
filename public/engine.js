/* Clean Cut inference engine. Runs in a Web Worker or on the main thread.
   Model: ISNet general-use (Apache-2.0). Weights stored as 8-bit per channel, maths in full precision. Input 1x3x1024x1024. */
(function (g) {
  var SIZE = 1024;
  var Engine = {
    session: null,
    init: async function (modelBytes, base) {
      ort.env.wasm.wasmPaths = base + 'ort/';
      ort.env.wasm.numThreads = g.crossOriginIsolated ? Math.min(4, (g.navigator && g.navigator.hardwareConcurrency) || 2) : 1;
      ort.env.wasm.proxy = false;
      this.session = await ort.InferenceSession.create(modelBytes, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all'
      });
    },
    /* rgba: Uint8ClampedArray of a 1024x1024 RGBA image. Returns a 1024x1024 Uint8ClampedArray mask. */
    run: async function (rgba) {
      var N = SIZE * SIZE, f = new Float32Array(3 * N);
      for (var i = 0, j = 0; i < N; i++, j += 4) {
        f[i] = rgba[j] / 255 - 0.5;
        f[N + i] = rgba[j + 1] / 255 - 0.5;
        f[2 * N + i] = rgba[j + 2] / 255 - 0.5;
      }
      var feeds = { input_image: new ort.Tensor('float32', f, [1, 3, SIZE, SIZE]) };
      var out = await this.session.run(feeds, ['output_image']);
      var m = out.output_image.data, mn = Infinity, mx = -Infinity;
      for (var k = 0; k < N; k++) { var v = m[k]; if (v < mn) mn = v; if (v > mx) mx = v; }
      var range = mx - mn || 1, u = new Uint8ClampedArray(N);
      for (var p = 0; p < N; p++) u[p] = ((m[p] - mn) / range) * 255;
      return u;
    }
  };
  g.CleanCutEngine = Engine;
})(self);

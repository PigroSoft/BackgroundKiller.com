/* Runs the cutout model off the main thread so the page stays responsive. */
var ORT_URL = 'ort/ort.wasm.min.js';
var loadError = null;
try { importScripts(ORT_URL, 'engine.js'); } catch (e) { loadError = String((e && e.message) || e); }

onmessage = async function (e) {
  var d = e.data;
  if (loadError) { postMessage({ type: 'error', id: d.id, stage: 'load', message: loadError }); return; }
  try {
    if (d.type === 'init') {
      await CleanCutEngine.init(d.model, d.base);
      postMessage({ type: 'ready' });
    } else if (d.type === 'run') {
      var mask = await CleanCutEngine.run(d.rgba);
      postMessage({ type: 'mask', id: d.id, mask: mask }, [mask.buffer]);
    }
  } catch (err) {
    postMessage({ type: 'error', id: d.id, stage: d.type, message: String((err && err.message) || err) });
  }
};

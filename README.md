# Background Killer

backgroundkiller.com: a free background remover that runs entirely in the browser. No server, no uploads, full-resolution downloads.

## How it works
- `public/` is the whole site. Plain HTML, CSS and JavaScript, no build step.
- The cutout model (ISNet general-use, Apache-2.0, 8-bit quantized, 46 MB) lives in `public/model/` as four chunks named `.wasm` so any static host serves them. The browser reassembles them and caches the result with the Cache API.
- ONNX Runtime Web 1.20.1 (`public/ort/`) runs the model in a Web Worker (`worker.js`, `engine.js`).
- Fonts (Anton, Inter), JSZip and the runtime are all self-hosted, so the page makes no third-party requests.

## Deploy (Cloudflare Workers with static assets)
`wrangler.jsonc` points Cloudflare at `public/`. Connect this repo in the Cloudflare dashboard (Workers & Pages, Create, Import a repository), leave the build command empty and keep the default deploy command `npx wrangler deploy`. Every push to the main branch redeploys.

Do not add COOP/COEP headers to get multi-threaded WASM: they block ad iframes.

## Ads
Two slots are in the markup (`.ad-leader`, `.ad-rect`) and hidden by default. When ads are approved, put the ad code in them and add `class="ads-on"` to `<body>`. Add a consent banner and an imprint (Impressum) page at the same time, and update `public/privacy.html`.

## Local preview
`cd public && python3 -m http.server 8000`

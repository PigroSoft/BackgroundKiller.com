# Changelog

The version number and date live in `public/version.js`. To release, change them there and add an entry here. Keep `public/CHANGELOG.txt` the same as this file.

## 1.0.5, 6 November 2026

- Home page: a lighter checkerboard, a higher fade to black on wide screens so less of Claw's coat shows, and dark backing behind the small tip and sample text so it can be read.

## 1.0.4, 6 November 2026

- Edge refinement is up to twice as fast. The result is the same.
- Faint, unsure patches of mask that run off the edge of the photo, like a blurred window frame touching the subject, are now dropped.

## 1.0.3, 6 November 2026

- Faint smears of motion blur far from the subject are now dropped, so stray streaks no longer hang off tails and ears.

## 1.0.2, 6 November 2026

- Finer cutouts: wisps of fur and hair now survive, especially against plain backgrounds.
- The preview now sits on a transparent checkerboard by default. Downloads were always transparent.
- One real sample photo (a ragdoll kitten, CC BY 4.0) replaces the generated ones.
- The batch zip button moved below the photos, and the preview stays in view while you scroll the controls.

## 1.0.1, 5 November 2026

- The source code is now public on GitHub under the MIT licence, linked from the footer and the About page.

## 1.0, 4 November 2026

First public version.

- Removes the background from photos in the browser, with the ISNet model and ONNX Runtime Web. Photos are not uploaded.
- Full-size downloads as PNG or WebP, with a transparent or colored background.
- Edge refinement and color cleanup at the rim of the cutout.
- Erase and restore brush, with undo and redo.
- Four extra ways to cut a photo when the first try is off.
- Batches: drop in many photos, see progress, get a notification when done, and download them all as a zip or save them to a folder.
- Guides, imprint, privacy text in English and German, terms, licenses and credits.
- Source code under the MIT licence.

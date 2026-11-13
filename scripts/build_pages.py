#!/usr/bin/env python3
"""Generates the guide and legal pages in public/ and refreshes the shared footer, FAQ and
structured data inside public/index.html. Run from the repo root: python3 scripts/build_pages.py
The generated HTML is committed, so the site itself still needs no build step."""
import json, re, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent / "public"
SITE = "https://backgroundkiller.com"
UPDATED = "6 November 2026"

# ---------------------------------------------------------------- shared pieces
GUIDES = [
    ("/remove-bg-alternative", "Free remove.bg alternative"),
    ("/remove-background-from-image", "Remove the background from an image"),
    ("/make-png-transparent", "Make a transparent PNG"),
    ("/product-photo-background-remover", "Product photo backgrounds"),
]
LEGAL = [("/about", "About"), ("/imprint", "Imprint"), ("/privacy", "Privacy"), ("/terms", "Terms"), ("/licenses", "Licenses")]

FOOTER = """<footer class="site-footer">
  <div class="footer-brand">
    <a class="wordmark" href="/" aria-label="Background Killer home">Background<b>Killer</b><small>.com</small></a>
    <p class="tagline">The background had it coming.</p>
    <a class="star-btn" href="https://github.com/PigroSoft/BackgroundKiller.com" target="_blank" rel="noopener"><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M8 .25a.75.75 0 0 1 .67.42l1.88 3.8 4.2.61a.75.75 0 0 1 .42 1.28l-3.04 2.96.72 4.18a.75.75 0 0 1-1.09.79L8 12.55l-3.76 1.98a.75.75 0 0 1-1.09-.79l.72-4.18L1.83 6.36a.75.75 0 0 1 .42-1.28l4.2-.61 1.88-3.8A.75.75 0 0 1 8 .25Z"/></svg><span>Star on GitHub</span></a>
  </div>
  <nav class="footer-col" aria-label="Guides"><h2>Guides</h2>%s</nav>
  <nav class="footer-col" aria-label="Legal"><h2>Legal</h2>%s</nav>
  <p class="copy">A <a href="https://pigrosoft.com/">Pigrosoft</a> product <span class="sep">&middot;</span> &copy; 2026 <span class="sep">&middot;</span> <a id="bkVersion" href="/CHANGELOG.txt">Version</a> <span class="sep">&middot;</span> <a href="https://pigrosoft.com/bug-report?site=BackgroundKiller" referrerpolicy="unsafe-url" target="_blank" rel="noopener">Report a bug</a></p>
  <script src="/version.js"></script>
  <script src="https://stats.pigrosoft.com/c.js" defer></script>
</footer>""" % (
    "".join('<a href="%s">%s</a>' % g for g in GUIDES),
    "".join('<a href="%s">%s</a>' % g for g in LEGAL),
)

HEADER = """<header class="site-header" style="border-bottom:1px solid var(--line)">
  <a class="logo" href="/" aria-label="Background Killer home">
    <span class="wordmark">Background<b>Killer</b><small>.com</small></span>
  </a>
</header>"""

def head(title, desc, path, extra=""):
    url = SITE + path
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{title}</title>
<meta name="description" content="{desc}">
<meta name="theme-color" content="#101112">
<link rel="canonical" href="{url}">
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Background Killer">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{desc}">
<meta property="og:url" content="{url}">
<meta property="og:image" content="{SITE}/og.jpg">
<meta name="twitter:card" content="summary_large_image">
<link rel="preload" href="/fonts/anton-latin-400-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/styles.css">
{extra}</head>
<body>
"""

def breadcrumb(name, path):
    return '<script type="application/ld+json">%s</script>\n' % json.dumps({
        "@context": "https://schema.org", "@type": "BreadcrumbList",
        "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "Background Killer", "item": SITE + "/"},
            {"@type": "ListItem", "position": 2, "name": name, "item": SITE + path}]})

def page(path, title, desc, body, crumb=None, robots=None):
    extra = breadcrumb(crumb, path) if crumb else ""
    if robots:
        extra += '<meta name="robots" content="%s">\n' % robots
    html = head(title, desc, path, extra) + HEADER + "\n<main class=\"page article\">\n" + body.strip() + "\n</main>\n" + FOOTER + "\n</body>\n</html>\n"
    (ROOT / (path.strip("/") + ".html")).write_text(html, encoding="utf-8")

CTA = '<p class="cta"><a class="btn btn-primary btn-lg" href="/">Remove a background</a></p>'

def related(skip):
    items = "".join('<li><a href="%s">%s</a></li>' % g for g in GUIDES if g[0] != skip)
    return '<h2>More guides</h2>\n<ul>%s</ul>' % items

# ---------------------------------------------------------------- home FAQ (visible text and JSON-LD come from here)
FAQ = [
    ("Is Background Killer really free?",
     "Yes. There are no credits, accounts or watermarks, and you can cut out as many photos as you like."),
    ("Is this a remove.bg alternative?",
     'Yes. remove.bg has announced that its standalone website will close on 1 December 2026. Background Killer does the same basic job, and the free download is full size. <a href="/remove-bg-alternative">Here is how they compare</a>.'),
    ("Do you upload my photo?",
     'No. The cutout model runs in your browser, on your own computer, and the page never sends your photo anywhere. The model is about 47 MB, so it downloads the first time you visit and is saved for next time. You can check this yourself: <a href="/privacy#check">here is how</a>.'),
    ("How big can the download be?",
     "It matches your original photo, pixel for pixel. Nothing is scaled down. Very large photos use a lot of memory, so on an older phone a huge image may fail. If that happens, try a smaller version."),
    ("How do I remove the background from a photo?",
     'Click Upload image, or drop a photo on the page, and wait a moment for the cutout. Then press Download full size. For a white, black or colored background, open Clean getaway and pick one first. <a href="/remove-background-from-image">The full steps are here</a>.'),
    ("Which files work?",
     "JPG, PNG and WebP. HEIC photos work in browsers that can open them, such as Safari. Downloads are PNG or WebP, and both keep transparency."),
    ("What if it misses a spot?",
     "Open Sharpen the claws, choose Erase to brush away leftovers, or Restore to bring back anything it cut by mistake. Undo is right there."),
    ("What are the checkerboard squares?",
     "They show transparent areas in the preview. They are not part of the file you download."),
    ("Can I do a lot of photos at once?",
     'Yes. Drop in 20 or more at once, or add more while others are still cutting. The newest opens right away, the rest keep going in the background, and the little previews at the bottom jump between them. When they are done, Download all gives you one zip of full-size cutouts. This is handy for <a href="/product-photo-background-remover">product photos</a>.'),
    ("What if the cutout is wrong?",
     "Open Something fishy? and try another way. There are four: keep proportions, zoom in on the subject, double check, and boost contrast. Each runs the model differently, and you can switch back to the first try at any time. Then tidy anything left with Erase and Restore."),
    ("Who is the cat?",
     "That is Claw. He handles the backgrounds."),
]

def strip_tags(s):
    return re.sub(r"<[^>]+>", "", s)

def faq_html():
    return "\n".join('<details><summary>%s</summary><p>%s</p></details>' % (q, a) for q, a in FAQ)

def home_jsonld():
    app = {
        "@context": "https://schema.org", "@type": "WebApplication",
        "name": "Background Killer", "url": SITE + "/",
        "description": "Free background remover that runs in your browser. Cut out the subject of a photo and download a full-size transparent PNG with no account and no upload.",
        "applicationCategory": "MultimediaApplication", "operatingSystem": "Any (modern web browser)",
        "browserRequirements": "Requires JavaScript and WebAssembly",
        "offers": {"@type": "Offer", "price": "0", "priceCurrency": "EUR"},
        "creator": {"@type": "Organization", "name": "Pigrosoft", "url": "https://pigrosoft.com/"},
    }
    faq = {"@context": "https://schema.org", "@type": "FAQPage",
           "mainEntity": [{"@type": "Question", "name": q, "acceptedAnswer": {"@type": "Answer", "text": strip_tags(a)}} for q, a in FAQ]}
    return '<script type="application/ld+json">%s</script>\n<script type="application/ld+json">%s</script>' % (json.dumps(app), json.dumps(faq))

# ---------------------------------------------------------------- guides
page("/remove-bg-alternative",
     "Free remove.bg Alternative, Full Size | Background Killer",
     "remove.bg is closing its standalone site on 1 December 2026. Background Killer is a free alternative with full-size downloads, no account and no upload.",
     """
<h1>A free remove.bg alternative</h1>
<p class="lead">remove.bg has announced that its standalone website and self-serve API will close on 1 December 2026, when background removal moves into Canva. If you used remove.bg to cut out photos, Background Killer does the same job for free, in your browser.</p>
""" + CTA + """
<h2>What stays the same</h2>
<p>You add a photo, the subject is cut out, and you download a PNG with a transparent background. You can also put the subject on white, black or any color before you download.</p>
<h2>What is different</h2>
<ul>
<li><strong>Full size is free.</strong> remove.bg's help page says free use covers images up to 0.25 megapixels, with higher resolution on paid plans. Background Killer downloads your cutout at the same pixel size as your original photo.</li>
<li><strong>No account and no credits.</strong> There is nothing to sign up for and nothing to run out of.</li>
<li><strong>Your photo stays on your device.</strong> The cutout model runs in your browser, so the image is never uploaded.</li>
<li><strong>Batches.</strong> Drop in 20 photos at once, jump between them with the previews at the bottom, then download them all as one zip.</li>
<li><strong>Another try when it misses.</strong> If a cutout is off, you can rerun it a different way, for example zoomed in on the subject.</li>
<li><strong>A brush for edges.</strong> Erase leftovers, or restore parts the model cut by mistake.</li>
</ul>
<h2>What to know before you switch</h2>
<ul>
<li>Background Killer is a website. It is not an API or a plugin, so it does not replace remove.bg's API or its Photoshop plugin.</li>
<li>Speed depends on your computer, because the work happens on your device. Expect some seconds per photo, and longer on an old phone.</li>
<li>The first visit downloads a 47 MB model. After that it is saved in your browser.</li>
<li>Results are good on most photos but not perfect. Very fine hair, glass and see-through objects can need a touch-up with the brush.</li>
</ul>
<h2>How to switch in four steps</h2>
<ol>
<li>Open <a href="/">backgroundkiller.com</a> and click Upload image, or drop a photo on the page.</li>
<li>Wait for the cutout. The first time takes longer because the model downloads once.</li>
<li>Tidy the edges with Erase and Restore if you need to.</li>
<li>Open Clean getaway if you want a background, then press Download full size.</li>
</ol>
""" + related("/remove-bg-alternative") + "\n" + CTA,
     crumb="Free remove.bg alternative")

page("/remove-background-from-image",
     "Remove the Background From an Image for Free | Background Killer",
     "Remove the background from any image in four steps. Free, no sign-up, and the download keeps the full size of your original photo.",
     """
<h1>Remove the background from an image</h1>
<p class="lead">You can remove the background from a photo in under a minute, for free, without an account. The cutout happens in your browser, and the download keeps your photo's full size.</p>
""" + CTA + """
<h2>Four steps</h2>
<ol>
<li><strong>Add your photo.</strong> Click Upload image, drag a file onto the page, or paste one with Ctrl+V or &#8984;V. JPG, PNG and WebP work, and HEIC works in browsers that can open it, such as Safari.</li>
<li><strong>Wait for the cutout.</strong> The first visit downloads the cutout model once, about 47 MB, and then keeps it for next time. After that, each photo takes some seconds, depending on your computer.</li>
<li><strong>Fix the edges if needed.</strong> In Sharpen the claws, choose Erase to brush away leftover background, or Restore to bring back parts of the subject that were cut by mistake. Change the brush size to suit the detail, and use Undo if you slip.</li>
<li><strong>Choose a background and download.</strong> Keep it transparent, or open Clean getaway and choose white, black, red or any color. Press Download full size, or Copy image to paste it straight into another app.</li>
</ol>
<h2>Tips for a cleaner cutout</h2>
<ul>
<li>Use the original photo, not a screenshot, so you keep all the pixels.</li>
<li>Contrast helps. A subject that differs from its background in color or brightness cuts out more cleanly.</li>
<li>Keep the whole subject inside the frame. The model handles a subject cropped by the edge, but the result is usually tidier when nothing is cut off.</li>
<li>Use the Edges slider to make the outline softer or sharper, and Trim to the subject to crop away empty space.</li>
</ul>
<h2>Which format to download</h2>
<p>PNG works almost everywhere and keeps transparency. WebP also keeps transparency and makes smaller files, which is useful for websites. A JPG cannot be transparent, so choose a solid background color if you need one.</p>
<h2>Common problems</h2>
<ul>
<li><strong>Part of the subject is missing.</strong> Switch to Restore and brush over it.</li>
<li><strong>A bit of background is left.</strong> Switch to Erase and brush over it.</li>
<li><strong>It is slow.</strong> Large photos take longer, because your own device does the work. Close other heavy tabs and try again.</li>
<li><strong>The file is big.</strong> The download matches your original size on purpose. Choose WebP for a smaller file.</li>
</ul>
""" + related("/remove-background-from-image") + "\n" + CTA,
     crumb="Remove the background from an image")

page("/make-png-transparent",
     "Make a Transparent PNG From Any Photo | Background Killer",
     "Turn a photo into a PNG with a transparent background. Free, runs in your browser, and keeps the full resolution of your original image.",
     """
<h1>Make a transparent PNG</h1>
<p class="lead">A transparent PNG is a picture with no background, so it can sit on top of any color, photo or slide. Background Killer makes one from an ordinary photo in a few clicks, for free.</p>
""" + CTA + """
<h2>How transparency works</h2>
<p>PNG and WebP files can store an alpha channel, which says how see-through each pixel is. Where the alpha is zero, you see whatever is behind the image. JPG files have no alpha channel, so they can never be transparent.</p>
<h2>Make one in three steps</h2>
<ol>
<li>Add your photo on <a href="/">backgroundkiller.com</a>.</li>
<li>Leave the background set to transparent, which is the checkerboard swatch.</li>
<li>Open Clean getaway, choose PNG as the format, and press Download full size.</li>
</ol>
<p>The checkerboard you see in the preview only marks the empty areas. It is not baked into the file.</p>
<h2>Check that your file is really transparent</h2>
<p>Open the PNG in a design tool or presentation app and place it over a colored shape. If the color shows through around the subject, the file is transparent. Many image viewers show a white or gray background instead, which can make a transparent file look solid.</p>
<h2>Where transparent PNGs are useful</h2>
<ul>
<li>Slides and documents, such as Keynote, PowerPoint and Google Slides.</li>
<li>Design tools, such as Figma and Canva, for collages and mockups.</li>
<li>Websites, where a cutout can sit on any section color.</li>
<li>Stickers, labels and print layouts.</li>
</ul>
<h2>What it does not do well</h2>
<p>Background Killer is built for photos with a clear subject. For flat logos or graphics with a single background color, a color-based eraser in an image editor can give a sharper edge. For photos with fine hair or glass, expect to touch up the edges with the Erase and Restore brush.</p>
""" + related("/make-png-transparent") + "\n" + CTA,
     crumb="Make a transparent PNG")

page("/product-photo-background-remover",
     "Remove the Background From Product Photos | Background Killer",
     "Cut out product photos in bulk and put them on pure white or any color. Free, full-size downloads, and no upload.",
     """
<h1>Remove backgrounds from product photos</h1>
<p class="lead">Clean, consistent backgrounds make a shop look tidier, and many marketplaces expect a plain white background on the main photo. Background Killer cuts out a whole batch of product photos and saves them as one zip.</p>
""" + CTA + """
<h2>Several photos in five steps</h2>
<ol>
<li>Drop in all your photos at once, or add more at any time. They are cut out one after another.</li>
<li>Click each preview at the bottom to check the result. If one is off, try Something fishy?, then fix edges with Sharpen the claws.</li>
<li>Choose the white swatch for a pure white background. Marketplaces such as Amazon ask for pure white on main images, so check the current rules for the one you sell on.</li>
<li>Keep Trim to the subject switched on and set the same margin for every photo, so the products look consistent.</li>
<li>Choose PNG or WebP and press Download all as .zip.</li>
</ol>
<h2>Take photos that cut out well</h2>
<ul>
<li>Shoot on a plain surface in soft light.</li>
<li>Keep the whole product in the frame, with a little space around it.</li>
<li>Avoid white products on a white surface. The model needs some contrast to find the edge.</li>
<li>Shoot at full camera resolution. The download keeps the size you give it, and many marketplaces want at least 1,000 pixels on the long side.</li>
</ul>
<h2>Things to know</h2>
<ul>
<li>Shadows disappear with the background. If you want a soft shadow under the product, add one in your editor afterwards.</li>
<li>Glass, bottles and shiny edges are hard for any automatic tool. Expect to use the brush on them.</li>
<li>Your photos are processed on your own computer and are never uploaded, which is useful for unreleased products.</li>
</ul>
""" + related("/product-photo-background-remover") + "\n" + CTA,
     crumb="Product photo backgrounds")

# ---------------------------------------------------------------- legal pages

page("/about",
     "About Background Killer",
     "Who makes Background Killer, how it works, and under which licence.",
     """
<h1>About</h1>
<p class="lead">Background Killer is a free tool that removes the background from a photo, on your own computer.</p>
<h2>Who makes it</h2>
<p>Background Killer is made by Jeffrey Humble and <a href="https://pigrosoft.com/">Pigrosoft</a>, a small software company in Berlin. To reach us, write to <a href="mailto:support@pigrosoft.com">support@pigrosoft.com</a>. Our postal address and VAT ID are in the <a href="/imprint">imprint</a>.</p>
<h2>How it works</h2>
<p>The cutout runs inside your browser. It uses the ISNet model, which is licensed under Apache-2.0, and ONNX Runtime Web, which is licensed under MIT. Your photo does not leave your device. The page says exactly what it downloads in the <a href="/privacy#check">privacy text</a>, with steps to check it in your browser's network tab. The scripts that run on the page are plain JavaScript, so you can read them with your browser's developer tools.</p>
<h2>Licence</h2>
<p>Background Killer is open source. The <a href="https://github.com/PigroSoft/BackgroundKiller.com">source code is on GitHub</a>, released under the MIT licence. Read it in <a href="/LICENSE.txt">LICENSE</a>. The name, logo, Claw artwork and sample photos are not part of that licence. The model, software and fonts we use keep their own licences, which are listed with credits on the <a href="/licenses">licenses page</a>.</p>
<h2>Version</h2>
<p>The current version and its date are in the footer of every page. What changed in each version is in the <a href="/CHANGELOG.txt">changelog</a>.</p>
""", crumb="About")

page("/imprint",
     "Imprint | Background Killer",
     "Legal notice (Impressum) for backgroundkiller.com.",
     """
<h1>Imprint</h1>
<p><a href="#de">Deutsche Version</a></p>
<h2>Legal notice</h2>
<p>Information according to &sect; 5 DDG (German Digital Services Act).</p>
<p><strong>Provider</strong><br>Jeffrey Humble (Pigrosoft)<br>Peschkestr. 5<br>12161 Berlin<br>Germany</p>
<p><strong>Contact</strong><br>Email: <a href="mailto:support@pigrosoft.com">support@pigrosoft.com</a></p>
<p><strong>VAT ID</strong><br>VAT identification number according to &sect; 27a of the German VAT Act (UStG): DE334424725</p>
<p><strong>Responsible for content according to &sect; 18(2) MStV</strong><br>Jeffrey Humble, Peschkestr. 5, 12161 Berlin, Germany</p>
<h2>Consumer dispute resolution</h2>
<p>We are neither obliged nor willing to take part in dispute resolution proceedings before a consumer arbitration board.</p>
<h2 id="de" lang="de">Impressum</h2>
<div lang="de">
<p>Angaben gem&auml;&szlig; &sect; 5 DDG.</p>
<p><strong>Anbieter</strong><br>Jeffrey Humble (Pigrosoft)<br>Peschkestr. 5<br>12161 Berlin<br>Deutschland</p>
<p><strong>Kontakt</strong><br>E-Mail: <a href="mailto:support@pigrosoft.com">support@pigrosoft.com</a></p>
<p><strong>Umsatzsteuer-ID</strong><br>Umsatzsteuer-Identifikationsnummer gem&auml;&szlig; &sect; 27a UStG: DE334424725</p>
<p><strong>Verantwortlich f&uuml;r den Inhalt nach &sect; 18 Abs. 2 MStV</strong><br>Jeffrey Humble, Peschkestr. 5, 12161 Berlin, Deutschland</p>
<h3>Verbraucherstreitbeilegung</h3>
<p>Wir sind weder verpflichtet noch bereit, an Streitbeilegungsverfahren vor einer Verbraucherschlichtungsstelle teilzunehmen.</p>
</div>
""", robots="index,follow")

page("/privacy",
     "Privacy Policy | Background Killer",
     "How backgroundkiller.com handles data. Photos are processed in your browser and are not uploaded.",
     """
<h1>Privacy</h1>
<p>Last updated: %(u)s. <a href="#de">Deutsche Version</a></p>
<h2>Controller</h2>
<p>Jeffrey Humble (Pigrosoft), Peschkestr. 5, 12161 Berlin, Germany. Email: <a href="mailto:support@pigrosoft.com">support@pigrosoft.com</a>. See also the <a href="/imprint">imprint</a>.</p>
<h2>The short version</h2>
<p>Background Killer removes backgrounds inside your browser. The photos you add are processed on your own device and are not uploaded to us or to anyone else. The site has no accounts and sets no cookies. It counts visits with a small counter of our own that stores nothing about you, described under &ldquo;Visit counter&rdquo; below.</p>
<h2>Your photos</h2>
<p>When you add an image, your browser reads it and the cutout model runs on your device. The image, the cutout and your edits stay in your browser's memory and are gone when you close or reload the page, unless you download them. We never receive them.</p>
<h2>What the page downloads</h2>
<p>The first time you visit, the page downloads the cutout model (about 47 MB) from this site and saves it in your browser's cache. After that it loads from the cache and the page needs no download for it. Besides the model, the page loads its own text, fonts, images and scripts from this site. Every one of these is a plain request for a file. No request carries your photo or anything made from it.</p>
<h2>Data stored on your device</h2>
<p>The model is kept in your browser's cache so it only has to download once. This is needed to provide the function you asked for, and it contains no personal information. If you switch on "Notify me when done", the page also saves that choice in your browser's local storage. You can remove both at any time by clearing the site's data in your browser settings. We do not set cookies.</p>
<h2>Visit counter</h2>
<p>To know roughly how many people use the site, we count visits with a small counter that we built ourselves and run on Cloudflare, the same host that delivers this site. It takes the place of the usual analytics services, so your browser does not contact Google, Meta or any other analytics company. When a page loads, your browser sends one small request to stats.pigrosoft.com with the address of the page and, if your browser shares it, the name of the website that sent you (the hostname only, never a full address). The counter mixes your IP address and browser type with the site name and a secret code that is replaced every day, and keeps only the result, so that you are not counted twice on the same day. It then adds one to that day&rsquo;s totals for the site, the page and the referring website. Your IP address is not stored, no cookies are set, nothing is saved in your browser, and the day&rsquo;s results and secret code are deleted when the next day starts. The daily totals cannot be tied to a person, and no photo or anything made from it is ever part of this request. Cloudflare processes the request as our host, as described below. The legal basis is Art. 6(1)(f) GDPR, our interest in knowing how many people use the site. You can object at any time by emailing us.</p>
<h2 id="check">How to check this yourself</h2>
<p>Open your browser's developer tools (F12, or Cmd+Option+I on a Mac) and go to the Network tab. Drop in a photo and watch the list. You will see no upload: only GET requests for files from backgroundkiller.com, plus one small request to stats.pigrosoft.com, our own counter, when the page opens. Once the model has loaded, the page makes no more requests. Switch the browser to offline mode once the page has loaded, and the tool keeps working.</p>
<h2>Hosting and server logs</h2>
<p>The site is delivered by Cloudflare, Inc. (USA). When you open a page, your browser sends a request that includes your IP address, the time, the page requested and technical details such as your browser type. Cloudflare processes this data to deliver the site and keep it secure, and may keep it in server logs. We do not run our own logs. These requests never contain your photos. The legal basis is Art. 6(1)(f) GDPR, our interest in a secure and reliable website. Where data is transferred to the United States, this relies on the safeguards described in Cloudflare's data processing terms, such as the EU-US Data Privacy Framework and standard contractual clauses. Cloudflare's own privacy policy applies as well.</p>
<h2>Fonts and other resources</h2>
<p>Fonts, scripts and images are served from this site itself. Your browser does not contact Google or other third parties to display it. The only other address the page contacts is stats.pigrosoft.com, our own counter, described above.</p>
<h2>Contacting us</h2>
<p>If you email us, we use your message and address only to reply and keep them as long as needed for that purpose. The legal basis is Art. 6(1)(f) GDPR, or Art. 6(1)(b) if your message relates to a contract.</p>
<h2>Your rights</h2>
<p>You have the right to access, rectification, erasure, restriction of processing, data portability and objection under the GDPR. You can also lodge a complaint with a supervisory authority, for example the Berlin Commissioner for Data Protection and Freedom of Information (Berliner Beauftragte f&uuml;r Datenschutz und Informationsfreiheit), Alt-Moabit 59-61, 10555 Berlin, Germany.</p>

<h2 id="de" lang="de">Datenschutzerkl&auml;rung</h2>
<div lang="de">
<p>Stand: 4. November 2026.</p>
<h3>Verantwortlicher</h3>
<p>Jeffrey Humble (Pigrosoft), Peschkestr. 5, 12161 Berlin, Deutschland. E-Mail: <a href="mailto:support@pigrosoft.com">support@pigrosoft.com</a>. Siehe auch das <a href="/imprint#de">Impressum</a>.</p>
<h3>Kurzfassung</h3>
<p>Background Killer entfernt Hintergr&uuml;nde direkt in Ihrem Browser. Die Bilder, die Sie hinzuf&uuml;gen, werden auf Ihrem eigenen Ger&auml;t verarbeitet und nicht an uns oder Dritte hochgeladen. Die Website hat keine Benutzerkonten und setzt keine Cookies. Sie z&auml;hlt Besuche mit einem kleinen eigenen Z&auml;hler, der nichts &uuml;ber Sie speichert, siehe &bdquo;Besucherz&auml;hler&ldquo; unten.</p>
<h3>Ihre Fotos</h3>
<p>Wenn Sie ein Bild hinzuf&uuml;gen, liest Ihr Browser es ein, und das Modell zum Freistellen l&auml;uft auf Ihrem Ger&auml;t. Bild, Freisteller und Ihre Bearbeitungen bleiben im Arbeitsspeicher Ihres Browsers und sind weg, sobald Sie die Seite schlie&szlig;en oder neu laden, sofern Sie sie nicht herunterladen. Wir erhalten sie nie.</p>
<h3>Was die Seite herunterl&auml;dt</h3>
<p>Beim ersten Besuch l&auml;dt die Seite das Modell (etwa 47 MB) von dieser Website herunter und speichert es im Cache Ihres Browsers. Danach wird es aus dem Cache geladen. Au&szlig;erdem l&auml;dt die Seite ihre eigenen Texte, Schriften, Bilder und Skripte von dieser Website. Jede dieser Anfragen ist eine einfache Anfrage nach einer Datei. Keine Anfrage enth&auml;lt Ihr Foto oder etwas, das daraus erzeugt wurde.</p>
<h3>Auf Ihrem Ger&auml;t gespeicherte Daten</h3>
<p>Das Modell liegt im Cache Ihres Browsers, damit es nur einmal geladen werden muss. Das ist f&uuml;r die von Ihnen gew&uuml;nschte Funktion erforderlich und enth&auml;lt keine personenbezogenen Daten. Wenn Sie &bdquo;Benachrichtigen, wenn fertig&ldquo; einschalten, speichert die Seite diese Wahl zus&auml;tzlich im lokalen Speicher Ihres Browsers. Sie k&ouml;nnen beides jederzeit entfernen, indem Sie die Websitedaten in den Browsereinstellungen l&ouml;schen. Wir setzen keine Cookies.</p>
<h3>Besucherz&auml;hler</h3>
<p>Um ungef&auml;hr zu wissen, wie viele Menschen die Website nutzen, z&auml;hlen wir Besuche mit einem kleinen Z&auml;hler, den wir selbst gebaut haben und bei Cloudflare betreiben, dem Hoster, der auch diese Website ausliefert. Er ersetzt die &uuml;blichen Analysedienste, daher nimmt Ihr Browser keinen Kontakt zu Google, Meta oder einem anderen Analyseanbieter auf. Beim Laden einer Seite sendet Ihr Browser eine kleine Anfrage an stats.pigrosoft.com mit der Adresse der Seite und, sofern Ihr Browser ihn mitsendet, dem Namen der Website, von der Sie kommen (nur der Hostname, nie die vollst&auml;ndige Adresse). Der Z&auml;hler vermischt Ihre IP-Adresse und Ihren Browsertyp mit dem Namen der Website und einem geheimen Code, der jeden Tag ersetzt wird, und beh&auml;lt nur das Ergebnis, damit Sie am selben Tag nicht doppelt gez&auml;hlt werden. Anschlie&szlig;end erh&ouml;ht er die Tageszahlen f&uuml;r die Website, die Seite und die verweisende Website um eins. Ihre IP-Adresse wird nicht gespeichert, es werden keine Cookies gesetzt, nichts wird in Ihrem Browser abgelegt, und die Ergebnisse und der geheime Code des Tages werden gel&ouml;scht, sobald der n&auml;chste Tag beginnt. Die Tageszahlen lassen sich keiner Person zuordnen, und kein Foto und nichts, das daraus erzeugt wurde, ist jemals Teil dieser Anfrage. Cloudflare verarbeitet die Anfrage als unser Hoster, wie unten beschrieben. Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO, unser Interesse daran zu wissen, wie viele Menschen die Website nutzen. Sie k&ouml;nnen jederzeit per E-Mail widersprechen.</p>
<h3 id="pruefen">So pr&uuml;fen Sie es selbst</h3>
<p>&Ouml;ffnen Sie die Entwicklerwerkzeuge Ihres Browsers (F12, am Mac Cmd+Option+I) und gehen Sie zum Tab &bdquo;Netzwerk&ldquo;. Ziehen Sie ein Foto auf die Seite und beobachten Sie die Liste. Sie sehen keinen Upload, nur GET-Anfragen nach Dateien von backgroundkiller.com und beim &Ouml;ffnen der Seite eine kleine Anfrage an stats.pigrosoft.com, unseren eigenen Z&auml;hler. Nach dem Laden des Modells macht die Seite keine weiteren Anfragen. Schalten Sie den Browser nach dem Laden der Seite offline, und das Werkzeug arbeitet weiter.</p>
<h3>Hosting und Server-Logs</h3>
<p>Die Website wird von Cloudflare, Inc. (USA) ausgeliefert. Beim Aufruf einer Seite sendet Ihr Browser eine Anfrage, die Ihre IP-Adresse, die Uhrzeit, die angeforderte Seite und technische Angaben wie den Browsertyp enth&auml;lt. Cloudflare verarbeitet diese Daten, um die Website auszuliefern und abzusichern, und speichert sie gegebenenfalls in Server-Logs. Wir f&uuml;hren keine eigenen Logs. Diese Anfragen enthalten nie Ihre Fotos. Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO, unser Interesse an einer sicheren und zuverl&auml;ssigen Website. Soweit Daten in die USA &uuml;bermittelt werden, beruht dies auf den Garantien aus den Datenverarbeitungsbedingungen von Cloudflare, etwa dem EU-US Data Privacy Framework und Standardvertragsklauseln. Es gilt zus&auml;tzlich die Datenschutzerkl&auml;rung von Cloudflare.</p>
<h3>Schriften und andere Ressourcen</h3>
<p>Schriften, Skripte und Bilder werden von dieser Website selbst ausgeliefert. Ihr Browser nimmt dazu keinen Kontakt zu Google oder anderen Dritten auf. Die einzige weitere Adresse, die die Seite kontaktiert, ist stats.pigrosoft.com, unser eigener Z&auml;hler, siehe oben.</p>
<h3>Kontakt</h3>
<p>Wenn Sie uns eine E-Mail schreiben, verwenden wir Ihre Nachricht und Adresse nur, um zu antworten, und speichern sie so lange, wie es daf&uuml;r erforderlich ist. Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO, bei vertragsbezogenen Anfragen Art. 6 Abs. 1 lit. b DSGVO.</p>
<h3>Ihre Rechte</h3>
<p>Sie haben nach der DSGVO das Recht auf Auskunft, Berichtigung, L&ouml;schung, Einschr&auml;nkung der Verarbeitung, Daten&uuml;bertragbarkeit und Widerspruch. Sie k&ouml;nnen sich au&szlig;erdem bei einer Aufsichtsbeh&ouml;rde beschweren, zum Beispiel bei der Berliner Beauftragten f&uuml;r Datenschutz und Informationsfreiheit, Alt-Moabit 59-61, 10555 Berlin.</p>
</div>
""" % {"u": UPDATED}, robots="index,follow")

page("/terms",
     "Terms of Use | Background Killer",
     "The terms for using backgroundkiller.com.",
     """
<h1>Terms of use</h1>
<p>Last updated: %(u)s</p>
<h2>1. What this is</h2>
<p>Background Killer is a free tool at backgroundkiller.com that removes the background from images in your browser. It is provided by Jeffrey Humble (Pigrosoft), Berlin (see the <a href="/imprint">imprint</a>). By using it, you agree to these terms.</p>
<h2>2. Free of charge</h2>
<p>The service is free. We may change it, limit it or stop it at any time.</p>
<h2>3. Your images</h2>
<p>Your images are processed on your own device and are not uploaded to us. They stay yours, and we claim no rights in them or in the results. You confirm that you have the right to edit the images you use, and that they do not break the law or the rights of others.</p>
<h2>4. Acceptable use</h2>
<p>Do not use the site to break the law, to attack or overload it, or to copy it in a way that harms the service. You may link to it freely.</p>
<h2>5. Results</h2>
<p>Automatic cutouts are not always perfect. We do not promise that a result is accurate, complete or suitable for a particular purpose. Check your results before you rely on them.</p>
<h2>6. Liability</h2>
<p>We are liable without limit for intent and gross negligence, for injury to life, body or health, and where the law requires it, such as under the Product Liability Act. For slightly negligent breaches of an essential obligation, liability is limited to the foreseeable damage typical for this kind of service. Otherwise we are not liable for slight negligence. This does not limit your statutory rights as a consumer.</p>
<h2>7. Software and content from others</h2>
<p>Background Killer includes software, a model and fonts from other authors, which are used under their own licenses. See <a href="/licenses">Licenses and credits</a>.</p>
<h2>8. Changes and law</h2>
<p>We may update these terms, and the version on this page applies from the date shown. German law applies, except that mandatory consumer protection rules of the country where you live are not affected.</p>
<h2>9. Contact</h2>
<p><a href="mailto:support@pigrosoft.com">support@pigrosoft.com</a></p>
""" % {"u": UPDATED}, robots="index,follow")

page("/licenses",
     "Licenses and Credits | Background Killer",
     "The model, software, fonts and images behind Background Killer, with their licenses.",
     """
<h1>Licenses and credits</h1>
<p class="lead">Background Killer is built on open work by other people. Here is what it uses and under which terms.</p>
<h2>This site's code</h2>
<p>The code of Background Killer is released under the MIT licence: <a href="/LICENSE.txt">LICENSE</a>. The licence covers the code only. The name Background Killer, the logo, the Claw artwork and the sample photos are not covered, and all rights in them stay with Pigrosoft. Version history is in the <a href="/CHANGELOG.txt">changelog</a>.</p>
<h2>The cutout model</h2>
<p>The model that finds the subject in your photo is <strong>ISNet general-use</strong>, from the DIS project (Dichotomous Image Segmentation) by Xuebin Qin and colleagues, released under the Apache License 2.0. It is described in &ldquo;Highly Accurate Dichotomous Image Segmentation&rdquo; (ECCV 2022). We converted it to the ONNX format and compressed it to 8 bits so that it runs in a browser. It runs entirely on your device.</p>
<ul>
<li><a href="/licenses/isnet-model-NOTICE.txt">Model notice and changes</a></li>
<li><a href="/licenses/apache-2.0.txt">Apache License 2.0</a></li>
</ul>
<h2>Software</h2>
<ul>
<li><strong>ONNX Runtime Web</strong>, by Microsoft, runs the model in your browser. MIT license. <a href="/licenses/onnxruntime-web-MIT.txt">License text</a>.</li>
<li><strong>JSZip</strong>, by Stuart Knightley and contributors, builds the zip file. Used under the MIT license. <a href="/licenses/jszip-MIT.txt">License text</a>.</li>
</ul>
<h2>Edge refinement</h2>
<p>Background Killer snaps the model's mask to the edges of your photo with a guided filter (Kaiming He and colleagues, 2010) and removes color spill from the old background with blur fusion (Thomas Germer and colleagues, 2020; Marco Forte and Fran&ccedil;ois Piti&eacute;, 2021). Both are our own small implementations of published methods, running on your device.</p>
<h2>Fonts</h2>
<ul>
<li><strong>Anton</strong>, by the Anton Project Authors, used for headlines. SIL Open Font License 1.1. <a href="/licenses/anton-OFL-1.1.txt">License text</a>.</li>
<li><strong>Inter</strong>, by the Inter Project Authors, used for text. SIL Open Font License 1.1. <a href="/licenses/inter-OFL-1.1.txt">License text</a>.</li>
</ul>
<h2>Images</h2>
<p>The illustration of Claw and the alley photograph on the home page were made with AI image tools for this site. They are not photographs of real places or animals. The sample photo of a ragdoll kitten is by Arjunmz, shared under <a href="https://creativecommons.org/licenses/by/4.0/" rel="noopener">CC BY 4.0</a> and available on <a href="https://commons.wikimedia.org/wiki/File:Ragdoll_kitten_on_the_prowl_2017_(cropped_2022).jpg" rel="noopener">Wikimedia Commons</a>. It is resized here.</p>
<h2>Questions</h2>
<p>If you think something here is credited wrongly, please write to <a href="mailto:support@pigrosoft.com">support@pigrosoft.com</a>.</p>
""", robots="index,follow")

# ---------------------------------------------------------------- 404
html404 = head("Page not found | Background Killer", "This page has gone into hiding.", "/404", '<meta name="robots" content="noindex">\n') + HEADER + """
<main class="page article">
<h1>This page has gone into hiding.</h1>
<p>Even the cat won't say where it went. There is a perfectly good background to remove on the home page.</p>
<p class="cta"><a class="btn btn-primary btn-lg" href="/">Back to the home page</a></p>
</main>
""" + FOOTER + "\n</body>\n</html>\n"
(ROOT / "404.html").write_text(html404, encoding="utf-8")

# ---------------------------------------------------------------- sitemap and robots
paths = ["/"] + [g[0] for g in GUIDES] + [l[0] for l in LEGAL if l[0].startswith("/")]
sm = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
for p in paths:
    sm += "  <url><loc>%s%s</loc><lastmod>2026-11-04</lastmod></url>\n" % (SITE, p if p != "/" else "/")
sm += "</urlset>\n"
(ROOT / "sitemap.xml").write_text(sm, encoding="utf-8")
(ROOT / "robots.txt").write_text("User-agent: *\nAllow: /\n\nSitemap: %s/sitemap.xml\n" % SITE, encoding="utf-8")

# ---------------------------------------------------------------- refresh index.html
idx = (ROOT / "index.html").read_text(encoding="utf-8")
idx = re.sub(r"<footer class=\"site-footer\">.*?</footer>", lambda m: FOOTER, idx, flags=re.S)
idx = re.sub(r"(<!-- faq:start -->).*?(<!-- faq:end -->)", lambda m: m.group(1) + "\n" + faq_html() + "\n        " + m.group(2), idx, flags=re.S)
idx = re.sub(r"(<!-- jsonld:start -->).*?(<!-- jsonld:end -->)", lambda m: m.group(1) + "\n" + home_jsonld() + "\n" + m.group(2), idx, flags=re.S)
(ROOT / "index.html").write_text(idx, encoding="utf-8")
print("built", len(paths), "pages")

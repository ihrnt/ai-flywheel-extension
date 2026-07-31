// AI Flywheel - injected styles (isolated world). One <style>, scoped .afw-*
// with the design-system tokens. !important on the load-bearing rules so the
// host page's CSS cannot override our badges/toolbar. Loaded before content.js.
(function (root) {
  "use strict";
  var CSS = [
    ":root{",
    "--afw-accent:#BEF264;--afw-ink:#0A0A0B;--afw-veil:rgba(190,242,100,.14);",
    "--afw-g2:#1C1C1E;--afw-g3:#26262A;--afw-t1:#F4F4F5;--afw-t2:#A6A6AD;--afw-t3:#6E6E76;",
    "--afw-br:rgba(255,255,255,.10);--afw-brm:rgba(255,255,255,.05);",
    "--afw-shadow:0 10px 30px -10px rgba(0,0,0,.6);",
    "--afw-font:'Geist',Inter,system-ui,-apple-system,sans-serif;}",

    // per-tile overlay
    ".afw-overlay{position:absolute!important;inset:0!important;pointer-events:none!important;z-index:20!important;font-family:var(--afw-font)!important;}",
    ".afw-scrim{position:absolute!important;left:0;right:0;bottom:0;height:38%;background:linear-gradient(to top,rgba(10,10,11,.92),transparent)!important;}",
    ".afw-bottom{position:absolute!important;left:8px;right:8px;bottom:var(--afw-stats-bottom,8px)!important;display:flex!important;flex-direction:column;gap:6px;align-items:flex-start;}",
    ".afw-stats{display:flex!important;gap:6px;align-items:center;flex-wrap:wrap;}",
    ".afw-badge{display:inline-flex!important;align-items:center;gap:5px;height:22px;padding:0 8px;background:rgba(20,20,21,.72)!important;border:1px solid var(--afw-brm)!important;border-radius:7px!important;}",
    ".afw-badge svg{width:12px;height:12px;stroke:var(--afw-t2);fill:none;stroke-width:2;flex:none;}",
    ".afw-badge .afw-n{font:600 12px var(--afw-font)!important;color:var(--afw-t1)!important;font-variant-numeric:tabular-nums;}",
    ".afw-top{position:absolute!important;top:8px;left:8px;display:flex!important;gap:6px;}",
    ".afw-rank{display:inline-flex!important;align-items:center;height:20px;padding:0 7px;background:rgba(20,20,21,.72)!important;border:1px solid var(--afw-brm)!important;border-radius:7px!important;font:600 11px var(--afw-font)!important;color:var(--afw-t2)!important;font-variant-numeric:tabular-nums;}",
    ".afw-breakout{display:inline-flex!important;align-items:center;gap:4px;height:20px;padding:0 8px;background:rgba(10,10,11,.75)!important;border:1px solid rgba(190,242,100,.45)!important;border-radius:7px!important;font:700 11px var(--afw-font)!important;letter-spacing:0;color:var(--afw-accent)!important;white-space:nowrap;}",
    ".afw-breakout:before{content:'';width:5px;height:5px;border-radius:9999px;background:var(--afw-accent);}",
    ".afw-date{display:inline-flex!important;align-items:center;gap:5px;height:20px;padding:0 7px;background:rgba(20,20,21,.72)!important;border:1px solid var(--afw-brm)!important;border-radius:7px!important;font:600 10px var(--afw-font)!important;color:var(--afw-t2)!important;white-space:nowrap;}",
    ".afw-date svg{width:11px;height:11px;stroke:var(--afw-t2);fill:none;stroke-width:2;flex:none;}",
    ".afw-dl{position:absolute!important;top:8px;right:8px;width:28px;height:28px;border-radius:10px;background:rgba(20,20,21,.72)!important;border:1px solid var(--afw-brm)!important;display:flex!important;align-items:center;justify-content:center;cursor:pointer;pointer-events:auto!important;opacity:0;transition:opacity .12s;}",
    ".afw-tile:hover .afw-dl{opacity:1;}",
    ".afw-dl-visible{opacity:1!important;}",
    ".afw-dl svg{width:14px;height:14px;stroke:var(--afw-t1);fill:none;stroke-width:2;}",
    ".afw-dl:hover{background:var(--afw-g3)!important;}",
    // Story reply controls occupy the bottom edge and the header owns the top
    // row. Keep AI Flywheel's labels clear of the reply field and make the
    // download action available without relying on hover.
    ".afw-story-tile .afw-bottom{bottom:max(var(--afw-stats-bottom,8px),76px)!important;}",
    ".afw-story-tile .afw-dl{opacity:1!important;top:96px!important;}",

    // Sorted view: a fixed overlay with its own scroller, fully decoupled from
    // Instagram's DOM. The native page stays untouched underneath (its scroll
    // still drives IG's own pagination via the toolbar auto-scroll).
    ".afw-sv{position:fixed!important;inset:0!important;z-index:2147482998!important;display:flex!important;flex-direction:column!important;background:rgba(10,10,11,.97)!important;font-family:var(--afw-font)!important;padding-top:52px;}",
    ".afw-sv-head{display:flex!important;align-items:center;gap:10px;max-width:1060px;width:100%;margin:0 auto;padding:6px 16px 10px;}",
    ".afw-sv-count{font:600 13px var(--afw-font)!important;color:var(--afw-t1)!important;font-variant-numeric:tabular-nums;}",
    ".afw-sv-hint{font:400 12px var(--afw-font)!important;color:var(--afw-t3)!important;}",
    ".afw-sv-close{margin-left:auto;width:28px;height:28px;border:1px solid var(--afw-br)!important;border-radius:10px;background:var(--afw-g2)!important;display:flex!important;align-items:center;justify-content:center;cursor:pointer;flex:none;}",
    ".afw-sv-close svg{width:14px;height:14px;stroke:var(--afw-t2);fill:none;stroke-width:2;}",
    ".afw-sv-close:hover{background:var(--afw-g3)!important;}.afw-sv-close:hover svg{stroke:var(--afw-t1);}",
    ".afw-sv-scroll{flex:1 1 auto!important;overflow-y:auto!important;overscroll-behavior:contain;padding:0 16px 24px;}",
    ".afw-sv-sizer{position:relative!important;max-width:1060px;margin:0 auto;width:100%;}",
    ".afw-sv-tile{position:absolute!important;overflow:hidden;border-radius:4px;background:var(--afw-g2)!important;}",
    ".afw-sv-link{position:absolute!important;inset:0!important;display:block!important;}",
    ".afw-sv-img{width:100%!important;height:100%!important;display:block!important;object-fit:cover!important;}",
    ".afw-sv-tile:hover .afw-dl{opacity:1;}",

    // profile/account cards
    ".afw-profile-panel{display:flex!important;align-items:center;flex-wrap:wrap;gap:8px;margin:8px 0 12px!important;width:100%!important;max-width:100%;flex:0 0 100%!important;position:relative!important;z-index:1!important;clear:both!important;font-family:var(--afw-font)!important;}",
    ".afw-profile-mark{width:32px;height:32px;border-radius:9999px;background:var(--afw-g3)!important;color:var(--afw-t2)!important;display:flex!important;align-items:center;justify-content:center;flex:none;border:1px solid var(--afw-br)!important;}",
    ".afw-profile-mark svg{width:18px;height:18px;stroke:currentColor;fill:none;stroke-width:2;}",
    ".afw-profile-card{max-width:100%;padding:5px 12px;border-radius:10px;background:var(--afw-g2)!important;border:1px solid var(--afw-br)!important;display:flex!important;flex-direction:column;justify-content:center;}",
    ".afw-profile-label{font:600 10px var(--afw-font)!important;letter-spacing:.02em;line-height:1.2;color:var(--afw-t2)!important;}",
    ".afw-profile-value{margin-top:1px;font:700 13px var(--afw-font)!important;line-height:1.2;color:var(--afw-t1)!important;font-variant-numeric:tabular-nums;white-space:normal;overflow-wrap:anywhere;}",
    ".afw-profile-link{text-decoration:none!important;color:var(--afw-accent)!important;}",
    ".afw-profile-link:hover{text-decoration:underline!important;}",
    "@media(max-width:640px){.afw-profile-mark{width:28px;height:28px}.afw-profile-card{padding:5px 10px}.afw-profile-value{font-size:12px!important}}",

    // reel scrubber. The bar ends short of the video's bottom-right corner
    // (--afw-vc-right, widened in JS when IG's mute/audio button sits there) so
    // it never covers that control, and the bar itself is click-through: only
    // the play button and track take clicks, so anything the bar still overlaps
    // (IG's mute, caption) stays reachable underneath.
    ".afw-vc{position:absolute!important;left:10px;right:var(--afw-vc-right,10px)!important;bottom:var(--afw-vc-bottom,10px)!important;z-index:2147483000!important;pointer-events:none!important;display:flex!important;align-items:center;gap:10px;height:40px;padding:0 10px;background:rgba(20,20,21,.72)!important;border:1px solid var(--afw-brm)!important;border-radius:12px!important;font-family:var(--afw-font)!important;}",
    ".afw-vc-play{pointer-events:auto!important;width:28px;height:28px;border:0;border-radius:10px;background:transparent;display:flex;align-items:center;justify-content:center;cursor:pointer;flex:none;}",
    ".afw-vc-play svg{width:15px;height:15px;stroke:var(--afw-t1);fill:var(--afw-t1);}",
    ".afw-vc-mute{pointer-events:auto!important;width:28px;height:28px;border:0;border-radius:10px;background:transparent;display:flex;align-items:center;justify-content:center;cursor:pointer;flex:none;}",
    ".afw-vc-mute svg{width:15px;height:15px;stroke:var(--afw-t1);fill:none;stroke-width:2;}",
    // The track is the CLICK/DRAG target: it fills the bar's full height so the
    // whole band is seekable, while the visible bar is the thin centered rail
    // inside it - so the hit area is big but the yellow bar stays 4px.
    ".afw-vc-track{pointer-events:auto!important;position:relative;flex:1;align-self:stretch;display:flex;align-items:center;cursor:pointer;touch-action:none;}",
    ".afw-vc-rail{position:relative;width:100%;height:4px;border-radius:9999px;background:var(--afw-g3);transition:height .12s ease;}",
    ".afw-vc-track:hover .afw-vc-rail,.afw-vc-track.afw-vc-drag .afw-vc-rail{height:6px;}",
    ".afw-vc-fill{position:absolute;left:0;top:0;bottom:0;border-radius:9999px;background:var(--afw-accent);}",
    ".afw-vc-knob{position:absolute;top:50%;width:11px;height:11px;border-radius:9999px;background:var(--afw-accent);transform:translate(-50%,-50%);opacity:0;transition:opacity .12s ease;pointer-events:none;}",
    ".afw-vc-track:hover .afw-vc-knob,.afw-vc-track.afw-vc-drag .afw-vc-knob{opacity:1;}",
    ".afw-vc-time{font:600 12px var(--afw-font);color:var(--afw-t1);font-variant-numeric:tabular-nums;flex:none;}",
    // In-tile player for grid thumbnails (profile reels grid, sorted view):
    // a lazy <video> that sits over the thumbnail and becomes visible on first
    // play; the shared scrubber bar drives it.
    ".afw-tp-video{position:absolute!important;inset:0!important;width:100%!important;height:100%!important;object-fit:cover!important;display:none;z-index:5;background:#000;}",
    ".afw-tp-video.afw-tp-on{display:block!important;}",
    ".afw-vc-time .afw-tot{color:var(--afw-t3);font-weight:400;}",
    ".afw-audio-dl{margin-left:8px!important;min-height:32px;padding:0 12px;border:1px solid var(--afw-br)!important;border-radius:8px!important;background:var(--afw-g2)!important;color:var(--afw-t1)!important;font:600 12px var(--afw-font)!important;display:inline-flex!important;align-items:center!important;gap:7px;cursor:pointer;}",
    ".afw-audio-dl:hover{background:var(--afw-g3)!important;}.afw-audio-dl:disabled{opacity:.55;cursor:wait;}",
    ".afw-audio-dl svg{width:14px;height:14px;stroke:var(--afw-t1);fill:none;stroke-width:2;}",
    "@media(max-width:520px){.afw-badge{height:20px;padding:0 6px}.afw-badge .afw-n{font-size:11px!important}.afw-vc{left:8px;right:8px;height:36px;gap:8px}.afw-vc-time{font-size:11px}}"
  ].join("");

  // The design system is built on Geist, but Instagram/TikTok never load it and
  // the host CSP blocks a Google Fonts <link>, so the injected UI was silently
  // falling back to system-ui - different vertical metrics, which reads as
  // broken line-height against the Geist mockups. Bundle Geist and declare the
  // @font-face at document level (Chrome ignores @font-face inside a shadow
  // root, but shadow content still resolves fonts from the document), so every
  // afw-* element AND the shadow-DOM toolbar/menu/filter panel render in Geist.
  function fontFace() {
    var url;
    try { url = chrome.runtime.getURL("fonts/Geist-Variable.woff2"); } catch (e) { url = ""; }
    if (!url) return "";
    return "@font-face{font-family:'Geist';font-style:normal;font-weight:400 700;" +
      "font-display:swap;src:url('" + url + "') format('woff2');}";
  }

  function inject(doc) {
    doc = doc || document;
    if (doc.getElementById("afw-styles")) return;
    var style = doc.createElement("style");
    style.id = "afw-styles";
    style.textContent = fontFace() + CSS;
    (doc.head || doc.documentElement).appendChild(style);
  }

  root.AFW = root.AFW || {};
  root.AFW.injectStyles = inject;
  root.AFW.TOOLBAR_CSS = CSS; // reused inside the toolbar shadow root
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));

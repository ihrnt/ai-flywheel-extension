// Shared overlay/control positioning helpers. Sorted tiles may only use their
// own scrubber bar; native tiles retain the external-bar fallback because the
// platform can mount its controls outside the tile host.
(function (root) {
  "use strict";

  function visibleControlForHost(host, liveBars) {
    if (!host) return null;
    var bars = [].slice.call(host.querySelectorAll(".afw-vc"));
    for (var i = 0; i < bars.length; i++) {
      var cs = getComputedStyle(bars[i]);
      if (cs.display !== "none" && cs.visibility !== "hidden" && bars[i].getBoundingClientRect().height) return bars[i];
    }
    // The sorted view owns each tile and its player. Never let a static tile
    // borrow a nearby reel's bar merely because their viewport rectangles overlap.
    if (host.classList && host.classList.contains("afw-sv-tile")) return null;
    var hr = host.getBoundingClientRect && host.getBoundingClientRect();
    if (!hr) return null;
    for (var j = 0; j < liveBars.length; j++) {
      var br = liveBars[j].getBoundingClientRect();
      if (!br.width || !br.height) continue;
      var overlaps = br.left < hr.right && br.right > hr.left && br.top < hr.bottom && br.bottom > hr.top;
      if (overlaps) return liveBars[j];
    }
    return null;
  }

  function updateControlOffset(host, liveBars) {
    var bar = visibleControlForHost(host, liveBars);
    if (!bar) {
      host.classList.remove("afw-has-vc");
      host.style.removeProperty("--afw-stats-bottom");
      return;
    }
    var hr = host.getBoundingClientRect();
    var br = bar.getBoundingClientRect();
    var offset = Math.max(52, Math.ceil(hr.bottom - br.top + 8));
    host.classList.add("afw-has-vc");
    host.style.setProperty("--afw-stats-bottom", offset + "px");
  }

  root.AFWControlOffsets = {
    visibleControlForHost: visibleControlForHost,
    updateControlOffset: updateControlOffset
  };
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));

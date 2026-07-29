// Pure helpers for matching the currently visible Highlight media to the
// normalized story record captured from Instagram's timeline response.
(function (root) {
  "use strict";

  function mediaUrlKey(value) {
    var text = String(value || "").trim();
    if (!text) return "";
    try {
      var parsed = new URL(text, "https://www.instagram.com/");
      return parsed.pathname.replace(/\/+$/, "");
    } catch (e) {
      return text.split(/[?#]/)[0].replace(/\/+$/, "");
    }
  }

  function recordForMedia(records, source, isVideo) {
    var target = mediaUrlKey(source);
    if (!target) return null;
    var type = isVideo ? "video" : "image";
    for (var i = 0; i < records.length; i++) {
      var rec = records[i];
      if (!rec || !rec.isStory) continue;
      var assets = rec.assets || [];
      for (var j = 0; j < assets.length; j++) {
        if (assets[j].type === type && mediaUrlKey(assets[j].url) === target) return rec;
      }
    }
    return null;
  }

  function progressIndexForCandidates(candidates) {
    var groups = new Map();
    (candidates || []).forEach(function (node) {
      if (!node || !node.parentElement) return;
      var group = groups.get(node.parentElement);
      if (!group) {
        group = [];
        groups.set(node.parentElement, group);
      }
      group.push(node);
    });
    var bars = null, bestScore = -1;
    groups.forEach(function (group) {
      var withChild = group.filter(function (node) { return !!node.firstElementChild; }).length;
      var score = group.length * 100 + withChild;
      if (score > bestScore) {
        bestScore = score;
        bars = group;
      }
    });
    if (!bars || !bars.length) return null;
    bars.sort(function (a, b) { return a.getBoundingClientRect().left - b.getBoundingClientRect().left; });
    var active = -1;
    for (var i = 0; i < bars.length; i++) if (bars[i].firstElementChild) active = i;
    return active >= 0 ? active : null;
  }

  // Instagram's video player can expose a blob/player URL instead of the CDN
  // asset URL. Its poster and same-frame cover images retain a stable CDN URL,
  // so use them only as a video-record fallback.
  function recordForVisibleMedia(records, visible) {
    visible = visible || {};
    var rec = recordForMedia(records, visible.source, !!visible.isVideo);
    if (rec || !visible.isVideo) return rec;
    var covers = [visible.poster].concat(Array.isArray(visible.covers) ? visible.covers : []);
    for (var i = 0; i < covers.length; i++) {
      rec = recordForMedia(records, covers[i], false);
      if (rec) return rec;
    }
    if (!Number.isInteger(visible.storyIndex) && visible.storyPk) {
      var routed = records.filter(function (item) {
        return item && item.isStory && item.kind === "video" && String(item.pk) === String(visible.storyPk);
      });
      if (routed.length === 1) return routed[0];
    }
    if (Number.isInteger(visible.storyIndex)) {
      var indexed = records.filter(function (item) {
        return item && item.isStory && item.kind === "video" && item.storyIndex === visible.storyIndex;
      });
      if (indexed.length === 1) return indexed[0];
    }
    // A one-slide story still uses Instagram's opaque blob player URL, but it
    // may not render a detectable progress segment. The ordered viewer parser
    // gives us an unambiguous record in that case.
    var ordered = records.filter(function (item) {
      return item && item.isStory && Number.isInteger(item.storyIndex);
    });
    if (ordered.length === 1 && ordered[0].kind === "video") return ordered[0];
    return null;
  }

  root.AFWStoryHighlight = {
    mediaUrlKey: mediaUrlKey,
    progressIndexForCandidates: progressIndexForCandidates,
    recordForMedia: recordForMedia,
    recordForVisibleMedia: recordForVisibleMedia
  };
  if (typeof module !== "undefined" && module.exports) module.exports = root.AFWStoryHighlight;
})(typeof globalThis !== "undefined" ? globalThis : this);

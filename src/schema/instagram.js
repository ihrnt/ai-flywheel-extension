// AI Flywheel - Instagram capture schema (our own, from docs/ig-capture-notes.md).
// Classic script (no ES module) so the MAIN-world content script can load it
// directly; also exports under CommonJS for the node test.
(function (root) {
  "use strict";

  // Surfaces we read, keyed by the top-level `data` root key.
  var IG_SURFACES = {
    xdt_api__v1__feed__user_timeline_graphql_connection: {
      surface: "posts",
      mediaFromNode: function (node) { return node; }
    },
    xdt_api__v1__clips__user__connection_v2: {
      surface: "reels",
      mediaFromNode: function (node) { return node.media; }
    },
    xdt_api__v1__clips__home__connection_v2: {
      surface: "reels-feed",
      mediaFromNode: function (node) { return node.media; }
    },
    xdt_api__v1__feed__timeline__connection: {
      surface: "timeline",
      mediaFromNode: function (node) { return node.explore_story && node.explore_story.media; }
    }
  };

  var MEDIA_TYPE = { 1: "photo", 2: "video", 8: "carousel" };

  function numOrNull(v) {
    return typeof v === "number" && !Number.isNaN(v) ? v : null;
  }

  function firstNum() {
    for (var i = 0; i < arguments.length; i++) {
      var n = numOrNull(arguments[i]);
      if (n != null) return n;
    }
    return null;
  }

  function shortcodeToMediaId(code) {
    var alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    var id = 0n;
    var text = String(code || "");
    if (!text) return null;
    for (var i = 0; i < text.length; i++) {
      var value = alphabet.indexOf(text[i]);
      if (value < 0) return null;
      id = id * 64n + BigInt(value);
    }
    return id ? id.toString() : null;
  }

  function countFromEdge(edge) {
    return edge && typeof edge.count === "number" && !Number.isNaN(edge.count) ? edge.count : null;
  }

  function bestImage(media) {
    var iv = media.image_versions2;
    if (iv && Array.isArray(iv.candidates) && iv.candidates.length) {
      // candidates are ordered largest-first
      return iv.candidates[0].url || null;
    }
    return null;
  }

  function bestVideo(media) {
    var vv = media.video_versions;
    if (Array.isArray(vv) && vv.length && vv[0].url) return vv[0].url;
    return null;
  }

  // Every downloadable asset on a media: cover/image, video, and each carousel
  // slide. Grid reels carry only the cover here; the video url arrives via /info/.
  function assetsFrom(media) {
    var out = [];
    var cm = media.carousel_media;
    if (Array.isArray(cm) && cm.length) {
      for (var i = 0; i < cm.length; i++) {
        var vid = bestVideo(cm[i]), img = bestImage(cm[i]);
        if (vid) out.push({ type: "video", url: vid, label: "Video " + (i + 1) });
        if (img) out.push({ type: "image", url: img, label: "Image " + (i + 1) });
      }
    } else {
      var v = bestVideo(media), im = bestImage(media);
      if (v) out.push({ type: "video", url: v, label: "Video" });
      if (im) out.push({ type: "image", url: im, label: v ? "Cover image" : "Image" });
    }
    return out;
  }

  // Flat record from one media object.
  function readMedia(media, surface) {
    if (!media || typeof media !== "object") return null;
    var pk = media.pk != null ? String(media.pk) : null;
    if (!pk) return null;
    var caption = media.caption && typeof media.caption === "object" ? media.caption : null;
    var isVideo = media.media_type === 2;
    var code = media.code || media.shortcode || null;
    return {
      pk: pk,
      code: code,
      kind: MEDIA_TYPE[media.media_type] || "unknown",
      surface: surface,
      likes: numOrNull(media.like_count),
      comments: numOrNull(media.comment_count),
      plays: firstNum(media.play_count, media.ig_play_count, media.view_count),
      takenAt: firstNum(media.taken_at, media.taken_at_timestamp, media.created_at),
      caption: caption ? caption.text || null : null,
      username: media.user && media.user.username ? media.user.username : null,
      thumbUrl: bestImage(media),
      videoUrl: bestVideo(media),
      assets: assetsFrom(media),
      url: code
        ? "https://www.instagram.com/" + (isVideo ? "reel" : "p") + "/" + code + "/"
        : null
    };
  }

  // Parse a list-surface response -> { surface, records[], endCursor } or null.
  function parseResponse(json) {
    var explore = parseExplore(json);
    if (explore) return explore;
    var data = json && json.data;
    if (!data || typeof data !== "object") return parseAnyMedia(json);
    for (var rootKey in data) {
      if (!Object.prototype.hasOwnProperty.call(data, rootKey)) continue;
      var def = IG_SURFACES[rootKey];
      if (!def) continue;
      var conn = data[rootKey];
      if (!conn || !Array.isArray(conn.edges)) continue;
      var records = [];
      for (var i = 0; i < conn.edges.length; i++) {
        var node = conn.edges[i].node || {};
        var rec = readMedia(def.mediaFromNode(node), def.surface);
        if (rec) records.push(rec);
      }
      var endCursor = conn.page_info && conn.page_info.has_next_page ? conn.page_info.end_cursor : null;
      return { surface: def.surface, records: records, endCursor: endCursor };
    }
    return parseAnyMedia(json);
  }

  // Parse the single-media /info/ endpoint (fires when a post/reel is opened).
  // Used to enrich records with video URLs + taken_at the grid payload lacked.
  function parseInfo(json) {
    if (!json || !Array.isArray(json.items)) return null;
    var records = [];
    for (var i = 0; i < json.items.length; i++) {
      var rec = readMedia(json.items[i], "info");
      if (rec) records.push(rec);
    }
    return records.length ? { surface: "info", records: records, endCursor: null } : null;
  }

  function collectMedia(value, surface, records, seen, state) {
    if (!value || state.visits++ > state.maxVisits) return;
    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i++) collectMedia(value[i], surface, records, seen, state);
      return;
    }
    if (typeof value !== "object") return;
    if (value.pk != null && value.media_type != null && (value.code || value.shortcode)) {
      var rec = readMedia(value, surface);
      if (rec && !seen[rec.pk]) { seen[rec.pk] = true; records.push(rec); }
      return; // media internals are assets, not more feed records
    }
    if (value.media && typeof value.media === "object") collectMedia(value.media, surface, records, seen, state);
    if (value.explore_story && value.explore_story.media) collectMedia(value.explore_story.media, surface, records, seen, state);
    for (var k in value) {
      if (!Object.prototype.hasOwnProperty.call(value, k) || k === "media" || k === "explore_story") continue;
      collectMedia(value[k], surface, records, seen, state);
    }
  }

  function parseExplore(json) {
    var data = json && json.data;
    var sections = json && json.sectional_items;
    if (!Array.isArray(sections) && data) sections = data.sectional_items;
    if (!Array.isArray(sections)) return null;
    var records = [], seen = {};
    var state = { visits: 0, maxVisits: 12000 };
    for (var i = 0; i < sections.length; i++) {
      var layout = sections[i] && sections[i].layout_content;
      if (layout) collectMedia(layout, "explore", records, seen, state);
    }
    return records.length ? { surface: "explore", records: records, endCursor: null } : null;
  }

  function parseAnyMedia(json) {
    var records = [], seen = {};
    collectMedia(json, "generic", records, seen, { visits: 0, maxVisits: 8000 });
    return records.length ? { surface: "generic", records: records, endCursor: null } : null;
  }

  function parseProfile(json) {
    var user = json && json.data && json.data.user ? json.data.user : json && json.user;
    if (!user || !user.username) return null;
    return {
      id: user.id != null ? String(user.id) : user.pk != null ? String(user.pk) : null,
      username: user.username,
      fullName: user.full_name || null,
      biography: user.biography || null,
      categoryName: user.category_name || null,
      businessCategoryName: user.business_category_name || null,
      overallCategoryName: user.overall_category_name || null,
      // Many accounts leave category_name null but carry the category as an enum
      // (e.g. "SPORTSWEAR_STORE"). Humanize it: "Sportswear Store".
      categoryEnum: user.category_enum
        ? String(user.category_enum).toLowerCase().replace(/_/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); })
        : null,
      isBusiness: user.is_business_account === true,
      isProfessional: user.is_professional_account === true,
      isVerified: user.is_verified === true,
      posts: countFromEdge(user.edge_owner_to_timeline_media),
      followers: countFromEdge(user.edge_followed_by),
      following: countFromEdge(user.edge_follow)
    };
  }

  var IG_SORT_FIELD = {
    likes: "likes",
    comments: "comments",
    reelViews: "plays",
    reelDate: "takenAt",
    postDate: "takenAt"
  };

  // Compare two records for a sort option + direction. Nulls sort last.
  function compareRecords(a, b, sortOption, direction) {
    var field = IG_SORT_FIELD[sortOption];
    if (!field) return 0;
    var av = a[field], bv = b[field];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    var diff = av - bv;
    return direction === "asc" ? diff : -diff;
  }

  var api = {
    IG_SURFACES: IG_SURFACES,
    IG_SORT_FIELD: IG_SORT_FIELD,
    readMedia: readMedia,
    shortcodeToMediaId: shortcodeToMediaId,
    parseResponse: parseResponse,
    parseInfo: parseInfo,
    parseProfile: parseProfile,
    compareRecords: compareRecords
  };

  root.AFW = root.AFW || {};
  root.AFW.schema = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));

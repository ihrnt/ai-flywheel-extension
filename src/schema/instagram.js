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

  function bestVideoEntry(media) {
    var vv = media.video_versions;
    if (!Array.isArray(vv)) return null;
    for (var i = 0; i < vv.length; i++) if (vv[i] && vv[i].url) return vv[i];
    return null;
  }

  function bestVideo(media) {
    var entry = bestVideoEntry(media);
    return entry ? entry.url : null;
  }

  function decodeXml(value) {
    return String(value || "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
  }

  function xmlAttr(text, name) {
    var match = String(text || "").match(new RegExp("\\b" + name + "\\s*=\\s*(['\\\"])(.*?)\\1", "i"));
    return match ? decodeXml(match[2]) : null;
  }

  function parseDashManifest(manifest) {
    var result = { videoOnly: [], audioOnly: null };
    if (typeof manifest !== "string" || manifest.indexOf("<MPD") === -1) return result;
    var videoByQuality = Object.create(null), bestAudio = null;
    var adaptationRe = /<AdaptationSet\b([^>]*)>([\s\S]*?)<\/AdaptationSet>/gi;
    var adaptation;
    while ((adaptation = adaptationRe.exec(manifest))) {
      var type = xmlAttr(adaptation[1], "contentType") || xmlAttr(adaptation[1], "mimeType") || "";
      type = type.toLowerCase();
      var repRe = /<Representation\b([^>]*)>([\s\S]*?)<\/Representation>/gi;
      var rep;
      while ((rep = repRe.exec(adaptation[2]))) {
        var base = rep[2].match(/<BaseURL>([\s\S]*?)<\/BaseURL>/i);
        var url = base ? decodeXml(base[1].trim()) : null;
        if (!url) continue;
        var bandwidth = Number(xmlAttr(rep[1], "bandwidth")) || 0;
        if (type === "audio" || /audio\//.test(xmlAttr(rep[1], "mimeType") || "")) {
          if (!bestAudio || bandwidth > bestAudio.bandwidth) bestAudio = { url: url, bandwidth: bandwidth, codecs: xmlAttr(rep[1], "codecs") || null };
          continue;
        }
        if (type !== "video" && !/video\//.test(xmlAttr(rep[1], "mimeType") || "")) continue;
        var height = Number(xmlAttr(rep[1], "height")) || null;
        var quality = xmlAttr(rep[1], "FBQualityLabel") || (height ? height + "p" : null);
        if (!quality) continue;
        var candidate = { url: url, width: Number(xmlAttr(rep[1], "width")) || null, height: height, quality: quality, bandwidth: bandwidth, codecs: xmlAttr(rep[1], "codecs") || null };
        if (!videoByQuality[quality] || bandwidth > videoByQuality[quality].bandwidth) videoByQuality[quality] = candidate;
      }
    }
    result.videoOnly = Object.keys(videoByQuality).map(function (quality) { return videoByQuality[quality]; }).sort(function (a, b) { return parseInt(a.quality, 10) - parseInt(b.quality, 10); });
    result.audioOnly = bestAudio;
    return result;
  }

  function textOrNull(value) {
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  function linkUrl(media) {
    if (typeof media.link === "string") return media.link;
    if (!media.link || typeof media.link !== "object") return null;
    return textOrNull(media.link.url) || textOrNull(media.link.link_url) || null;
  }

  function linkText(media) {
    return textOrNull(media.link_text) || (media.link && textOrNull(media.link.title)) || null;
  }

  function audioInfo(media) {
    var clips = media && media.clips_metadata;
    var music = clips && clips.music_info && clips.music_info.music_asset_info;
    if (!music || !textOrNull(music.title)) return null;
    return {
      title: textOrNull(music.title),
      artist: textOrNull(music.display_artist),
      audioId: music.audio_cluster_id != null ? String(music.audio_cluster_id) : null
    };
  }

  function needsMediaInfo(media) {
    if (media.media_type === 2) return !bestVideo(media);
    var slides = media.carousel_media;
    if (!Array.isArray(slides)) return false;
    return slides.some(function (slide) {
      var isVideo = slide && (slide.media_type === 2 || slide.is_video === true);
      return isVideo && !bestVideo(slide);
    });
  }

  function usernamesFrom(list) {
    var out = [];
    if (!Array.isArray(list)) return out;
    for (var i = 0; i < list.length; i++) {
      var u = list[i] && list[i].username;
      if (u) out.push(String(u));
    }
    return out;
  }

  var HASHTAG_RE = /#[\w\u00C0-\u024F]+/g;
  function extractHashtags(text) {
    if (!text || typeof text !== "string") return [];
    var matches = text.match(HASHTAG_RE);
    if (!matches) return [];
    var seen = Object.create(null);
    var out = [];
    for (var i = 0; i < matches.length; i++) {
      var tag = matches[i].slice(1).toLowerCase();
      if (!seen[tag]) { seen[tag] = true; out.push(tag); }
    }
    return out;
  }

  // Every downloadable asset on a media: cover/image, video, and each carousel
  // slide. Grid reels carry only the cover here; the video url arrives via /info/.
  function assetsFrom(media, surface) {
    var out = [];
    var cm = media.carousel_media;
    var isStory = surface === "stories";
    function asset(type, url, label) {
      return { type: type, url: url, label: label, story: isStory };
    }
    function videoAsset(item, label) {
      var entry = bestVideoEntry(item);
      if (!entry) return null;
      var out = asset("video", entry.url, label);
      var width = firstNum(entry.width, item.original_width, item.width);
      var height = firstNum(entry.height, item.original_height, item.height);
      if (width != null) out.width = width;
      if (height != null) out.height = height;
      var audio = audioInfo(item);
      if (audio) {
        out.audioTitle = audio.title;
        out.audioArtist = audio.artist;
        out.audioId = audio.audioId;
      }
      var variants = parseDashManifest(item.video_dash_manifest);
      if (variants.videoOnly.length || variants.audioOnly) out.downloadVariants = variants;
      return out;
    }
    if (Array.isArray(cm) && cm.length) {
      for (var i = 0; i < cm.length; i++) {
        var vid = videoAsset(cm[i], "Video " + (i + 1)), img = bestImage(cm[i]);
        if (vid) out.push(vid);
        if (img) out.push(asset("image", img, "Image " + (i + 1)));
      }
    } else {
      var v = videoAsset(media, isStory ? "Story video" : "Video"), im = bestImage(media);
      if (v) out.push(v);
      if (im) out.push(asset("image", im, v ? "Cover image" : (isStory ? "Story image" : "Image")));
    }
    return out;
  }

  // Flat record from one media object.
  function readMedia(media, surface) {
    if (!media || typeof media !== "object") return null;
    var pk = media.pk != null ? String(media.pk) : null;
    if (!pk) return null;
    var caption = media.caption && typeof media.caption === "object" ? media.caption : null;
    var captionText = caption ? caption.text || null : null;
    var isVideo = media.media_type === 2;
    var code = media.code || media.shortcode || null;
    var usertags = media.usertags && Array.isArray(media.usertags.in) ? media.usertags.in : null;
    var taggedUsers = usertags
      ? usernamesFrom(usertags.map(function (t) { return t && t.user; }))
      : [];
    return {
      pk: pk,
      code: code,
      kind: MEDIA_TYPE[media.media_type] || "unknown",
      surface: surface,
      likes: numOrNull(media.like_count),
      comments: numOrNull(media.comment_count),
      plays: firstNum(media.play_count, media.ig_play_count, media.view_count),
      takenAt: firstNum(media.taken_at, media.taken_at_timestamp, media.created_at),
      caption: captionText,
      username: media.user && media.user.username ? media.user.username : null,
      ownerPk: media.user && (media.user.pk != null ? String(media.user.pk) : media.user.id != null ? String(media.user.id) : null),
      thumbUrl: bestImage(media),
      videoUrl: bestVideo(media),
      assets: assetsFrom(media, surface),
      isStory: surface === "stories",
      needsMediaInfo: needsMediaInfo(media),
      paidPartnership: media.is_paid_partnership === true,
      collaborators: usernamesFrom(media.coauthor_producers),
      taggedUsers: taggedUsers,
      location: media.location && media.location.name ? media.location.name : null,
      hashtags: extractHashtags(captionText),
      productType: textOrNull(media.product_type),
      width: firstNum(media.original_width, media.width),
      height: firstNum(media.original_height, media.height),
      carouselMediaCount: firstNum(media.carousel_media_count, Array.isArray(media.carousel_media) ? media.carousel_media.length : null),
      hasAudio: typeof media.has_audio === "boolean" ? media.has_audio : null,
      audio: audioInfo(media),
      videoDuration: numOrNull(media.video_duration),
      accessibilityCaption: textOrNull(media.accessibility_caption),
      externalLink: linkUrl(media),
      externalLinkText: linkText(media),
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

  // Highlights load through the timeline connection, with the active story
  // item at node.explore_story.media. Keep these records distinct from the
  // ordinary timeline so content.js only uses them in the story viewer.
  function parseStoryHighlight(json) {
    var data = json && json.data;
    var conn = data && data.xdt_api__v1__feed__timeline__connection;
    if (!conn || !Array.isArray(conn.edges)) return null;
    var records = [];
    for (var i = 0; i < conn.edges.length; i++) {
      var node = conn.edges[i] && conn.edges[i].node;
      var rec = readMedia(node && node.explore_story && node.explore_story.media, "stories");
      if (rec) records.push(rec);
    }
    enrichStoryUsernames(records, json);
    return records.length ? { surface: "stories", records: records, endCursor: null } : null;
  }

  function collectStoryUsernames(value, users, state) {
    if (!value || state.visits++ > state.maxVisits) return;
    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i++) collectStoryUsernames(value[i], users, state);
      return;
    }
    if (typeof value !== "object") return;
    var id = value.pk != null ? value.pk : value.id;
    if (id != null && value.username) users[String(id)] = String(value.username);
    for (var key in value) {
      if (Object.prototype.hasOwnProperty.call(value, key)) collectStoryUsernames(value[key], users, state);
    }
  }

  // Hydrated story media often has user.pk but no username. The same payload
  // includes the creator object elsewhere, so join it by that proven ID.
  function enrichStoryUsernames(records, payload) {
    var users = {};
    collectStoryUsernames(payload, users, { visits: 0, maxVisits: 12000 });
    for (var i = 0; i < records.length; i++) {
      if (!records[i].username && records[i].ownerPk && users[records[i].ownerPk]) {
        records[i].username = users[records[i].ownerPk];
      }
    }
  }

  // The first Highlight slide is often embedded in Instagram's initial
  // application/json hydration script instead of arriving through fetch. Its
  // media records retain the usual pk/media_type/code shape, so normalize
  // them through the same bounded walker, but keep their surface story-only.
  function parseStoryHighlightPayload(json) {
    var records = [], seen = {};
    collectMedia(json, "stories", records, seen, { visits: 0, maxVisits: 12000 });
    enrichStoryUsernames(records, json);
    return records.length ? { surface: "stories", records: records, endCursor: null } : null;
  }

  function storyCollectionMatches(collection, route) {
    route = route || {};
    var id = collection && collection.id != null ? String(collection.id) : "";
    if (route.highlightId) {
      var highlightId = String(route.highlightId);
      return id === highlightId || id === "highlight:" + highlightId;
    }
    if (route.handle) {
      var username = collection && collection.user && collection.user.username;
      return username && String(username).toLowerCase() === String(route.handle).toLowerCase();
    }
    return true;
  }

  function collectStoryCollections(value, route, collections, seen, state) {
    if (!value || state.visits++ > state.maxVisits || typeof value !== "object") return;
    if (seen.indexOf(value) !== -1) return;
    seen.push(value);
    if (!Array.isArray(value) && Array.isArray(value.items) && value.items.some(function (item) {
      return item && item.pk != null && item.media_type != null;
    })) {
      if (storyCollectionMatches(value, route)) collections.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i++) collectStoryCollections(value[i], route, collections, seen, state);
      return;
    }
    for (var key in value) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        collectStoryCollections(value[key], route, collections, seen, state);
      }
    }
  }

  // Both Highlights and ordinary account stories use ordered story
  // collections. Preserve that order so an opaque video player can be matched
  // to Instagram's native progress-bar index without relying on its blob URL.
  function parseStoryViewer(json, route) {
    var collections = [];
    collectStoryCollections(json, route, collections, [], { visits: 0, maxVisits: 16000 });
    if (!collections.length) return null;
    var records = [], seen = {};
    for (var i = 0; i < collections.length; i++) {
      var collection = collections[i];
      var username = collection.user && collection.user.username ? String(collection.user.username) : null;
      var collectionId = collection.id != null ? String(collection.id) : null;
      for (var j = 0; j < collection.items.length; j++) {
        var rec = readMedia(collection.items[j], "stories");
        if (!rec || seen[rec.pk]) continue;
        if (!rec.username && username) rec.username = username;
        rec.storyCollectionId = collectionId;
        rec.storyIndex = j;
        rec.storyCount = collection.items.length;
        seen[rec.pk] = true;
        records.push(rec);
      }
    }
    enrichStoryUsernames(records, json);
    return records.length ? { surface: "stories", records: records, endCursor: null } : null;
  }

  // Parse the private paginated user-feed endpoints we call directly (page.js):
  //   GET  /api/v1/feed/user/<id>/   -> items are raw media objects
  //   POST /api/v1/clips/user/       -> items are { media: {...} } wrappers
  // Returns records tagged with the caller's surface plus the max_id cursor and
  // more-available flag needed to page. Distinct from parseResponse, which reads
  // the browser's GraphQL envelope (a different shape and a different cursor).
  function parseUserFeed(json, surface) {
    if (!json || !Array.isArray(json.items)) return null;
    var records = [];
    for (var i = 0; i < json.items.length; i++) {
      var item = json.items[i];
      var media = item && item.media && typeof item.media === "object" ? item.media : item;
      var rec = readMedia(media, surface || "generic");
      if (rec) records.push(rec);
    }
    var paging = json.paging_info || null;
    var nextMaxId = (paging && paging.max_id) || json.next_max_id || null;
    var moreFlag = paging ? paging.more_available : json.more_available;
    var moreAvailable = !!moreFlag && !!nextMaxId;
    return { surface: surface || "generic", records: records, nextMaxId: nextMaxId || null, moreAvailable: moreAvailable };
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
    parseDashManifest: parseDashManifest,
    parseResponse: parseResponse,
    parseStoryHighlight: parseStoryHighlight,
    parseStoryHighlightPayload: parseStoryHighlightPayload,
    parseStoryViewer: parseStoryViewer,
    parseInfo: parseInfo,
    parseUserFeed: parseUserFeed,
    parseProfile: parseProfile,
    compareRecords: compareRecords,
    extractHashtags: extractHashtags,
    audioInfo: audioInfo,
    usernamesFrom: usernamesFrom
  };

  root.AFW = root.AFW || {};
  root.AFW.schema = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));

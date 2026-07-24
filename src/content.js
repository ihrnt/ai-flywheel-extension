// AI Flywheel - isolated-world content script. Owns storage, the post registry,
// route-scoped ranking, badge/toolbar injection, reel controls, and downloads.
// Built to mockups/injected-feed.html + video-controls.html on live IG data
// (see docs/ig-capture-notes.md). Schema helpers come from AFW.schema.
(function () {
  "use strict";
  var log = function () { console.log.apply(console, ["[AI Flywheel]"].concat([].slice.call(arguments))); };
  var isInstagram = location.hostname.indexOf("instagram.com") !== -1;

  // Sort logic (isolated world). MAIN-world src/schema/instagram.js does the
  // parsing; the isolated world only compares records it already received, so
  // this small map + comparator is inlined here (Chrome injects a shared file
  // into one world only). Keep in sync with schema.IG_SORT_FIELD.
  var IG_SORT_FIELD = { likes: "likes", comments: "comments", reelViews: "plays", reelDate: "takenAt", postDate: "takenAt" };
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

  // ---- filters ----------------------------------------------------------
  // Every filter is additive and default-empty: with no filter set,
  // recordPassesFilters returns true for every record, so the pipeline stays
  // identical to the pre-filter behavior. The filter state lives inside
  // options.instagram.filters (persisted by the background) and is mirrored
  // locally via filtersVersion so rankInfo + the toolbar can memoize on it.
  function defaultFilters() {
    return {
      minViews: null, maxViews: null,
      minLikes: null, maxLikes: null,
      minComments: null, maxComments: null,
      paid: "any",
      period: "all",
      periodFrom: null, periodTo: null,
      lastN: null,
      collaborators: [], hashtags: [], tags: [], locations: []
    };
  }
  function currentFilters() {
    var f = options && options.instagram && options.instagram.filters;
    return f ? f : defaultFilters();
  }
  function filtersActive() {
    var f = currentFilters();
    if (f.minViews != null || f.maxViews != null) return true;
    if (f.minLikes != null || f.maxLikes != null) return true;
    if (f.minComments != null || f.maxComments != null) return true;
    if (f.paid && f.paid !== "any") return true;
    if (f.period && f.period !== "all") return true;
    if (f.lastN && f.lastN > 0) return true;
    if (f.collaborators && f.collaborators.length) return true;
    if (f.hashtags && f.hashtags.length) return true;
    if (f.tags && f.tags.length) return true;
    if (f.locations && f.locations.length) return true;
    return false;
  }
  function activeFilterGroupCount() {
    var f = currentFilters();
    var n = 0;
    if (f.minViews != null || f.maxViews != null || f.minLikes != null || f.maxLikes != null || f.minComments != null || f.maxComments != null) n++;
    if (f.period !== "all" || (f.lastN && f.lastN > 0)) n++;
    if (f.paid && f.paid !== "any") n++;
    if (f.collaborators && f.collaborators.length) n++;
    if (f.hashtags && f.hashtags.length) n++;
    if (f.tags && f.tags.length) n++;
    if (f.locations && f.locations.length) n++;
    return n;
  }
  function hasAny(recValues, selected) {
    if (!selected || !selected.length || !recValues || !recValues.length) return false;
    var set = Object.create(null);
    for (var i = 0; i < recValues.length; i++) set[String(recValues[i]).toLowerCase()] = true;
    for (var j = 0; j < selected.length; j++) if (set[String(selected[j]).toLowerCase()]) return true;
    return false;
  }
  function periodFromSec(f) {
    var now = Math.floor(Date.now() / 1000);
    if (f.period === "7d") return now - 7 * 86400;
    if (f.period === "30d") return now - 30 * 86400;
    if (f.period === "90d") return now - 90 * 86400;
    if (f.period === "ytd") return Math.floor(new Date(new Date().getFullYear(), 0, 1).getTime() / 1000);
    if (f.period === "custom") return f.periodFrom;
    return null;
  }
  function periodToSec(f) {
    if (f.period === "custom") return f.periodTo;
    return null;
  }
  function recordPassesFilters(rec) {
    if (!rec) return false;
    if (!filtersActive()) return true;
    var f = currentFilters();
    if (f.minViews != null && (rec.plays == null || rec.plays < f.minViews)) return false;
    if (f.maxViews != null && (rec.plays == null || rec.plays > f.maxViews)) return false;
    if (f.minLikes != null && (rec.likes == null || rec.likes < f.minLikes)) return false;
    if (f.maxLikes != null && (rec.likes == null || rec.likes > f.maxLikes)) return false;
    if (f.minComments != null && (rec.comments == null || rec.comments < f.minComments)) return false;
    if (f.maxComments != null && (rec.comments == null || rec.comments > f.maxComments)) return false;
    if (f.paid === "paid" && !rec.paidPartnership) return false;
    if (f.paid === "unpaid" && rec.paidPartnership) return false;
    var from = periodFromSec(f), to = periodToSec(f);
    if ((from || to) && rec.takenAt == null) return false;
    if (from && rec.takenAt < from) return false;
    if (to && rec.takenAt > to) return false;
    if (f.collaborators && f.collaborators.length && !hasAny(rec.collaborators, f.collaborators)) return false;
    if (f.hashtags && f.hashtags.length && !hasAny(rec.hashtags, f.hashtags)) return false;
    if (f.tags && f.tags.length && !hasAny(rec.taggedUsers, f.tags)) return false;
    if (f.locations && f.locations.length) {
      if (!rec.location) return false;
      if (f.locations.indexOf(String(rec.location).toLowerCase()) === -1) return false;
    }
    return true;
  }
  var filtersVersion = 0;
  var filtersBumpedLocally = false;
  function bumpFilters() {
    filtersVersion++;
    activeStore.rankCache = null;
  }
  // Safety-net: Chrome shadow-DOM number inputs sometimes swallow both `input`
  // and `change` events, so typed values never reach the options object.  Read
  // the DOM inputs directly and merge into the live filters if they differ.
  // Called at the top of snapshotRecords() and filteredMembers() — cheap (a few
  // querySelector + parseInt calls) and guarantees the stored filters stay in
  // sync with what the user actually sees in the panel.
  function pollFilterInputs() {
    if (!filterRoot || !filterHost || filterHost.style.display === "none") return;
    var f = currentFilters();
    var next = null;
    function ensure() { if (!next) next = cloneFilters(); }
    filterRoot.querySelectorAll(".fi[data-rk]").forEach(function (input) {
      var key = (input.dataset.rv === "min" ? "min" : "max") + input.dataset.rk;
      var raw = input.value.trim();
      var num = raw === "" ? null : parseInt(raw, 10);
      if (!Number.isFinite(num)) num = null;
      if (num !== f[key]) { ensure(); next[key] = num; }
    });
    // Custom lastN input (data-af='lastN') — only relevant when "Custom" is selected.
    var lnInput = filterRoot.querySelector("[data-af='lastN']");
    if (lnInput && lnInput.offsetParent !== null) {
      var raw = lnInput.value.trim();
      var num = raw === "" ? null : parseInt(raw, 10);
      if (!Number.isFinite(num)) num = null;
      else num = Math.max(1, num);
      if (num !== f.lastN) { ensure(); next.lastN = num; }
    }
    if (next) setFilters(next);
  }

  // ---- state ------------------------------------------------------------
  function surfaceInfo() {
    var path = location.pathname.replace(/\/+$/, "") || "/";
    if (path === "/") return { kind: "home", key: "home", sortable: false };
    if (/^\/explore(?:\/|$)/.test(path)) return { kind: "explore", key: "explore", sortable: true };
    if (/^\/reels(?:\/|$)/.test(path)) return { kind: "reels-feed", key: "reels-feed", sortable: false };
    var handle = profileHandle();
    if (handle && new RegExp("^/" + handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/reels$", "i").test(path)) {
      return { kind: "profile-reels", key: "profile:" + handle.toLowerCase() + ":reels", handle: handle, sortable: true };
    }
    if (handle && path.toLowerCase() === "/" + handle.toLowerCase()) {
      return { kind: "profile-posts", key: "profile:" + handle.toLowerCase() + ":posts", handle: handle, sortable: true };
    }
    return { kind: "detail", key: "detail:" + path, sortable: false };
  }

  // Records live in ONE session-wide cache so payloads from any surface enrich
  // the same object (the posts-tab payload carries the taken_at/caption the
  // reels-tab payload lacks; merged by pk). Each route only keeps a VIEW over
  // the cache: which pks belong to it, plus its ranking snapshot and caps.
  var registry = new Map();      // pk -> record (session-wide, merged)
  var codeIndex = new Map();     // shortcode -> pk (session-wide)
  var registryVersion = 0;       // bumped on every ingest change

  function newRouteStore() {
    return {
      memberPks: new Set(),
      snapshotPks: [],
      rankedCount: 0,
      rankCache: null,           // { version, field, rankByPk, breakoutByPk }
      shortcodeRequested: new Set(),
      shortcodeRequestCount: 0,
      infoRequested: new Set(),
      infoRequestCount: 0
    };
  }

  var activeSurface = surfaceInfo();
  var activeStore = newRouteStore();
  var profiles = new Map();   // username -> profile/account data
  var profileRequested = new Set();
  var profileHost = null;
  var profileCache = window.AFW && window.AFW.profileCache;
  var postCache = window.AFW && window.AFW.postCache;
  var cachedAbout = new Map();
  var aboutCacheReads = new Set();
  var aboutCacheReady = new Set();
  var options = null;

  // ---- post-record cache (IndexedDB, 24h) -------------------------------
  // Loads a surface's cached records into the registry on entry so revisiting
  // a profile the same day is instant. Writes are debounced and best-effort.
  var cacheLoadRequested = new Set();
  var cacheWriteTimer = null;
  function loadCachedSurface(surface) {
    if (!postCache || !surface || !surface.sortable) return;
    if (cacheLoadRequested.has(surface.key)) return;
    cacheLoadRequested.add(surface.key);
    postCache.get(surface.key).then(function (entry) {
      if (!entry || !entry.records || !entry.records.length) return;
      // Only merge records we don't already have fresher data for. Flag them so
      // a live fetch overwrites their (possibly stale) metrics.
      var fresh = [];
      for (var i = 0; i < entry.records.length; i++) {
        var rec = entry.records[i];
        if (rec && rec.pk && !registry.has(rec.pk)) {
          rec.__afwFromCache = true;
          fresh.push(rec);
        }
      }
      if (fresh.length) ingest(fresh);
    });
  }
  function scheduleCacheWrite() {
    if (!postCache || !activeSurface.sortable) return;
    if (cacheWriteTimer) clearTimeout(cacheWriteTimer);
    cacheWriteTimer = setTimeout(function () {
      cacheWriteTimer = null;
      var key = activeSurface.key;
      // Persist clean copies without the session-local internal flags.
      var records = memberRecords().map(function (rec) {
        var clean = {};
        for (var k in rec) {
          if (Object.prototype.hasOwnProperty.call(rec, k) && k.indexOf("__afw") !== 0) clean[k] = rec[k];
        }
        return clean;
      });
      postCache.put(key, records).catch(function () {});
    }, 1500);
  }
  var license = { pro: false };
  var writing = false;        // pause the observer during our own DOM writes
  var writingTimer = null;

  function memberRecords() {
    var out = [];
    activeStore.memberPks.forEach(function (pk) {
      var rec = registry.get(pk);
      if (rec) out.push(rec);
    });
    return out;
  }
  function filteredMembers() {
    var out = memberRecords();
    if (filtersActive()) out = out.filter(recordPassesFilters);
    return out;
  }

  function syncSurface() {
    var next = surfaceInfo();
    if (next.key === activeSurface.key) {
      activeSurface = next;
      return next;
    }
    destroySortedView(false);
    sv.closedByUser = false; // closing is per-surface, not forever
    clearBadges();
    activeSurface = next;
    activeStore = newRouteStore();
    toolbarRenderKey = "";
    loadCachedSurface(next); // warm the registry from IndexedDB on a fresh surface
    return next;
  }

  // Toolbar sort label -> popup sortBy value.
  var TOOLBAR_TO_SORT = { views: "reelViews", likes: "likes", comments: "comments", recent: "postDate" };
  var SORT_TO_TOOLBAR = { reelViews: "views", likes: "likes", comments: "comments", reelDate: "recent", postDate: "recent" };

  function igOn() {
    return !!(isInstagram && options && options.instagram && license.pro);
  }

  // isolated -> MAIN world (page.js) messaging
  function sendToPage(type, data) {
    document.dispatchEvent(new CustomEvent("afw:content", { detail: JSON.stringify({ type: type, data: data }) }));
  }

  // ---- helpers ----------------------------------------------------------
  function fmt(n) {
    if (n == null) return "–";
    n = +n;
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, "") + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, "") + "K";
    return String(n);
  }
  function fmtX(n) {
    if (!Number.isFinite(n)) return "";
    return (n >= 10 ? n.toFixed(n >= 100 ? 0 : 1) : n.toFixed(1)).replace(/\.0$/, "") + "x";
  }
  var ICONS = {
    eye: "<path d='M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z'/><circle cx='12' cy='12' r='3'/>",
    heart: "<path d='M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z'/>",
    comment: "<path d='M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'/>",
    calendar: "<rect x='3' y='4' width='18' height='18' rx='2'/><line x1='16' y1='2' x2='16' y2='6'/><line x1='8' y1='2' x2='8' y2='6'/><line x1='3' y1='10' x2='21' y2='10'/>",
    download: "<path d='M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4'/><polyline points='7 10 12 15 17 10'/><line x1='12' y1='15' x2='12' y2='3'/>",
    csv: "<path d='M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z'/><polyline points='14 2 14 8 20 8'/><line x1='8' y1='13' x2='16' y2='13'/><line x1='8' y1='17' x2='16' y2='17'/>",
    account: "<rect x='3' y='4' width='18' height='16' rx='2'/><path d='M7 15l3-3 2 2 3-4 2 5'/><path d='M8 8h.01M16 8h.01'/><path d='M9 20l3-3 3 3'/>",
    sortDesc: "<line x1='4' y1='6' x2='12' y2='6'/><line x1='4' y1='12' x2='10' y2='12'/><line x1='4' y1='18' x2='8' y2='18'/><line x1='17' y1='5' x2='17' y2='19'/><polyline points='14 16 17 19 20 16'/>",
    sortAsc: "<line x1='4' y1='6' x2='8' y2='6'/><line x1='4' y1='12' x2='10' y2='12'/><line x1='4' y1='18' x2='12' y2='18'/><line x1='17' y1='19' x2='17' y2='5'/><polyline points='14 8 17 5 20 8'/>",
    scroll: "<rect x='7' y='3' width='10' height='14' rx='5'/><line x1='12' y1='7' x2='12' y2='10'/><polyline points='8 20 12 23 16 20'/>",
    top: "<line x1='5' y1='4' x2='19' y2='4'/><line x1='12' y1='20' x2='12' y2='8'/><polyline points='6 14 12 8 18 14'/>",
    grid: "<rect x='3' y='3' width='7' height='7' rx='1'/><rect x='14' y='3' width='7' height='7' rx='1'/><rect x='3' y='14' width='7' height='7' rx='1'/><rect x='14' y='14' width='7' height='7' rx='1'/>",
    funnel: "<path d='M3 4h18l-7 8v6l-4 2v-8z'/>",
    grip: "<circle cx='9' cy='6' r='1.4'/><circle cx='15' cy='6' r='1.4'/><circle cx='9' cy='12' r='1.4'/><circle cx='15' cy='12' r='1.4'/><circle cx='9' cy='18' r='1.4'/><circle cx='15' cy='18' r='1.4'/>",
    search: "<circle cx='11' cy='11' r='7'/><line x1='21' y1='21' x2='16.65' y2='16.65'/>",
    close: "<line x1='6' y1='6' x2='18' y2='18'/><line x1='18' y1='6' x2='6' y2='18'/>"
  };
  function svg(paths) {
    return "<svg viewBox='0 0 24 24' fill='none' stroke-linecap='round' stroke-linejoin='round'>" + paths + "</svg>";
  }
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function textEl(tag, cls, text) {
    var e = el(tag, cls);
    e.textContent = text == null ? "" : String(text);
    return e;
  }
  function dateLabel(ts) {
    if (ts == null) return null;
    var d = new Date(ts * 1000);
    if (Number.isNaN(d.getTime())) return null;
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit"
    }).format(d);
  }
  function dateIso(ts) {
    if (ts == null) return "";
    var d = new Date(ts * 1000);
    return Number.isNaN(d.getTime()) ? "" : d.toISOString();
  }
  function parseDomTime(time) {
    if (!time) return null;
    var raw = time.getAttribute("datetime") || time.getAttribute("title") || time.textContent;
    if (!raw) return null;
    var d = new Date(raw.trim());
    return Number.isNaN(d.getTime()) ? null : Math.floor(d.getTime() / 1000);
  }
  function domTakenAt(host) {
    var scope = (host && host.closest && host.closest("article")) || host;
    var times = scope ? [].slice.call(scope.querySelectorAll("time[datetime],time[title],time")) : [];
    if (!times.length && pageCode()) times = [].slice.call(document.querySelectorAll("main time[datetime],main time[title],main time"));
    for (var i = 0; i < times.length; i++) {
      var ts = parseDomTime(times[i]);
      if (ts) return ts;
    }
    return null;
  }
  function syncDomDate(rec, host) {
    if (!rec || rec.takenAt != null) return;
    var ts = domTakenAt(host);
    if (ts) {
      rec.takenAt = ts;
      rec.__afwTakenAtFromDom = true;
    }
  }
  function ymd(d) {
    d = d || new Date();
    return d.getFullYear() + ("0" + (d.getMonth() + 1)).slice(-2) + ("0" + d.getDate()).slice(-2);
  }
  function safeFilePart(value, fallback) {
    var s = String(value || fallback || "").replace(/^@+/, "").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();
    return s || fallback || "Instagram";
  }
  function profileHandle() {
    var m = location.pathname.match(/^\/([^/?#]+)/);
    if (!m) return null;
    var part = m[1];
    try { part = decodeURIComponent(part); } catch (e) {}
    var reserved = { p: 1, reel: 1, reels: 1, tv: 1, explore: 1, search: 1, accounts: 1, direct: 1, stories: 1 };
    return reserved[String(part).toLowerCase()] ? null : part;
  }
  function channelHandle(rec) {
    if (rec && rec.username) return safeFilePart(rec.username, "Instagram");
    var fromUrl = profileHandle();
    if (fromUrl) return safeFilePart(fromUrl, "Instagram");
    var first = null;
    activeStore.memberPks.forEach(function (pk) {
      if (first) return;
      var r = registry.get(pk);
      if (r && r.username) first = r.username;
    });
    return safeFilePart(first, "Instagram");
  }
  function beginDomWrite() {
    if (writingTimer) { clearTimeout(writingTimer); writingTimer = null; }
    writing = true;
  }
  function endDomWriteSoon() {
    if (writingTimer) clearTimeout(writingTimer);
    writingTimer = setTimeout(function () { writing = false; writingTimer = null; }, 0);
  }
  function withDomWrites(fn) {
    beginDomWrite();
    try { return fn(); }
    finally { endDomWriteSoon(); }
  }
  function isAfwNode(node) {
    if (!node || node.nodeType !== 1) return false;
    if (node.id && node.id.indexOf("afw-") === 0) return true;
    if (node.classList && [].slice.call(node.classList).some(function (c) { return c.indexOf("afw-") === 0 && c !== "afw-tile" && c !== "afw-has-vc"; })) return true;
    return !!(node.closest && node.closest("#afw-toolbar-host,#afw-menu-host,#afw-filter-host,#afw-styles,#afw-sorted-host,#afw-profile-host,.afw-overlay,.afw-vc"));
  }
  function onlyAfwMutations(mutations) {
    for (var i = 0; i < mutations.length; i++) {
      var m = mutations[i];
      if (isAfwNode(m.target)) continue;
      var nodes = [].slice.call(m.addedNodes || []).concat([].slice.call(m.removedNodes || []));
      if (!nodes.length) return false;
      for (var j = 0; j < nodes.length; j++) if (!isAfwNode(nodes[j])) return false;
    }
    return true;
  }

  // ---- registry ---------------------------------------------------------
  // Route membership: everything ingested while a route is active belongs to
  // it, EXCEPT records that clearly belong to another creator while we are on
  // a profile route (late responses from a previous profile, home-feed
  // prefetches). Those still merge into the session cache for later reuse.
  function belongsToRoute(rec) {
    if (activeSurface.kind !== "profile-posts" && activeSurface.kind !== "profile-reels") return true;
    if (!rec.username) return true;
    var handle = normalHandle(activeSurface.handle);
    return !handle || normalHandle(rec.username) === handle;
  }

  function ingest(records) {
    var changed = false;
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      var prev = registry.get(r.pk);
      if (prev) {
        // When the existing record came from the 24h cache, a fresh fetch is
        // authoritative: overwrite its metrics so a stale like/view count never
        // survives the session. Otherwise merge: fill nulls (e.g. /info/ adds
        // caption/takenAt) without clobbering fresher numbers.
        var fromCache = prev.__afwFromCache === true;
        for (var k in r) {
          if (r[k] == null) continue;
          var isMetric = k === "likes" || k === "comments" || k === "plays";
          if (fromCache && isMetric) {
            if (prev[k] !== r[k]) { prev[k] = r[k]; changed = true; }
            continue;
          }
          if (prev[k] == null || (k === "takenAt" && prev.__afwTakenAtFromDom)) {
            prev[k] = r[k];
            if (k === "takenAt") delete prev.__afwTakenAtFromDom;
            changed = true;
          }
        }
        if (fromCache) delete prev.__afwFromCache; // refreshed by live data
        // assets is never null, so upgrade it when /info/ brings the video the grid lacked
        var prevVid = (prev.assets || []).some(function (a) { return a.type === "video"; });
        var newVid = (r.assets || []).some(function (a) { return a.type === "video"; });
        if (newVid && !prevVid) { prev.assets = r.assets; prev.videoUrl = r.videoUrl || prev.videoUrl; changed = true; }
      } else {
        registry.set(r.pk, r);
        changed = true;
      }
      if (belongsToRoute(r) && !activeStore.memberPks.has(r.pk)) {
        activeStore.memberPks.add(r.pk);
        changed = true;
      }
      if (r.code) codeIndex.set(r.code, r.pk);
      if (pendingActions.has(r.pk)) runPending(r.pk);
    }
    if (changed) {
      registryVersion++;
      // Stop the load-scroll as soon as the target is reached; refresh progress.
      if (scrollTimer && loadTarget) {
        if (loadTargetMet()) stopAutoScroll();
        else updateLoadStatus();
      }
      scheduleCacheWrite(); // persist the surface's records for instant revisit
      schedule("both");
    }
  }

  function normalHandle(value) {
    var s = String(value || "").trim().replace(/^@+/, "").trim();
    return s ? s.toLowerCase() : null;
  }

  function mergeCachedAbout(handle, profile) {
    var key = normalHandle(handle);
    var cached = key && cachedAbout.get(key);
    if (!profileCache || !cached || !profile || !profile.profileLoaded || profile.aboutLoaded) return false;
    return profileCache.mergeAbout(profile, cached);
  }

  function loadCachedAbout(handle) {
    var key = normalHandle(handle);
    if (!key || aboutCacheReads.has(key)) return;
    aboutCacheReads.add(key);
    if (!profileCache) {
      aboutCacheReady.add(key);
      schedule("native");
      return;
    }
    profileCache.get(key).then(function (cached) {
      if (cached) cachedAbout.set(key, cached);
      aboutCacheReady.add(key);
      var profile = profiles.get(key);
      mergeCachedAbout(key, profile);
      schedule("native");
    });
  }

  function ingestProfile(profile) {
    if (!profile || typeof profile !== "object") return;
    var handle = normalHandle(profile.username || profileHandle());
    if (!handle) return;
    var prev = profiles.get(handle) || {};
    var changed = !profiles.has(handle);
    if (!profile.username) profile.username = handle;
    for (var k in profile) {
      if (!Object.prototype.hasOwnProperty.call(profile, k)) continue;
      var value = profile[k];
      if (value == null || value === "") continue;
      if (prev[k] !== value) { prev[k] = value; changed = true; }
    }
    profiles.set(handle, prev);
    if (profile.profileLoaded && mergeCachedAbout(handle, prev)) changed = true;
    if (profile.aboutLoaded && profileCache) {
      var cached = profileCache.createRecord(handle, profile, Date.now());
      if (cached) {
        cachedAbout.set(handle, cached);
        aboutCacheReady.add(handle);
        profileCache.put(handle, profile, cached.updatedAt);
      }
    }
    if (changed) schedule();
  }

  function requestProfile(handle) {
    var key = normalHandle(handle);
    if (!key || profileRequested.has(key)) return;
    profileRequested.add(key);
    sendToPage("fetchProfile", { username: handle });
  }

  // Ask once per profile session only after the normal profile response and
  // persistent About cache lookup are ready. A fresh 24-hour cache skips the
  // hidden interaction entirely.
  var aboutAsked = new Set();
  function requestAbout(handle) {
    var key = normalHandle(handle);
    if (!key) return;
    var profile = profiles.get(key);
    if (!profile || !profile.profileLoaded || profile.aboutLoaded) return;
    if (!aboutCacheReady.has(key)) return;
    if (profileCache && profileCache.isFresh(cachedAbout.get(key))) return;
    if (aboutAsked.has(key)) return;
    aboutAsked.add(key);
    sendToPage("fetchAbout", { username: handle });
  }

  function firstText() {
    for (var i = 0; i < arguments.length; i++) {
      var value = arguments[i];
      if (value != null && String(value).trim()) return String(value).trim();
    }
    return "";
  }

  function accountType(profile) {
    if (profile.accountType) return profile.accountType;
    if (profile.isBusiness) return "Business";
    if (profile.isProfessional || profile.categoryName || profile.businessCategoryName || profile.overallCategoryName) return "Creator";
    if (profile.profileLoaded) return "Personal";
    return "";
  }

  function profileCards(profile) {
    var type = accountType(profile);
    var category = firstText(profile.categoryName, profile.businessCategoryName, profile.overallCategoryName, profile.categoryEnum);
    var verified = firstText(profile.verifiedAbout, profile.profileLoaded ? (profile.isVerified ? "Yes" : "No") : "");
    return [
      { label: "Account type", value: type || "-" },
      { label: "Category", value: category || "-" },
      { label: "Based in", value: firstText(profile.basedIn, profile.aboutLoaded ? "Not shared" : "-") },
      { label: "Join Date", value: firstText(profile.joinDate, "-") },
      { label: "Verified", value: verified || "-" },
      { label: "Username change", value: firstText(profile.formerUsernames, "-") }
    ];
  }

  function nextNonAfwElement(node) {
    var next = node && node.nextElementSibling;
    while (next && isAfwNode(next)) next = next.nextElementSibling;
    return next;
  }

  function statsScore(node) {
    var text = String((node && node.textContent) || "").replace(/\s+/g, " ").toLowerCase();
    var score = 0;
    if (text.indexOf("post") !== -1) score++;
    if (text.indexOf("follower") !== -1) score++;
    if (text.indexOf("following") !== -1) score++;
    return score;
  }

  // The stats row: the DEEPEST header element whose text carries posts +
  // followers + following (works whether IG renders it as the old ul or the
  // current div row). Deepest = no direct child scores 3 on its own.
  function profileStatsRow(header) {
    var all = header.querySelectorAll("ul,div");
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (isAfwNode(el) || statsScore(el) < 3) continue;
      if ((el.textContent || "").replace(/\s+/g, " ").length > 260) continue;
      var deeper = false;
      for (var j = 0; j < el.children.length; j++) {
        if (!isAfwNode(el.children[j]) && statsScore(el.children[j]) >= 3) { deeper = true; break; }
      }
      if (!deeper) return el;
    }
    return null;
  }

  // Locale-proof fallback: climb from the username h2/h1 to the section child
  // that holds the handle row + name + stats (the header's identity container)
  // and append at its end - the same spot the stats-row path targets. Verified
  // live 2026-07-08, see docs/ig-capture-notes.md.
  function profileIdentityTarget(header) {
    var handle = header.querySelector("h2,h1");
    if (!handle || isAfwNode(handle)) return null;
    for (var cur = handle; cur && cur !== header; cur = cur.parentElement) {
      var p = cur.parentElement;
      if (p && p.tagName === "SECTION") return { parent: cur, before: null };
    }
    return null;
  }

  // Where the profile cards mount: right after the stats row, inside the
  // identity container - between the handle/stats and the bio.
  function profilePanelTarget() {
    var header = document.querySelector("main header");
    if (!header) return null;
    var stats = profileStatsRow(header);
    if (stats && stats.parentNode) {
      return { parent: stats.parentNode, before: nextNonAfwElement(stats) };
    }
    return profileIdentityTarget(header);
  }

  function clearProfilePanel() {
    if (profileHost && profileHost.parentNode) profileHost.parentNode.removeChild(profileHost);
    if (profileHost) delete profileHost.__afwProfileKey;
  }

  function renderProfilePanel() {
    var handle = profileHandle();
    if (!handle) { clearProfilePanel(); return; }
    requestProfile(handle);
    loadCachedAbout(handle);
    var profile = profiles.get(normalHandle(handle));
    if (!profile || !profile.profileLoaded) { clearProfilePanel(); return; }
    mergeCachedAbout(handle, profile);
    var cards = profileCards(profile);
    if (!cards.length) { clearProfilePanel(); return; }
    var target = profilePanelTarget();
    if (!target) { clearProfilePanel(); return; }
    requestAbout(handle);
    var key = normalHandle(handle) + "|" + cards.map(function (card) { return card.label + ":" + card.value; }).join("|");
    if (!profileHost) {
      profileHost = el("div", "afw-profile-panel");
      profileHost.id = "afw-profile-host";
    }
    if (profileHost.__afwProfileKey !== key) {
      profileHost.textContent = "";
      profileHost.appendChild(el("div", "afw-profile-mark", svg(ICONS.account)));
      cards.forEach(function (card) {
        var c = el("div", "afw-profile-card");
        c.appendChild(textEl("div", "afw-profile-label", card.label));
        if (card.href) {
          var a = textEl("a", "afw-profile-value afw-profile-link", card.value);
          a.href = card.href;
          a.target = "_blank";
          a.rel = "noreferrer";
          c.appendChild(a);
        } else {
          c.appendChild(textEl("div", "afw-profile-value", card.value));
        }
        profileHost.appendChild(c);
      });
      profileHost.__afwProfileKey = key;
    }
    var placed = profileHost.parentNode === target.parent && (target.before ? profileHost.nextSibling === target.before : !profileHost.nextSibling);
    if (!placed) {
      target.parent.insertBefore(profileHost, target.before);
    }
  }

  // ---- tiles ------------------------------------------------------------
  function nativeRowChildren(row) {
    return [].slice.call((row && row.children) || []).filter(function (child) { return !isAfwNode(child); });
  }
  function collectRows() {
    if (!activeSurface.sortable) return [];
    // Profile grid: flex column of ._ac7v rows, each holding 3 tile wrappers.
    var isProfileGrid = activeSurface.kind === "profile-reels" || activeSurface.kind === "profile-posts";
    var rows = isProfileGrid ? [].slice.call(document.querySelectorAll("div._ac7v")) : [];
    if (rows.length) return rows;
    // Fallback if IG renames _ac7v. Start from post anchors instead of every
    // div on the page, so non-grid pages do not pay for a full DOM scan.
    var anchors = [].slice.call(document.querySelectorAll("a[href*='/p/'],a[href*='/reel/'],a[href*='/tv/']"))
      .filter(function (anchor) { return !isAfwNode(anchor); });
    var seen = new Set(), out = [];
    function looksLikeRow(row) {
      if (!row || isAfwNode(row)) return false;
      var kids = nativeRowChildren(row), n = 0, ok = kids.length >= 2;
      for (var j = 0; j < kids.length && ok; j++) {
        if (kids[j].querySelector && kids[j].querySelector("a[href*='/p/'],a[href*='/reel/'],a[href*='/tv/']")) n++;
        else { ok = false; }
      }
      return ok && n === kids.length && n >= 2;
    }
    for (var i = 0; i < anchors.length; i++) {
      var node = anchors[i].parentElement;
      for (var depth = 0; node && depth < 4; depth++, node = node.parentElement) {
        var parent = node.parentElement;
        if (!parent) continue;
        if (looksLikeRow(parent)) {
          if (!seen.has(parent)) { seen.add(parent); out.push(parent); }
          break;
        }
      }
    }
    return out;
  }
  function tileCode(tileEl) {
    var a = tileEl.querySelector("a[href*='/p/'],a[href*='/reel/'],a[href*='/tv/']");
    if (!a) return null;
    var m = (a.getAttribute("href") || "").match(/\/(?:p|reel|tv)\/([^/?#]+)/);
    return m ? m[1] : null;
  }
  function pageCode() {
    var m = location.pathname.match(/\/(?:p|reel|reels|tv)\/([^/?#]+)/);
    return m ? m[1] : null;
  }
  function goodHost(elm) {
    if (!elm || elm === document.body || elm === document.documentElement) return false;
    if (elm.tagName === "VIDEO" || elm.tagName === "IMG") return false;
    var r = elm.getBoundingClientRect();
    return r.width >= 180 && r.height >= 180;
  }
  function hostForAnchor(a) {
    function largestMedia(scope) {
      if (!scope) return null;
      var nodes = [].slice.call(scope.querySelectorAll("video,img"));
      var best = null, score = 0;
      nodes.forEach(function (node) {
        var rect = node.getBoundingClientRect();
        if (rect.width < 180 || rect.height < 180) return;
        var next = rect.width * rect.height * (node.tagName === "VIDEO" ? 1.1 : 1);
        if (next > score) { score = next; best = node; }
      });
      return best;
    }
    var article = a.closest("article");
    var media = largestMedia(a) || largestMedia(article);
    if (media) {
      var mediaRect = media.getBoundingClientRect();
      var host = media.parentElement, fallback = null;
      for (var i = 0; host && i < 6; i++, host = host.parentElement) {
        if (!goodHost(host)) continue;
        var rect = host.getBoundingClientRect();
        if (!fallback) fallback = host;
        if (rect.width <= mediaRect.width * 1.2 && rect.height <= mediaRect.height * 1.45) return host;
        if (article && host === article) break;
      }
      if (fallback) return fallback;
    }
    var host = a;
    for (var j = 0; host && j < 6; j++, host = host.parentElement) if (goodHost(host)) return host;
    return null;
  }
  function nearViewport(host) {
    var rect = host && host.getBoundingClientRect && host.getBoundingClientRect();
    return !!rect && rect.bottom >= -200 && rect.top <= window.innerHeight + 500;
  }
  function requestShortcode(code, host) {
    if (!code || !nearViewport(host) || activeStore.shortcodeRequested.has(code) || activeStore.shortcodeRequestCount >= 60) return;
    activeStore.shortcodeRequested.add(code);
    activeStore.shortcodeRequestCount++;
    enqueueFetch({ code: code });
  }
  function visibleVideo() {
    var best = null, bestArea = 0;
    [].slice.call(document.querySelectorAll("video")).forEach(function (video) {
      var rect = video.getBoundingClientRect();
      var width = Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0));
      var height = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
      var area = width * height;
      if (area > bestArea) { bestArea = area; best = video; }
    });
    return best;
  }
  function collectLooseTiles() {
    var out = [], seen = new Set();
    function add(host, code) {
      if (!host || !code || seen.has(host)) return;
      var pk = codeIndex.get(code);
      var rec = pk ? registry.get(pk) : null;
      if (!rec) {
        if (activeSurface.kind === "home" || activeSurface.kind === "explore" || activeSurface.kind === "reels-feed" || activeSurface.kind === "detail") {
          requestShortcode(code, host);
        }
        return;
      }
      seen.add(host);
      out.push({ el: host, row: null, code: code, rec: rec });
    }
    if (activeSurface.kind === "reels-feed") {
      var reelVideo = visibleVideo();
      var reelCode = pageCode();
      if (reelVideo && reelCode) add(reelVideo.parentElement, reelCode);
      return out;
    }
    [].slice.call(document.querySelectorAll("a[href*='/p/'],a[href*='/reel/'],a[href*='/tv/']")).forEach(function (a) {
      if (isAfwNode(a)) return;
      var m = (a.getAttribute("href") || "").match(/\/(?:p|reel|tv)\/([^/?#]+)/);
      if (m) add(hostForAnchor(a), m[1]);
    });
    var pc = pageCode();
    if (pc) {
      [].slice.call(document.querySelectorAll("video")).forEach(function (v) {
        var host = v.parentElement;
        for (var i = 0; host && i < 4; i++, host = host.parentElement) {
          if (goodHost(host)) { add(host, pc); break; }
        }
      });
    }
    return out;
  }
  function tileList() {
    var rows = collectRows(), tiles = [];
    for (var i = 0; i < rows.length; i++) {
      var kids = nativeRowChildren(rows[i]);
      for (var j = 0; j < kids.length; j++) {
        var code = tileCode(kids[j]);
        var rec = code ? registry.get(codeIndex.get(code)) : null;
        if (!rec && activeSurface.kind === "explore") requestShortcode(code, kids[j]);
        tiles.push({ el: kids[j], row: rows[i], code: code, rec: rec });
      }
    }
    if (!rows.length) tiles = collectLooseTiles();
    return { rows: rows, tiles: tiles };
  }

  // ---- sort -------------------------------------------------------------
  function currentSort() {
    var ig = options.instagram;
    return { by: ig.sortBy, dir: ig.direction || "desc" };
  }
  // When the user opens the sorted view while the popup sort is "disabled",
  // pick a starting metric for them. Posts grids are mostly photos (no
  // play_count), so likes is the metric every post carries; reels and explore
  // lead with views, the product's flagship number.
  function defaultSortForSurface() {
    return activeSurface.kind === "profile-posts" ? "likes" : "reelViews";
  }
  function snapshotRecords(force) {
    var f = currentFilters();
    // lastN needs to re-derive the pool from the full filtered set each time,
    // because a new arrival can be more recent than an in-snapshot record and
    // bump it out of the window. Cheap on the visible set.
    if (force || !activeStore.snapshotPks.length || (f.lastN && f.lastN > 0)) {
      activeStore.snapshotPks = sortedRecords(filteredMembers()).map(function (rec) { return rec.pk; });
      activeStore.rankedCount = activeStore.snapshotPks.length;
    } else {
      var visible = new Set(activeStore.snapshotPks);
      activeStore.memberPks.forEach(function (pk) {
        if (visible.has(pk)) return;
        var rec = registry.get(pk);
        if (!filtersActive() || (rec && recordPassesFilters(rec))) {
          activeStore.snapshotPks.push(pk);
          visible.add(pk);
        }
      });
    }
    return activeStore.snapshotPks.map(function (pk) { return registry.get(pk); }).filter(Boolean);
  }

  function recordThumb(rec) {
    if (rec.thumbUrl) return rec.thumbUrl;
    var image = (rec.assets || []).filter(function (asset) { return asset.type === "image"; })[0];
    return image ? image.url : "";
  }

  // ---- sorted view --------------------------------------------------------
  // A fixed overlay with its own scroller, fully decoupled from Instagram's
  // DOM: nothing native is hidden, moved, or resized, so IG's virtualizer and
  // pagination keep working untouched underneath. Tiles are windowed (only the
  // visible rows +/- a small buffer exist in the DOM) and keyed by pk, so new
  // records append without rebuilding what is already on screen.
  var sv = {
    host: null, count: null, scroller: null, sizer: null,
    open: false, closedByUser: false,
    records: [],
    mounted: new Map(),          // pk -> tile element
    cols: 3, tileW: 0, rowH: 0, gap: 4,
    scrollRaf: 0, resizeObs: null
  };

  function destroySortedView(byUser) {
    if (sv.resizeObs) { sv.resizeObs.disconnect(); sv.resizeObs = null; }
    if (sv.host && sv.host.parentNode) sv.host.parentNode.removeChild(sv.host);
    sv.host = sv.count = sv.scroller = sv.sizer = null;
    sv.mounted = new Map();
    sv.records = [];
    sv.open = false;
    if (byUser) sv.closedByUser = true;
    closeFilterPanel();
    syncToolbarState();
  }

  function svEnsure() {
    if (sv.host) return;
    sv.host = el("div", "afw-sv");
    sv.host.id = "afw-sorted-host";
    var head = el("div", "afw-sv-head");
    sv.count = textEl("span", "afw-sv-count", "");
    var hint = textEl("span", "afw-sv-hint", "Auto-scroll (toolbar) loads more · re-rank sorts them in");
    var close = el("button", "afw-sv-close", svg("<line x1='6' y1='6' x2='18' y2='18'/><line x1='18' y1='6' x2='6' y2='18'/>"));
    close.title = "Close sorted view";
    close.addEventListener("click", function () {
      disableSortingView();
      renderToolbar();
    });
    head.appendChild(sv.count);
    head.appendChild(hint);
    head.appendChild(close);
    sv.scroller = el("div", "afw-sv-scroll");
    sv.sizer = el("div", "afw-sv-sizer");
    sv.scroller.appendChild(sv.sizer);
    sv.host.appendChild(head);
    sv.host.appendChild(sv.scroller);
    document.body.appendChild(sv.host);
    sv.scroller.addEventListener("scroll", function () {
      if (sv.scrollRaf) return;
      sv.scrollRaf = requestAnimationFrame(function () {
        sv.scrollRaf = 0;
        withDomWrites(svUpdateWindow);
      });
    }, { passive: true });
    if (typeof ResizeObserver !== "undefined") {
      sv.resizeObs = new ResizeObserver(function () {
        withDomWrites(function () { svLayout(); svUpdateWindow(); });
      });
      sv.resizeObs.observe(sv.scroller);
    }
    sv.open = true;
    syncToolbarState();
  }

  function svLayout() {
    if (!sv.sizer) return;
    var width = sv.sizer.clientWidth;
    if (!width) return;
    var target = activeSurface.kind === "explore" ? 4 : 3;
    sv.cols = Math.max(2, Math.min(target, Math.floor(width / 200) || 2));
    sv.tileW = (width - sv.gap * (sv.cols - 1)) / sv.cols;
    sv.rowH = sv.tileW / 0.75 + sv.gap; // IG grid tiles are 3:4
    var rows = Math.ceil(sv.records.length / sv.cols);
    sv.sizer.style.height = Math.max(0, Math.ceil(rows * sv.rowH - sv.gap)) + "px";
  }

  function svTileKey(rec, rankIdx, breakoutX) {
    return [rec.pk, rec.likes, rec.comments, rec.plays, rec.takenAt, rankIdx == null ? "" : rankIdx,
      breakoutX, options.instagram.downloads ? "dl" : "", recordThumb(rec)].join("|");
  }

  function svBuildTile(rec, rankIdx, breakoutX) {
    var tile = el("div", "afw-sv-tile");
    var link = el("a", "afw-sv-link");
    link.href = rec.url || (rec.code ? "https://www.instagram.com/reel/" + rec.code + "/" : "#");
    link.target = "_blank";
    link.rel = "noreferrer";
    var thumb = recordThumb(rec);
    if (thumb) {
      var img = el("img", "afw-sv-img");
      img.src = thumb;
      img.alt = "";
      img.loading = "lazy";
      img.decoding = "async";
      link.appendChild(img);
    }
    tile.appendChild(link);
    tile.appendChild(buildOverlay(rec, rankIdx, breakoutX));
    return tile;
  }

  function svUpdateTile(tile, rec, rankIdx, breakoutX) {
    var key = svTileKey(rec, rankIdx, breakoutX);
    if (tile.__afwKey === key) return;
    tile.__afwKey = key;
    var thumb = recordThumb(rec);
    var img = tile.querySelector(".afw-sv-img");
    if (img && thumb && img.getAttribute("src") !== thumb) img.src = thumb;
    var old = tile.querySelector(".afw-overlay");
    var next = buildOverlay(rec, rankIdx, breakoutX);
    if (old) old.replaceWith(next);
    else tile.appendChild(next);
  }

  function svUpdateWindow() {
    if (!sv.scroller || !sv.records.length || !sv.rowH) return;
    var st = sv.scroller.scrollTop;
    var vh = sv.scroller.clientHeight;
    var firstRow = Math.max(0, Math.floor(st / sv.rowH) - 2);
    var lastRow = Math.ceil((st + vh) / sv.rowH) + 2;
    var first = Math.min(firstRow * sv.cols, sv.records.length);
    var last = Math.min(sv.records.length, lastRow * sv.cols);
    var needed = new Set();
    for (var i = first; i < last; i++) needed.add(sv.records[i].pk);
    sv.mounted.forEach(function (tile, pk) {
      if (!needed.has(pk)) { tile.remove(); sv.mounted.delete(pk); }
    });
    var info = rankInfo();
    for (var idx = first; idx < last; idx++) {
      var rec = sv.records[idx];
      var rankIdx = info.rankByPk.has(rec.pk) ? info.rankByPk.get(rec.pk) : null;
      var breakoutX = info.breakoutByPk.get(rec.pk) || "";
      var tile = sv.mounted.get(rec.pk);
      if (!tile) {
        tile = svBuildTile(rec, rankIdx, breakoutX);
        tile.__afwKey = svTileKey(rec, rankIdx, breakoutX);
        sv.sizer.appendChild(tile);
        sv.mounted.set(rec.pk, tile);
      } else {
        svUpdateTile(tile, rec, rankIdx, breakoutX);
      }
      var row = Math.floor(idx / sv.cols), col = idx % sv.cols;
      var x = Math.round(col * (sv.tileW + sv.gap));
      var y = Math.round(row * sv.rowH);
      var w = Math.round(sv.tileW);
      var pos = x + "," + y + "," + w;
      if (tile.__afwPos !== pos) {
        tile.__afwPos = pos;
        tile.style.transform = "translate(" + x + "px," + y + "px)";
        tile.style.width = w + "px";
        tile.style.height = Math.round(sv.rowH - sv.gap) + "px";
      }
      // Date sorting needs taken_at; the reels-tab payload lacks it. Ask the
      // paced /info/ queue only for what is actually on screen.
      queueDateInfo(rec);
    }
  }

  function renderSortedView() {
    var sort = currentSort();
    if (!igOn() || !activeSurface.sortable || sort.by === "disabled") { destroySortedView(false); return; }
    if (!sv.open && sv.closedByUser) return;
    var records = snapshotRecords(false);
    if (!records.length) {
      // Don't destroy the view when filters produce 0 records - that would
      // collapse the toolbar accordion and hide the filter button, trapping the
      // user. Show an empty state instead, with the view still open so the
      // filter button stays reachable.
      if (filtersActive()) {
        svEnsure();
        sv.records = [];
        // Unmount any tiles still on screen from before the filter emptied the
        // set. svUpdateWindow early-returns on an empty record list, so it can't
        // do this cleanup itself; without it the old tiles stay mounted (they're
        // absolutely positioned, so the 0-height sizer doesn't hide them) and the
        // filter looks like it did nothing until a refresh clears the mounts.
        sv.mounted.forEach(function (tile) { tile.remove(); });
        sv.mounted = new Map();
        if (sv.count) {
          var total = activeStore.memberPks.size;
          sv.count.textContent = "0 of " + total + " posts match your filters";
        }
        if (sv.sizer) sv.sizer.style.height = "0px";
        if (sv.scroller && !sv.scroller.querySelector(".afw-sv-empty")) {
          var empty = el("div", "afw-sv-empty");
          empty.style.cssText = "text-align:center;padding:60px 20px;color:#6E6E76;font:400 13px var(--afw-font,inherit)";
          var msg = el("p", "", "No posts match the current filters.");
          msg.style.margin = "0 0 12px";
          var clear = el("button", "", "Clear filters");
          clear.style.cssText = "height:32px;padding:0 14px;border:1px solid rgba(255,255,255,.10);border-radius:10px;background:#1C1C1E;color:#F4F4F5;font:600 12px inherit;cursor:pointer";
          clear.addEventListener("click", clearFilters);
          empty.appendChild(msg);
          empty.appendChild(clear);
          sv.scroller.appendChild(empty);
        }
        svLayout();
        return;
      }
      // No filters active and no records: close as before.
      if (sv.open) destroySortedView(false);
      return;
    }
    svEnsure();
    // Live re-rank while the user sits at the top of the overlay (fresh
    // arrivals sort straight in). Once they scroll, the order freezes and new
    // records append at the end; the re-rank button folds them in.
    if (sv.scroller && sv.scroller.scrollTop < 50 && records.length > activeStore.rankedCount) {
      records = snapshotRecords(true);
    }
    // Remove stale empty-state if records came back.
    var staleEmpty = sv.scroller && sv.scroller.querySelector(".afw-sv-empty");
    if (staleEmpty) staleEmpty.remove();
    sv.records = records;
    var shown = records.length;
    var added = Math.max(0, shown - activeStore.rankedCount);
    var sortLabel = { reelViews: "views", likes: "likes", comments: "comments", reelDate: "date", postDate: "date" }[sort.by] || sort.by;
    var countText = shown + " sorted by " + sortLabel + (added ? " · " + added + " new at the end" : "");
    if (sv.count.textContent !== countText) sv.count.textContent = countText;
    svLayout();
    svUpdateWindow();
  }

  // Stat overlays also live inside the sorted view's own tiles; the badge
  // clear/prune passes only manage overlays on NATIVE tiles.
  function nativeOverlays() {
    return [].slice.call(document.querySelectorAll(".afw-overlay")).filter(function (overlay) {
      return !(overlay.closest && overlay.closest("#afw-sorted-host"));
    });
  }

  function clearBadges() {
    nativeOverlays().forEach(function (old) { old.remove(); });
    [].slice.call(document.querySelectorAll(".afw-tile")).forEach(function (host) {
      host.classList.remove("afw-tile", "afw-has-vc");
      host.style.removeProperty("--afw-stats-bottom");
      delete host.__afwOverlayKey;
    });
  }

  function pruneBadges(tiles) {
    var keep = new Set(tiles.map(function (tile) { return tile.el; }));
    nativeOverlays().forEach(function (overlay) {
      var host = overlay.parentElement;
      if (keep.has(host)) return;
      overlay.remove();
      if (host) {
        host.classList.remove("afw-tile");
        host.style.removeProperty("--afw-stats-bottom");
        delete host.__afwOverlayKey;
      }
    });
  }

  // All mounted scrubber bars, maintained by mountScrubber/cleanup so the
  // offset pass never has to scan the whole document.
  var liveBars = [];
  function visibleControlForHost(host) {
    if (!host) return null;
    var bars = [].slice.call(host.querySelectorAll(".afw-vc"));
    for (var i = 0; i < bars.length; i++) {
      var cs = getComputedStyle(bars[i]);
      if (cs.display !== "none" && cs.visibility !== "hidden" && bars[i].getBoundingClientRect().height) return bars[i];
    }
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
  function updateControlOffset(host) {
    var bar = visibleControlForHost(host);
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
  function refreshControlOffsets() {
    [].slice.call(document.querySelectorAll(".afw-tile")).forEach(updateControlOffset);
    for (var i = 0; i < liveBars.length; i++) updateBarInset(liveBars[i]);
  }

  // IG's mute/audio button sits at the video's bottom-right, under our bar's
  // right end. Pull the bar in past it (and only it) so the control is visible,
  // not just click-through. Fixed-inset guesses break when IG moves the button;
  // measuring it does not.
  function nativeAudioRectOver(bar) {
    var br = bar.getBoundingClientRect();
    if (!br.width) return null;
    var svgs = document.querySelectorAll('svg[aria-label]');
    for (var i = 0; i < svgs.length; i++) {
      var label = (svgs[i].getAttribute("aria-label") || "").toLowerCase();
      if (!/(^|\s)(audio|mute|unmute|sound)/.test(label) || label.indexOf("image") !== -1) continue;
      var btn = svgs[i].closest('[role="button"],button,div[tabindex]') || svgs[i];
      var r = btn.getBoundingClientRect();
      if (!r.width || r.width > 96 || r.height > 96) continue; // a real control, not a full-bleed layer
      if (r.left < br.right && r.right > br.left && r.top < br.bottom && r.bottom > br.top) return r;
    }
    return null;
  }
  function updateBarInset(bar) {
    var container = bar.parentElement;
    if (!container) return;
    var mute = nativeAudioRectOver(bar);
    if (!mute) { bar.style.removeProperty("--afw-vc-right"); return; }
    var cr = container.getBoundingClientRect();
    var inset = Math.max(10, Math.ceil(cr.right - mute.left + 8));
    bar.style.setProperty("--afw-vc-right", inset + "px");
  }

  function overlayKey(rec, sortBy, rankIdx, breakoutX) {
    return [
      rec.pk, sortBy, rankIdx == null ? "" : rankIdx, breakoutX || "",
      rec.likes == null ? "" : rec.likes,
      rec.comments == null ? "" : rec.comments,
      rec.plays == null ? "" : rec.plays,
      rec.takenAt == null ? "" : rec.takenAt,
      options.instagram.downloads ? "dl" : "nodl"
    ].join("|");
  }

  function metricBadges(rec) {
    return [
      { icon: ICONS.eye, val: rec.plays, title: "Views" },
      { icon: ICONS.heart, val: rec.likes, title: "Likes" },
      { icon: ICONS.comment, val: rec.comments, title: "Comments" }
    ];
  }

  function buildOverlay(rec, rankIdx, breakoutX) {
    var ov = el("div", "afw-overlay");
    ov.appendChild(el("div", "afw-scrim"));

    var top = el("div", "afw-top");
    if (breakoutX) {
      var breakout = el("span", "afw-breakout", breakoutX);
      breakout.title = "Breakout: " + breakoutX + " above baseline";
      top.appendChild(breakout);
    }
    if (rankIdx != null && rankIdx < 3) top.appendChild(el("span", "afw-rank", "#" + (rankIdx + 1)));
    if (top.children.length) ov.appendChild(top);

    var bottom = el("div", "afw-bottom");
    var stats = el("div", "afw-stats");
    metricBadges(rec).forEach(function (m) {
      var b = el("span", "afw-badge", svg(m.icon) + "<span class='afw-n'>" + fmt(m.val) + "</span>");
      b.title = m.title;
      stats.appendChild(b);
    });
    bottom.appendChild(stats);
    var posted = dateLabel(rec.takenAt);
    if (posted) bottom.appendChild(el("span", "afw-date", svg(ICONS.calendar) + "<span>" + posted + "</span>"));
    ov.appendChild(bottom);

    if (options.instagram.downloads) {
      var dl = el("div", "afw-dl", svg(ICONS.download));
      dl.title = "Download";
      dl.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); openMenu(rec, dl); });
      ov.appendChild(dl);
    }
    return ov;
  }

  // ---- badges -----------------------------------------------------------
  function performanceField(sortBy) {
    if (sortBy === "likes") return "likes";
    if (sortBy === "comments") return "comments";
    return "plays";
  }
  function percentile(sorted, p) {
    if (!sorted.length) return null;
    var idx = (sorted.length - 1) * p;
    var lo = Math.floor(idx), hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  }
  function mean(values) {
    return values.reduce(function (sum, val) { return sum + val; }, 0) / values.length;
  }
  function robustBaseline(values) {
    if (!values.length) return null;
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    if (sorted.length < 10) return percentile(sorted, 0.5);
    var q1 = percentile(sorted, 0.25);
    var q3 = percentile(sorted, 0.75);
    var iqr = q3 - q1;
    if (!Number.isFinite(iqr) || iqr <= 0) return percentile(sorted, 0.5);
    var low = q1 - 1.5 * iqr;
    var high = q3 + 1.5 * iqr;
    var kept = sorted.filter(function (val) { return val >= low && val <= high; });
    if (kept.length < Math.max(3, Math.ceil(sorted.length * 0.4))) return percentile(sorted, 0.5);
    return mean(kept);
  }
  function baselineValue(field, records) {
    var values = records
      .filter(function (rec) { return rec && Number.isFinite(+rec[field]) && +rec[field] > 0; })
      .map(function (rec) { return +rec[field]; });
    if (values.length < 3) return null;
    return robustBaseline(values);
  }
  // Ranks + breakout multipliers over the route's FILTERED records, memoized by
  // (registry version, sort field, filters version). Recomputed only when new
  // data lands, the sort changes, or a filter changes - not on every DOM churn.
  function rankInfo() {
    var field = performanceField(currentSort().by);
    var cache = activeStore.rankCache;
    if (cache && cache.version === registryVersion && cache.field === field && cache.filtersVersion === filtersVersion) return cache;
    var records = filteredMembers();
    var ranked = records.filter(function (rec) { return rec && rec[field] != null; })
      .sort(function (a, b) { return b[field] - a[field]; });
    var rankByPk = new Map();
    ranked.forEach(function (rec, idx) { rankByPk.set(rec.pk, idx); });
    var breakoutByPk = new Map();
    var baseline = baselineValue(field, records);
    if (Number.isFinite(baseline) && baseline > 0) {
      records.forEach(function (rec) {
        if (!rec || !Number.isFinite(+rec[field])) return;
        var ratio = +rec[field] / baseline;
        if (ratio >= 2) breakoutByPk.set(rec.pk, fmtX(ratio));
      });
    }
    cache = { version: registryVersion, field: field, filtersVersion: filtersVersion, rankByPk: rankByPk, breakoutByPk: breakoutByPk };
    activeStore.rankCache = cache;
    return cache;
  }
  var positionedHosts = typeof WeakSet !== "undefined" ? new WeakSet() : null;
  function injectBadges(ordered) {
    var s = currentSort();
    var info = rankInfo();
    ordered.forEach(function (t) {
      var host = t.el;
      var old = host.querySelector(".afw-overlay");
      if (!t.rec) {
        if (old) old.remove();
        host.classList.remove("afw-tile");
        delete host.__afwOverlayKey;
        return;
      }
      var rec = t.rec;
      syncDomDate(rec, host);
      maybeRequestDateInfo(rec, host);
      if (!positionedHosts || !positionedHosts.has(host)) {
        if (getComputedStyle(host).position === "static") host.style.position = "relative";
        if (positionedHosts) positionedHosts.add(host);
      }
      host.classList.add("afw-tile");
      var rankIdx = info.rankByPk.has(rec.pk) ? info.rankByPk.get(rec.pk) : null;
      var breakoutX = info.breakoutByPk.get(rec.pk) || "";
      var key = overlayKey(rec, s.by, rankIdx, breakoutX);
      if (old && host.__afwOverlayKey === key) return;
      var ov = buildOverlay(rec, rankIdx, breakoutX);
      host.__afwOverlayKey = key;
      if (old) old.replaceWith(ov);
      else host.appendChild(ov);
    });
  }

  // ---- downloads + per-post menu ---------------------------------------
  // Actions waiting on an on-demand /info/ fetch, keyed by pk. Each entry is
  // { need: "video"|"caption", run: fn }. Resolved in ingest() when enriched.
  var pendingActions = new Map();
  var pendingTimers = new Map();

  function requestInfo(pk) {
    sendToPage("fetchInfo", { pk: pk }); // page.js fetches; response re-enters via ingest
  }
  // One paced queue for all background enrichment (shortcode + date /info/
  // fetches): max 2 in flight, one slot freed every 700ms. User-initiated
  // downloads bypass it (addPending calls requestInfo directly).
  var fetchQueue = [];
  var fetchInFlight = 0;
  function drainFetchQueue() {
    while (fetchInFlight < 2 && fetchQueue.length) {
      var item = fetchQueue.shift();
      fetchInFlight++;
      if (item.pk) requestInfo(item.pk);
      else sendToPage("fetchShortcode", { code: item.code });
      setTimeout(function () {
        fetchInFlight = Math.max(0, fetchInFlight - 1);
        drainFetchQueue();
      }, 700);
    }
  }
  function enqueueFetch(item) {
    fetchQueue.push(item);
    drainFetchQueue();
  }
  function dateSortActive() {
    var sort = currentSort();
    return activeSurface.sortable && (sort.by === "reelDate" || sort.by === "postDate");
  }
  function queueDateInfo(rec) {
    if (!dateSortActive()) return;
    if (!rec || rec.takenAt != null || !rec.pk || activeStore.infoRequested.has(rec.pk) || activeStore.infoRequestCount >= 80) return;
    activeStore.infoRequested.add(rec.pk);
    activeStore.infoRequestCount++;
    enqueueFetch({ pk: rec.pk });
  }
  function maybeRequestDateInfo(rec, host) {
    if (!dateSortActive()) return;
    var r = host && host.getBoundingClientRect && host.getBoundingClientRect();
    if (r && (r.bottom < -200 || r.top > window.innerHeight + 800)) return;
    queueDateInfo(rec);
  }
  function addPending(pk, need, run) {
    var list = pendingActions.get(pk) || [];
    list.push({ need: need, run: run });
    pendingActions.set(pk, list);
    requestInfo(pk);
    // give up after 5s so a failed fetch doesn't leak
    if (pendingTimers.has(pk)) clearTimeout(pendingTimers.get(pk));
    pendingTimers.set(pk, setTimeout(function () { pendingActions.delete(pk); pendingTimers.delete(pk); }, 5000));
  }
  function runPending(pk) {
    var list = pendingActions.get(pk);
    if (!list) return;
    var rec = registry.get(pk); if (!rec) return;
    var remain = [];
    list.forEach(function (a) {
      if (a.need === "video") {
        var v = (rec.assets || []).filter(function (x) { return x.type === "video"; })[0];
        if (v) a.run(v); else remain.push(a);
      } else if (a.need === "caption") {
        if (rec.caption) a.run(rec.caption); else remain.push(a);
      }
    });
    if (remain.length) pendingActions.set(pk, remain);
    else { pendingActions.delete(pk); if (pendingTimers.has(pk)) { clearTimeout(pendingTimers.get(pk)); pendingTimers.delete(pk); } }
  }

  function originalAssetName(url, ext) {
    var name = "";
    try {
      name = decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
    } catch (e) {}
    name = safeFilePart(name, (ext === "mp4" ? "video" : "image") + "." + ext);
    if (!/\.[a-z0-9]{2,5}$/i.test(name)) name += "." + ext;
    return name;
  }
  function assetSequence(asset, rec) {
    var m = String(asset.label || "").match(/(\d+)/);
    var idx = m ? +m[1] : Math.max(1, (rec.assets || []).indexOf(asset) + 1);
    return ("0" + idx).slice(-2);
  }
  function mediaFileName(rec, asset, folder) {
    var ext = asset.type === "video" ? "mp4" : "jpg";
    var kind = asset.type === "video" ? "Video" : "Image";
    var prefix = [
      channelHandle(rec),
      rec.code || rec.pk || "Post",
      kind,
      assetSequence(asset, rec)
    ].map(function (part) { return safeFilePart(part, ""); }).filter(Boolean).join(" ");
    var name = safeFilePart(prefix + " " + originalAssetName(asset.url, ext), kind + "." + ext);
    return folder ? safeFilePart(folder, "Instagram") + "/" + name : name;
  }
  function bulkFolderName(rec) {
    return [
      channelHandle(rec),
      rec.code || rec.pk || "Post"
    ].map(function (part) { return safeFilePart(part, ""); }).filter(Boolean).join(" ");
  }
  function downloadAsset(rec, asset, folder) {
    if (!asset || !asset.url) return;
    var name = mediaFileName(rec, asset, folder);
    chrome.runtime.sendMessage({ type: "afw:download", url: asset.url, filename: name, saveAs: false, conflictAction: "uniquify" }, function (res) {
      if (chrome.runtime.lastError) log("download failed:", chrome.runtime.lastError.message);
    });
  }
  function downloadAssets(rec, assets, kind) {
    var folder = bulkFolderName(rec);
    (assets || []).forEach(function (asset, i) {
      setTimeout(function () { downloadAsset(rec, asset, folder); }, i * 150);
    });
  }
  function copyCaption(text) {
    if (!text) return;
    navigator.clipboard && navigator.clipboard.writeText(text).catch(function () {});
  }

  // Build the menu rows for a record from what we know now.
  function menuItems(rec) {
    var items = [];
    var assets = rec.assets || [];
    var images = assets.filter(function (a) { return a.type === "image"; });
    var videos = assets.filter(function (a) { return a.type === "video"; });
    if (images.length > 1) items.push({ kind: "images-all", label: "Download all images", assets: images, folderKind: "image" });
    if (videos.length > 1) items.push({ kind: "videos-all", label: "Download all videos", assets: videos, folderKind: "video" });
    assets.forEach(function (a) {
      items.push({ kind: a.type, label: (a.type === "video" ? "Download " : "Download ") + a.label.toLowerCase(), asset: a });
    });
    if (rec.kind === "video" && !(rec.assets || []).some(function (a) { return a.type === "video"; })) {
      items.push({ kind: "video-fetch", label: "Download video" });
    }
    items.push({ kind: rec.caption ? "caption" : "caption-fetch", label: "Copy caption" });
    return items;
  }

  var menuHost = null, menuRoot = null;
  function ensureMenu() {
    if (menuHost) return;
    menuHost = el("div");
    menuHost.id = "afw-menu-host";
    menuHost.style.cssText = "position:fixed;z-index:2147483001;display:none;";
    menuRoot = menuHost.attachShadow({ mode: "open" });
    document.body.appendChild(menuHost);
    document.addEventListener("click", function (e) {
      if (menuHost.style.display !== "none" && !menuHost.contains(e.target)) closeMenu();
    }, true);
    window.addEventListener("scroll", closeMenu, true);
  }
  function closeMenu() { if (menuHost) menuHost.style.display = "none"; }
  function openMenu(rec, anchor) {
    ensureMenu();
    var items = menuItems(rec);
    var rows = items.map(function (it, i) {
      var icon = it.kind.indexOf("video") === 0 ? ICONS.download : it.kind.indexOf("image") === 0 ? ICONS.download : ICONS.comment;
      return "<button class='mi' data-i='" + i + "'>" + svg(icon) + "<span>" + it.label + "</span></button>";
    }).join("");
    menuRoot.innerHTML =
      "<style>" +
      ":host{all:initial}*{box-sizing:border-box;font-family:'Geist',Inter,system-ui,-apple-system,sans-serif}" +
      ".m{min-width:180px;max-height:calc(100vh - 16px);overflow:auto;background:#1C1C1E;border:1px solid rgba(255,255,255,.10);border-radius:12px;box-shadow:0 10px 30px -10px rgba(0,0,0,.6);padding:4px}" +
      ".mi{display:flex;align-items:center;gap:9px;width:100%;height:34px;padding:0 10px;border:0;border-radius:8px;background:transparent;color:#F4F4F5;font:500 13px inherit;cursor:pointer;text-align:left}" +
      ".mi:hover{background:#26262A}.mi svg{width:14px;height:14px;stroke:#A6A6AD;fill:none;stroke-width:2;flex:none}" +
      ".ok{color:#BEF264}" +
      "</style><div class='m'>" + rows + "</div>";
    menuRoot.querySelectorAll(".mi").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        var it = items[+btn.dataset.i];
        if (it.kind === "images-all" || it.kind === "videos-all") { downloadAssets(rec, it.assets, it.folderKind); closeMenu(); }
        else if (it.kind === "image" || it.kind === "video") downloadAsset(rec, it.asset);
        else if (it.kind === "video-fetch") { var s = btn.querySelector("span"); s.textContent = "Fetching video…"; addPending(rec.pk, "video", function (v) { downloadAsset(rec, v); }); }
        else if (it.kind === "caption") { copyCaption(rec.caption); btn.querySelector("span").textContent = "Copied"; btn.classList.add("ok"); }
        else if (it.kind === "caption-fetch") { var s2 = btn.querySelector("span"); s2.textContent = "Fetching caption…"; addPending(rec.pk, "caption", function (t) { copyCaption(t); }); }
        if (it.kind === "image" || it.kind === "video") closeMenu();
      });
    });
    // position under the anchor, kept in the viewport
    var r = anchor.getBoundingClientRect();
    menuHost.style.display = "";
    var menu = menuRoot.querySelector(".m");
    var mw = menu.offsetWidth || 180;
    var mh = menu.offsetHeight || 0;
    var left = Math.min(r.right - mw, window.innerWidth - mw - 8);
    menuHost.style.left = Math.max(8, left) + "px";
    var top = r.bottom + 6;
    if (top + mh > window.innerHeight - 8) top = r.top - mh - 6;
    if (top < 8) top = Math.max(8, window.innerHeight - Math.min(mh, window.innerHeight - 16) - 8);
    menuHost.style.top = top + "px";
  }

  // ---- toolbar (shadow DOM) --------------------------------------------
  var toolbarHost = null, toolbarRoot = null;
  var toolbarRenderKey = "";
  var scrollTimer = null;
  var scrollSpeed = 7;

  function stopAutoScroll() {
    if (scrollTimer) {
      clearInterval(scrollTimer);
      scrollTimer = null;
      renderToolbar();
      updateLoadStatus();
    }
  }
  function startScroll() {
    if (scrollTimer) return;
    var stuck = 0, lastY = -1;
    scrollTimer = setInterval(function () {
      var doc = document.scrollingElement || document.documentElement;
      var atBottom = window.scrollY + window.innerHeight >= doc.scrollHeight - 2;
      if (atBottom || window.scrollY === lastY) stuck++;
      else stuck = 0;
      lastY = window.scrollY;
      if (stuck >= 50) { stopAutoScroll(); return; }
      window.scrollBy({ top: scrollSpeed, behavior: "auto" });
    }, 33);
    renderToolbar();
  }
  function toggleAutoScroll() {
    if (scrollTimer) { stopAutoScroll(); return; }
    startScroll();
  }

  // ---- load-to-target ---------------------------------------------------
  // When the user sets a load range (date period or lastN), auto-scroll until
  // the target is reached, then stop. "Loading" shows in the filter panel.
  var loadTarget = null; // { kind: "lastN"|"period", n?: number, fromSec?: number }
  function oldestTakenAt() {
    var oldest = null;
    activeStore.memberPks.forEach(function (pk) {
      var rec = registry.get(pk);
      if (rec && rec.takenAt != null && (oldest == null || rec.takenAt < oldest)) oldest = rec.takenAt;
    });
    return oldest;
  }
  function computeLoadTarget() {
    var f = currentFilters();
    if (f.lastN && f.lastN > 0) return { kind: "lastN", n: f.lastN };
    var from = periodFromSec(f);
    if (from) return { kind: "period", fromSec: from };
    return null;
  }
  function loadTargetMet() {
    if (!loadTarget) return true;
    if (loadTarget.kind === "lastN") return activeStore.memberPks.size >= loadTarget.n;
    var oldest = oldestTakenAt();
    // Reached when the oldest loaded post is at/older than the range start.
    // oldest == null means we have no dated records yet, so keep scrolling.
    return oldest != null && oldest <= loadTarget.fromSec;
  }
  function maybeStartLoadScroll() {
    loadTarget = computeLoadTarget();
    if (!loadTarget) { stopAutoScroll(); updateLoadStatus(); return; }
    if (loadTargetMet()) { stopAutoScroll(); updateLoadStatus(); return; }
    startScroll();
    updateLoadStatus();
  }
  function loadStatusText() {
    var loaded = activeStore.memberPks.size;
    if (!loadTarget) return "";
    if (loadTarget.kind === "lastN") return "Loading posts… " + Math.min(loaded, loadTarget.n) + " / " + loadTarget.n;
    return "Loading posts from the selected period… " + loaded + " loaded";
  }
  function updateLoadStatus() {
    if (!filterRoot) return;
    var row = filterRoot.querySelector("[data-asrow]");
    if (!row) return;
    var active = !!scrollTimer && !!loadTarget && !loadTargetMet();
    row.classList.toggle("show", active);
    var txt = filterRoot.querySelector("[data-astxt]");
    if (txt) txt.textContent = loadStatusText();
  }
  function sortedRecords(records) {
    var s = currentSort();
    var out = records.slice();
    if (filtersActive()) out = out.filter(recordPassesFilters);
    // lastN: keep only the N most recent by takenAt, independent of the chosen
    // sort. "Last 20 reels sorted by views" = the 20 most recent, ranked by views.
    var f = currentFilters();
    if (f.lastN && f.lastN > 0 && out.length > f.lastN) {
      var byDate = out.slice().sort(function (a, b) {
        var at = a.takenAt || 0, bt = b.takenAt || 0;
        return bt - at;
      });
      var keep = new Set();
      for (var i = 0; i < byDate.length && i < f.lastN; i++) keep.add(byDate[i].pk);
      out = out.filter(function (r) { return keep.has(r.pk); });
    }
    if (s.by !== "disabled") out.sort(function (a, b) { return compareRecords(a, b, s.by, s.dir); });
    return out;
  }
  function recordsForExport() {
    // Same order the sorted view shows: ranked snapshot + late arrivals at the end.
    return snapshotRecords(false);
  }
  function csvCell(v) {
    if (v == null) return "";
    var s = String(v);
    if (s.indexOf('"') !== -1) s = s.replace(/"/g, '""');
    return /[",\n\r]/.test(s) ? '"' + s + '"' : s;
  }
  function downloadCsv() {
    var records = recordsForExport();
    if (!records.length) return;
    var header = ["Channel", "Post ID", "Shortcode", "Type", "Posted at", "Views", "Likes", "Comments", "URL", "Caption"];
    var rows = [header].concat(records.map(function (rec) {
      return [
        channelHandle(rec),
        rec.pk,
        rec.code || "",
        rec.kind || "",
        dateIso(rec.takenAt),
        rec.plays == null ? "" : rec.plays,
        rec.likes == null ? "" : rec.likes,
        rec.comments == null ? "" : rec.comments,
        rec.url || (rec.code ? "https://www.instagram.com/reel/" + rec.code + "/" : ""),
        rec.caption || ""
      ];
    }));
    var csv = rows.map(function (row) { return row.map(csvCell).join(","); }).join("\n");
    var blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    var url = URL.createObjectURL(blob);
    var filename = safeFilePart(channelHandle(records[0]), "Instagram") + " " + ymd() + ".csv";
    chrome.runtime.sendMessage({ type: "afw:download", url: url, filename: filename }, function () {
      setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
      if (chrome.runtime.lastError) log("csv download failed:", chrome.runtime.lastError.message);
    });
  }

  function buildToolbar() {
    if (toolbarHost) return;
    toolbarHost = el("div");
    toolbarHost.id = "afw-toolbar-host";
    toolbarHost.style.cssText = "position:fixed;left:50%;top:4px;width:max-content;max-width:calc(100vw - 24px);transform:translateX(-50%);z-index:2147483000;";
    toolbarRoot = toolbarHost.attachShadow({ mode: "open" });
    document.body.appendChild(toolbarHost);
    chrome.storage.local.get("afwToolbarPos", function (res) {
      if (res.afwToolbarPos && toolbarHost) applyToolbarPos(res.afwToolbarPos.x, res.afwToolbarPos.y);
    });
    renderToolbar();
  }
  function applyToolbarPos(x, y) {
    if (!toolbarHost) return;
    toolbarHost.style.transform = "none";
    toolbarHost.style.left = x + "px";
    toolbarHost.style.top = y + "px";
  }
  function clampToolbarPos() {
    if (!toolbarHost) return;
    if (toolbarHost.style.transform === "none") {
      var rect = toolbarHost.getBoundingClientRect();
      var x = Math.max(4, Math.min(window.innerWidth - rect.width - 4, rect.left));
      var y = Math.max(4, Math.min(window.innerHeight - 40, rect.top));
      applyToolbarPos(x, y);
    }
  }
  var dragState = null;
  function onToolbarDragStart(e) {
    if (e.button !== 0 || !toolbarHost) return;
    closeFilterPanel();
    var rect = toolbarHost.getBoundingClientRect();
    dragState = { offX: e.clientX - rect.left, offY: e.clientY - rect.top, moved: false };
    document.addEventListener("mousemove", onToolbarDragMove);
    document.addEventListener("mouseup", onToolbarDragEnd);
  }
  function onToolbarDragMove(e) {
    if (!dragState) return;
    dragState.moved = true;
    var rect = toolbarHost.getBoundingClientRect();
    var x = e.clientX - dragState.offX;
    var y = e.clientY - dragState.offY;
    x = Math.max(4, Math.min(window.innerWidth - rect.width - 4, x));
    y = Math.max(4, Math.min(window.innerHeight - 40, y));
    toolbarHost.style.transform = "none";
    toolbarHost.style.left = x + "px";
    toolbarHost.style.top = y + "px";
  }
  function onToolbarDragEnd() {
    if (!dragState) return;
    if (dragState.moved && toolbarHost.style.transform === "none") {
      var rect = toolbarHost.getBoundingClientRect();
      chrome.storage.local.set({ afwToolbarPos: { x: rect.left, y: rect.top } });
    }
    dragState = null;
    document.removeEventListener("mousemove", onToolbarDragMove);
    document.removeEventListener("mouseup", onToolbarDragEnd);
  }
  // Everything that changes without a sort change (counts, sv open/closed,
  // scroll state, re-rank hint) is synced in place - the shadow DOM is only
  // rebuilt when the sort itself changes. The in-place sv sync is also what
  // lets the accordion animate instead of being re-created mid-transition.
  function syncToolbarState() {
    if (!toolbarRoot) return;
    var wrap = toolbarRoot.querySelector(".w");
    if (!wrap) return;
    var shown = activeStore.snapshotPks.length;
    var added = Math.max(0, shown - activeStore.rankedCount);
    var total = activeStore.memberPks.size;
    var countLabel = shown
      ? (filtersActive() && shown < total ? shown + " of " + total + " shown" : shown + " shown") + (added ? " · " + added + " added" : "")
      : (filtersActive() ? "0 of " + total : total) + " loaded";
    wrap.classList.toggle("sv-on", !!sv.open);
    wrap.classList.toggle("filters-on", filtersActive());
    var svBtn = toolbarRoot.querySelector("[data-a='sv']");
    if (svBtn) {
      svBtn.classList.toggle("on", !!sv.open);
      svBtn.title = sv.open ? "Close sorted view" : "Open sorted view";
    }
    var rerank = toolbarRoot.querySelector("[data-a='rerank']");
    if (rerank) {
      rerank.classList.toggle("on", added > 0);
      rerank.title = added ? "Re-rank " + added + " added posts" : "Re-rank loaded posts";
    }
    var scrollBtn = toolbarRoot.querySelector("[data-a='scroll']");
    if (scrollBtn) {
      scrollBtn.classList.toggle("on", !!scrollTimer);
      scrollBtn.title = scrollTimer ? "Stop scroll" : "Start scroll";
    }
    var filterBtn = toolbarRoot.querySelector("[data-a='filter']");
    if (filterBtn) {
      var n = activeFilterGroupCount();
      filterBtn.classList.toggle("on", n > 0);
      filterBtn.title = n ? n + " filter group" + (n > 1 ? "s" : "") + " active" : "Filter";
      var dot = filterBtn.querySelector(".fdot");
      if (n > 0 && !dot) filterBtn.appendChild(el("span", "fdot", String(n)));
      else if (n > 0 && dot) dot.textContent = String(n);
      else if (dot) dot.remove();
    }
    var cnt = toolbarRoot.querySelector(".cnt");
    if (cnt && cnt.textContent !== countLabel) cnt.textContent = countLabel;
  }

  function renderToolbar() {
    if (!toolbarRoot) return;
    var s = currentSort();
    var active = SORT_TO_TOOLBAR[s.by] || "";
    var fields = [["views", "Views"], ["likes", "Likes"], ["comments", "Comments"], ["recent", "Recent"]];
    var seg = fields.map(function (f) {
      return "<button data-f='" + f[0] + "' class='" + (f[0] === active ? "on" : "") + "'>" + f[1] + "</button>";
    }).join("");
    var dirIcon = s.dir === "desc" ? ICONS.sortDesc : ICONS.sortAsc;
    var dirLabel = s.dir === "desc" ? "Sort direction: descending" : "Sort direction: ascending";
    var key = [activeSurface.key, s.by, s.dir].join("|");
    if (toolbarRenderKey === key) {
      syncToolbarState();
      return;
    }
    toolbarRenderKey = key;
    toolbarRoot.innerHTML =
      "<style>" +
      ":host{all:initial}*{box-sizing:border-box;font-family:'Geist',Inter,system-ui,-apple-system,sans-serif}" +
      ".w{display:flex;align-items:center;justify-content:center;gap:8px;max-width:calc(100vw - 24px);padding:6px;background:#1C1C1E;border:1px solid rgba(255,255,255,.10);border-radius:12px;box-shadow:0 10px 30px -10px rgba(0,0,0,.6);flex-wrap:wrap}" +
      ".ib{width:28px;height:28px;border:0;border-radius:10px;background:transparent;display:flex;align-items:center;justify-content:center;cursor:pointer;flex:none}" +
      ".ib svg{width:14px;height:14px;stroke:#A6A6AD;fill:none;stroke-width:2}.ib:hover{background:#26262A}.ib:hover svg{stroke:#F4F4F5}.ib.on{background:#BEF264}.ib.on svg{stroke:#0A0A0B}" +
      ".seg{height:28px;display:inline-flex;align-items:center;gap:2px;padding:2px;border:1px solid rgba(255,255,255,.10);border-radius:12px}" +
      ".seg button{height:22px;padding:0 9px;border:0;border-radius:7px;background:transparent;color:#A6A6AD;font:600 11px inherit;cursor:pointer}" +
      ".seg button.on{background:#BEF264;color:#0A0A0B}" +
      ".speed{height:28px;display:inline-flex;align-items:center;gap:7px;padding:0 8px;border:1px solid rgba(255,255,255,.10);border-radius:12px;color:#A6A6AD;font:600 11px inherit;white-space:nowrap}" +
      ".speed input{width:74px;height:4px;accent-color:#BEF264;cursor:pointer}" +
      ".speed b{min-width:14px;color:#F4F4F5;font-variant-numeric:tabular-nums}" +
      ".div{width:1px;height:16px;background:rgba(255,255,255,.10);flex:none}" +
      ".cnt{font:400 11px inherit;color:#6E6E76;font-variant-numeric:tabular-nums;padding:0 6px 0 2px;white-space:nowrap}" +
      ".grip{width:14px;height:28px;display:flex;align-items:center;justify-content:center;cursor:grab;flex:none;opacity:.45}" +
      ".grip:hover{opacity:1}.grip:active{cursor:grabbing}.grip svg{width:10px;height:14px;fill:#6E6E76}" +
      ".ib{position:relative}" +
      ".fdot{position:absolute;top:-3px;right:-3px;min-width:14px;height:14px;padding:0 3px;border-radius:9999px;background:#BEF264;color:#0A0A0B;font:700 9px inherit;display:flex;align-items:center;justify-content:center;pointer-events:none}" +
      // Accordion: the sort controls only exist for the sorted view, so they
      // stay collapsed behind the grid toggle until it is switched on.
      ".acc{display:inline-flex;align-items:center;gap:8px;max-width:0;opacity:0;overflow:hidden;transition:max-width .28s ease,opacity .18s ease}" +
      ".w.sv-on .acc{max-width:560px;opacity:1}" +
      "@media(max-width:620px){.w{max-width:calc(100vw - 16px);gap:6px}.seg button{padding:0 7px}.speed{order:2;width:100%;justify-content:center}.cnt{display:none}.w.sv-on .acc{flex-wrap:wrap}}" +
      "</style>" +
      "<div class='w'>" +
      "<span class='grip' data-a='grip' title='Drag to move'><svg viewBox='0 0 24 24' fill='#6E6E76'>" + ICONS.grip + "</svg></span>" +
      "<button class='ib' data-a='sv'><svg viewBox='0 0 24 24'>" + ICONS.grid + "</svg></button>" +
      "<span class='acc'>" +
      "<button class='ib' data-a='rerank'><svg viewBox='0 0 24 24'><path d='M21 12a9 9 0 1 1-2.64-6.36'/><polyline points='21 3 21 9 15 9'/></svg></button>" +
      "<span class='seg'>" + seg + "</span>" +
      "<button class='ib' data-a='dir' title='" + dirLabel + "'><svg viewBox='0 0 24 24'>" + dirIcon + "</svg></button>" +
      "<button class='ib' data-a='filter' title='Filter'><svg viewBox='0 0 24 24'>" + ICONS.funnel + "</svg></button>" +
      "<span class='div'></span>" +
      "</span>" +
      "<label class='speed' title='Scroll speed'>Speed <input data-a='speed' type='range' min='2' max='30' step='1' value='" + scrollSpeed + "'><b>" + scrollSpeed + "</b></label>" +
      "<button class='ib' data-a='scroll'><svg viewBox='0 0 24 24'>" + svg(ICONS.scroll).replace(/^<svg[^>]*>|<\/svg>$/g, "") + "</svg></button>" +
      "<button class='ib' data-a='top' title='Back to top'><svg viewBox='0 0 24 24'>" + svg(ICONS.top).replace(/^<svg[^>]*>|<\/svg>$/g, "") + "</svg></button>" +
      "<button class='ib' data-a='csv' title='Download CSV'><svg viewBox='0 0 24 24'>" + svg(ICONS.csv).replace(/^<svg[^>]*>|<\/svg>$/g, "") + "</svg></button>" +
      "<span class='div'></span>" +
      "<span class='cnt'></span>" +
      "</div>";
    toolbarRoot.querySelectorAll(".seg button").forEach(function (b) {
      b.addEventListener("click", function () { setSort(TOOLBAR_TO_SORT[b.dataset.f], null); });
    });
    toolbarRoot.querySelector("[data-a='dir']").addEventListener("click", function () {
      setSort(null, currentSort().dir === "desc" ? "asc" : "desc");
    });
    toolbarRoot.querySelector("[data-a='sv']").addEventListener("click", function () {
      if (sv.open) {
        disableSortingView();
        renderToolbar();
      } else {
        sv.closedByUser = false;
        // The sorted view needs a metric to sort by. If the popup left sorting
        // "disabled", opening the view is the user's intent to sort - switch to
        // a default (which persists, so the popup updates too) and open.
        if (currentSort().by === "disabled") setSort(defaultSortForSurface(), null);
        else withDomWrites(renderData);
      }
    });
    toolbarRoot.querySelector("[data-a='rerank']").addEventListener("click", function () {
      snapshotRecords(true);
      withDomWrites(renderData);
    });
    toolbarRoot.querySelector("[data-a='scroll']").addEventListener("click", toggleAutoScroll);
    toolbarRoot.querySelector("[data-a='top']").addEventListener("click", function () { window.scrollTo({ top: 0, behavior: "smooth" }); });
    toolbarRoot.querySelector("[data-a='csv']").addEventListener("click", downloadCsv);
    var speed = toolbarRoot.querySelector("[data-a='speed']");
    speed.addEventListener("input", function () {
      scrollSpeed = +speed.value;
      var out = toolbarRoot.querySelector(".speed b");
      if (out) out.textContent = scrollSpeed;
    });
    var grip = toolbarRoot.querySelector("[data-a='grip']");
    if (grip) grip.addEventListener("mousedown", onToolbarDragStart);
    var filterBtn = toolbarRoot.querySelector("[data-a='filter']");
    if (filterBtn) filterBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      if (filterHost && filterHost.style.display !== "none") closeFilterPanel();
      else openFilterPanel(filterBtn);
    });
    syncToolbarState();
  }
  function showToolbar(on) {
    if (on) { buildToolbar(); toolbarHost.style.display = ""; }
    else {
      stopAutoScroll();
      if (toolbarHost) toolbarHost.style.display = "none";
      closeFilterPanel();
    }
  }

  // ---- filter popover (shadow DOM) -------------------------------------
  // Same shell pattern as the download menu: a fixed shadow-DOM host anchored
  // under the filter button. The panel rebuilds its values from the live
  // filters object on every open + on every setFilters while open.
  var filterHost = null, filterRoot = null, filterPollTimer = null;
  function ensureFilterPanel() {
    if (filterHost) return;
    filterHost = el("div");
    filterHost.id = "afw-filter-host";
    filterHost.style.cssText = "position:fixed;z-index:2147483002;display:none;";
    filterRoot = filterHost.attachShadow({ mode: "open" });
    document.body.appendChild(filterHost);
    document.addEventListener("click", function (e) {
      if (filterHost.style.display !== "none" && !filterHost.contains(e.target)) {
        var btn = toolbarRoot && toolbarRoot.querySelector("[data-a='filter']");
        if (!btn || !btn.contains(e.target)) closeFilterPanel();
      }
    }, true);
    window.addEventListener("scroll", closeFilterPanel, true);
    window.addEventListener("resize", closeFilterPanel, true);
  }
  function closeFilterPanel() {
    if (filterHost) {
      pollFilterInputs(); // one last sync before hiding
      filterHost.style.display = "none";
    }
    if (filterPollTimer) { clearInterval(filterPollTimer); filterPollTimer = null; }
  }
  function openFilterPanel(anchor) {
    ensureFilterPanel();
    renderFilterPanel();
    filterHost.style.display = "";
    // Attach directly below the toolbar at the same width, so it reads as the
    // toolbar extending downward. Min width keeps metric ranges comfortable.
    var tr = toolbarHost ? toolbarHost.getBoundingClientRect() : anchor.getBoundingClientRect();
    var pw = Math.max(420, tr.width);
    filterHost.style.left = tr.left + "px";
    filterHost.style.width = pw + "px";
    filterHost.style.top = (tr.bottom + 4) + "px";
    // Clamp right edge to viewport.
    if (tr.left + pw > window.innerWidth - 8) {
      filterHost.style.left = Math.max(8, window.innerWidth - pw - 8) + "px";
    }
    // Clamp bottom to viewport (scroll inside the panel handles the overflow).
    var ph = filterHost.offsetHeight;
    if (tr.bottom + 4 + ph > window.innerHeight - 8) {
      filterHost.style.top = Math.max(8, window.innerHeight - ph - 8) + "px";
    }
    updateLoadStatus();
    // Poll number inputs every 300ms as a safety-net for Chrome shadow-DOM
    // event bugs — silently picks up typed/spun values that the events miss.
    if (filterPollTimer) clearInterval(filterPollTimer);
    filterPollTimer = setInterval(pollFilterInputs, 300);
  }

  function escAttr(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/'/g, "&#39;").replace(/</g, "&lt;");
  }

  var PERIOD_OPTS = [
    ["all", "All"], ["7d", "7d"], ["30d", "30d"], ["90d", "90d"], ["ytd", "Year"], ["custom", "Custom"]
  ];
  var PAID_OPTS = [["any", "Any"], ["paid", "Paid"], ["unpaid", "Not paid"]];
  var LASTN_OPTS = [["0", "All"], ["25", "25"], ["50", "50"], ["100", "100"], ["500", "500"], ["-1", "Custom"]];

  // All values below match design-system.html tokens exactly.
  function filterCSS() {
    return "<style>" +
      ":host{all:initial}*{box-sizing:border-box;font-family:'Geist',Inter,system-ui,-apple-system,sans-serif}" +
      ".fp{width:100%;max-height:calc(100vh - 32px);overflow-y:auto;background:#1C1C1E;border:1px solid rgba(255,255,255,.10);border-radius:12px;box-shadow:0 10px 30px -10px rgba(0,0,0,.6)}" +
      // header
      ".fh{display:flex;align-items:center;justify-content:space-between;padding:10px 12px 8px}" +
      ".fh-label{font:600 11px inherit;letter-spacing:.05em;text-transform:uppercase;color:#6E6E76}" +
      // eyebrow section label (design-system .eyebrow)
      ".sl{font:600 11px inherit;letter-spacing:.05em;text-transform:uppercase;color:#6E6E76;margin-bottom:10px}" +
      // sections
      ".sec{padding:12px;border-top:1px solid rgba(255,255,255,.05)}" +
      ".sec:first-of-type{border-top:0}" +
      // metric range rows
      ".rr{display:flex;align-items:center;gap:6px;margin-bottom:8px}.rr:last-child{margin-bottom:0}" +
      ".rl{width:76px;flex:none;font:500 12px inherit;color:#A6A6AD}" +
      // input field (design-system .field, dense 28px for ranges)
      ".fi{width:0;flex:1;height:28px;padding:0 10px;border:1px solid rgba(255,255,255,.10);border-radius:12px;background:transparent;color:#F4F4F5;font:400 12px inherit;font-variant-numeric:tabular-nums}" +
      ".fi:focus{outline:none;border-color:#BEF264}" +
      ".fi::placeholder{color:#6E6E76}" +
      ".fdash{color:#6E6E76;flex:none;font:400 12px inherit}" +
      // segmented control (design-system .seg.dense)
      ".fseg{display:inline-flex;height:28px;border:1px solid rgba(255,255,255,.10);border-radius:12px;padding:2px;gap:2px}" +
      ".fseg button{height:22px;padding:0 11px;border:0;border-radius:7px;background:transparent;color:#A6A6AD;font:500 11px inherit;cursor:pointer;white-space:nowrap}" +
      ".fseg button:hover{background:rgba(255,255,255,.06);color:#F4F4F5}" +
      ".fseg button.on{background:#BEF264;color:#0A0A0B;font-weight:600}" +
      // custom date row
      ".cdate{display:flex;gap:6px;margin-top:8px}.cdate.hidden{display:none}" +
      ".cdate input{flex:1;height:28px;padding:0 8px;border:1px solid rgba(255,255,255,.10);border-radius:12px;background:transparent;color:#F4F4F5;font:400 11px inherit;font-variant-numeric:tabular-nums}" +
      ".cdate input:focus{outline:none;border-color:#BEF264}" +
      ".cdate input::-webkit-calendar-picker-indicator{filter:invert(.7)}" +
      // chip group
      ".cg-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}" +
      ".cg-actions{display:flex;gap:2px}" +
      // search field
      ".csearch{position:relative;margin-bottom:8px}" +
      ".csearch svg{position:absolute;left:9px;top:50%;transform:translateY(-50%);width:12px;height:12px;stroke:#6E6E76;fill:none;stroke-width:2;pointer-events:none}" +
      ".csearch input{width:100%;height:28px;padding:0 10px 0 28px;border:1px solid rgba(255,255,255,.10);border-radius:12px;background:transparent;color:#F4F4F5;font:400 11px inherit}" +
      ".csearch input:focus{outline:none;border-color:#BEF264}" +
      // chip list (design-system .chip)
      ".clist{display:flex;flex-wrap:wrap;gap:4px;max-height:108px;overflow-y:auto}" +
      ".chip{display:inline-flex;align-items:center;height:26px;padding:0 10px;border:1px solid rgba(255,255,255,.10);border-radius:9999px;background:#141415;color:#A6A6AD;font:500 11px inherit;cursor:pointer;white-space:nowrap}" +
      ".chip:hover{background:rgba(255,255,255,.06);color:#F4F4F5}" +
      ".chip.on{background:#BEF264;border-color:#BEF264;color:#0A0A0B;font-weight:600}" +
      ".empty{font:400 11px inherit;color:#6E6E76;padding:4px 0}" +
      // buttons (design-system .btn-secondary)
      ".btn2{display:inline-flex;align-items:center;justify-content:center;height:28px;padding:0 12px;border:1px solid rgba(255,255,255,.10);border-radius:12px;background:transparent;color:#F4F4F5;font:600 11px inherit;cursor:pointer}" +
      ".btn2:hover{background:rgba(255,255,255,.06)}" +
      ".btn2.lime{background:#BEF264;border-color:#BEF264;color:#0A0A0B}" +
      ".btn2.lime:hover{background:#CDF57E}" +
      ".btn2.ghost{border-color:transparent;color:#A6A6AD}" +
      ".btn2.ghost:hover{color:#F4F4F5;background:rgba(255,255,255,.06)}" +
      // hint footer
      ".hint{padding:8px 12px 10px;font:400 10.5px inherit;color:#6E6E76;line-height:1.4;border-top:1px solid rgba(255,255,255,.05)}" +
      // load-range 2-col grid
      ".grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}" +
      ".gcol{min-width:0}" +
      ".gcol .fseg{flex-wrap:wrap;height:auto}" +
      // auto-scroll status row
      ".asrow{display:none;align-items:center;gap:8px;margin-top:10px;padding:7px 10px;border:1px solid rgba(190,242,100,.30);border-radius:10px;background:rgba(190,242,100,.08)}" +
      ".asrow.show{display:flex}" +
      ".asrow .spin{width:12px;height:12px;flex:none}" +
      ".asrow .spin svg{width:12px;height:12px;stroke:#BEF264;animation:afwspin 1s linear infinite}" +
      "@keyframes afwspin{to{transform:rotate(360deg)}}" +
      ".asrow .astxt{flex:1;font:500 11px inherit;color:#F4F4F5;font-variant-numeric:tabular-nums}" +
      ".asrow .asstop{flex:none;height:22px;padding:0 9px;border:1px solid rgba(255,255,255,.10);border-radius:8px;background:transparent;color:#A6A6AD;font:600 10px inherit;cursor:pointer}" +
      ".asrow .asstop:hover{background:rgba(255,255,255,.06);color:#F4F4F5}" +
      "</style>";
  }

  function renderRangeRow(label, key, min, max) {
    return "<div class='rr'>" +
      "<span class='rl'>" + label + "</span>" +
      "<input class='fi' data-rk='" + key + "' data-rv='min' type='number' min='0' placeholder='min' value='" + (min != null ? min : "") + "'>" +
      "<span class='fdash'>–</span>" +
      "<input class='fi' data-rk='" + key + "' data-rv='max' type='number' min='0' placeholder='max' value='" + (max != null ? max : "") + "'>" +
      "</div>";
  }
  function renderSeg(name, opts, active) {
    return "<span class='fseg' data-fn='" + name + "'>" +
      opts.map(function (o) {
        return "<button data-v='" + o[0] + "' class='" + (o[0] === active ? "on" : "") + "'>" + o[1] + "</button>";
      }).join("") + "</span>";
  }

  function renderChipGroup(name, label, facets, selected) {
    var sel = selected || [];
    // Selected chips float to the top so the user sees what's active at a glance.
    var ordered = sel.slice().concat(facets.filter(function (v) { return sel.indexOf(v) === -1; }));
    var chips = ordered.map(function (v) {
      var on = sel.indexOf(v) !== -1;
      return "<button class='chip" + (on ? " on" : "") + "' data-fn='" + name + "' data-v='" + escAttr(v) + "'>" + escAttr(v) + "</button>";
    }).join("");
    var none = facets.length ? "" : "<span class='empty'>No " + label.toLowerCase() + " in loaded posts</span>";
    return "<div class='cg' data-fn='" + name + "'>" +
      "<div class='cg-head'>" +
      "<span class='sl' style='margin-bottom:0'>" + label + "</span>" +
      "<span class='cg-actions'>" +
      "<button class='btn2 ghost' data-act='all' data-fn='" + name + "'>Select all</button>" +
      "<button class='btn2 ghost' data-act='clear' data-fn='" + name + "'>Clear</button>" +
      "</span>" +
      "</div>" +
      "<div class='csearch'><svg viewBox='0 0 24 24'>" + ICONS.search + "</svg><input data-sf='" + name + "' type='text' placeholder='Search " + label.toLowerCase() + "' value=''></div>" +
      "<div class='clist' data-fn='" + name + "'>" + chips + none + "</div>" +
      "</div>";
  }

  function lastNMode() {
    var n = currentFilters().lastN;
    if (n == null) return "0";
    var s = String(n);
    for (var i = 0; i < LASTN_OPTS.length; i++) if (LASTN_OPTS[i][0] === s) return s;
    return "-1"; // custom
  }

  function renderFilterPanel() {
    if (!filterRoot) return;
    var f = currentFilters();
    var facets = computeFacets();
    var unit = (activeSurface.kind === "profile-reels" || activeSurface.kind === "reels-feed") ? "reels" : "posts";
    var lnMode = lastNMode();
    var showCustom = lnMode === "-1";
    filterRoot.innerHTML = filterCSS() +
      "<div class='fp'>" +
      "<div class='fh'><span class='fh-label'>Filters</span><button class='btn2 ghost' data-act='clearall'>Clear all</button></div>" +
      // LOAD RANGE: how many posts to pull in, then refine below.
      "<div class='sec'>" +
      "<div class='sl'>Load range</div>" +
      "<div class='grid2'>" +
      "<div class='gcol'>" +
      "<div class='sl' style='margin-bottom:6px'>Date / period</div>" +
      renderSeg("period", PERIOD_OPTS, f.period) +
      "<div class='cdate" + (f.period === "custom" ? "" : " hidden") + "'>" +
      "<input data-df='from' type='date' value='" + (f.periodFrom ? dateInputStr(f.periodFrom) : "") + "'>" +
      "<input data-df='to' type='date' value='" + (f.periodTo ? dateInputStr(f.periodTo) : "") + "'>" +
      "</div>" +
      "</div>" +
      "<div class='gcol'>" +
      "<div class='sl' style='margin-bottom:6px'>Last N " + unit + "</div>" +
      renderSeg("lastN", LASTN_OPTS, lnMode) +
      "<div class='cdate" + (showCustom ? "" : " hidden") + "'>" +
      "<input data-af='lastN' type='number' min='1' placeholder='e.g. 20' value='" + (showCustom && f.lastN != null ? f.lastN : "") + "'>" +
      "</div>" +
      "</div>" +
      "</div>" +
      // auto-scroll status
      "<div class='asrow' data-asrow>" +
      "<span class='spin'><svg viewBox='0 0 24 24' fill='none' stroke-linecap='round'><path d='M21 12a9 9 0 1 1-2.64-6.36'/></svg></span>" +
      "<span class='astxt' data-astxt>Loading posts…</span>" +
      "<button class='asstop' data-asstop>Stop</button>" +
      "</div>" +
      "</div>" +
      // REFINE: filter the loaded pool.
      "<div class='sec'>" +
      "<div class='sl'>Refine</div>" +
      renderRangeRow("Views", "Views", f.minViews, f.maxViews) +
      renderRangeRow("Likes", "Likes", f.minLikes, f.maxLikes) +
      renderRangeRow("Comments", "Comments", f.minComments, f.maxComments) +
      "<div style='margin-top:10px'><div class='sl' style='margin-bottom:6px'>Paid partnership</div>" +
      renderSeg("paid", PAID_OPTS, f.paid) +
      "</div>" +
      "</div>" +
      "<div class='sec'>" +
      renderChipGroup("collaborators", "Collaborators", facets.collaborators, f.collaborators) +
      "</div>" +
      "<div class='sec'>" +
      renderChipGroup("hashtags", "Hashtags", facets.hashtags, f.hashtags) +
      "</div>" +
      "<div class='sec'>" +
      renderChipGroup("tags", "Tagged accounts", facets.tags, f.tags) +
      "</div>" +
      "<div class='sec'>" +
      renderChipGroup("locations", "Locations", facets.locations, f.locations) +
      "</div>" +
      "<div class='hint'>Load range pulls posts in (auto-scrolls). Refine then filters that pool live. All groups must match; within a group, any selected value matches.</div>" +
      "</div>";
    wireFilterPanel(f);
  }

  function dateInputStr(sec) {
    if (!sec) return "";
    var d = new Date(sec * 1000);
    if (Number.isNaN(d.getTime())) return "";
    return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2);
  }
  function dateInputToSec(str) {
    if (!str) return null;
    var d = new Date(str + "T00:00:00");
    return Number.isNaN(d.getTime()) ? null : Math.floor(d.getTime() / 1000);
  }

  function cloneFilters() {
    var f = currentFilters();
    var out = {};
    for (var k in f) {
      if (Object.prototype.hasOwnProperty.call(f, k)) out[k] = Array.isArray(f[k]) ? f[k].slice() : f[k];
    }
    return out;
  }
  function toggleInArray(arr, val) {
    var i = arr.indexOf(val);
    if (i === -1) arr.push(val); else arr.splice(i, 1);
  }

  function syncChipGroup(name) {
    var selected = currentFilters()[name] || [];
    var group = filterRoot.querySelector(".cg[data-fn='" + name + "']");
    if (!group) return;
    var list = group.querySelector(".clist[data-fn='" + name + "']");
    if (!list) return;
    // Update on/off classes, then move selected chips to the top.
    var chips = [].slice.call(list.querySelectorAll(".chip"));
    var sel = [], unsel = [];
    chips.forEach(function (chip) {
      var on = selected.indexOf(chip.dataset.v) !== -1;
      chip.classList.toggle("on", on);
      (on ? sel : unsel).push(chip);
    });
    sel.concat(unsel).forEach(function (chip) { list.appendChild(chip); });
  }

  function wireFilterPanel(f) {
    // Number inputs inside shadow DOM are tricky: neither `input` nor `change`
    // fires reliably across Chrome versions.  Use all three events together:
    //   input  – fires on most keystrokes (debounced to avoid thrashing)
    //   change – fires on blur / spinner clicks
    //   keyup  – fires after each keystroke (backup for `input`)
    // Whichever fires first updates the filters; a 200ms debounce on the
    //高频 events keeps `setFilters` calls cheap.
    function applyNum(input, apply) {
      var timer = null;
      function flush() {
        if (timer) { clearTimeout(timer); timer = null; }
        var raw = input.value.trim();
        if (raw === "") { apply(null); return; }
        var num = parseInt(raw, 10);
        if (!Number.isFinite(num)) { input.value = ""; apply(null); return; }
        apply(num);
      }
      function debounced() {
        if (timer) clearTimeout(timer);
        timer = setTimeout(flush, 200);
      }
      input.addEventListener("input", debounced);
      input.addEventListener("keyup", debounced);
      input.addEventListener("change", flush);
      input.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); flush(); input.blur(); }
      });
    }
    filterRoot.querySelectorAll(".fi[data-rk]").forEach(function (input) {
      var key = input.dataset.rk, which = input.dataset.rv;
      applyNum(input, function (num) {
        var next = cloneFilters();
        var k = (which === "min" ? "min" : "max") + key;
        next[k] = num == null ? null : Math.max(0, num);
        setFilters(next);
      });
    });
    // Segmented controls (period, paid, lastN): toggle in-place, then apply.
    filterRoot.querySelectorAll(".fseg").forEach(function (seg) {
      var name = seg.dataset.fn;
      seg.querySelectorAll("button").forEach(function (b) {
        b.addEventListener("click", function () {
          var next = cloneFilters();
          if (name === "lastN") {
            // "0" = all (null), "-1" = custom (show input, don't set yet), else preset.
            if (b.dataset.v === "0") next.lastN = null;
            else if (b.dataset.v === "-1") { /* custom: show input, keep current lastN */ }
            else next.lastN = parseInt(b.dataset.v, 10);
          } else {
            next[name] = b.dataset.v;
          }
          seg.querySelectorAll("button").forEach(function (s) { s.classList.toggle("on", s === b); });
          // Toggle custom-date visibility when period changes.
          if (name === "period") {
            var cd = filterRoot.querySelector(".cdate");
            if (cd) cd.classList.toggle("hidden", b.dataset.v !== "custom");
          }
          // Toggle custom lastN input visibility.
          if (name === "lastN") {
            var cd2 = filterRoot.querySelectorAll(".cdate")[1];
            if (cd2) cd2.classList.toggle("hidden", b.dataset.v !== "-1");
            // If a preset was picked, apply immediately. If "custom", wait for input.
            if (b.dataset.v !== "-1") setFilters(next);
          } else {
            setFilters(next);
          }
        });
      });
    });
    // Custom date inputs
    filterRoot.querySelectorAll(".cdate input[data-df]").forEach(function (input) {
      input.addEventListener("change", function () {
        var next = cloneFilters();
        if (input.dataset.df === "from") next.periodFrom = dateInputToSec(input.value);
        else next.periodTo = dateInputToSec(input.value);
        setFilters(next);
      });
    });
    // Custom lastN input (inside the second .cdate container)
    var lastNInput = filterRoot.querySelector("[data-af='lastN']");
    if (lastNInput) applyNum(lastNInput, function (num) {
      var next = cloneFilters();
      next.lastN = num == null ? null : Math.max(1, num);
      setFilters(next);
    });
    // Clear all (full rebuild is fine - it's a click, not a focus-sensitive input)
    var clearAll = filterRoot.querySelector("[data-act='clearall']");
    if (clearAll) clearAll.addEventListener("click", clearFilters);
    // Stop auto-scroll
    var asStop = filterRoot.querySelector("[data-asstop]");
    if (asStop) asStop.addEventListener("click", function () { stopAutoScroll(); });
    // Chip groups: search, select-all, clear, individual toggles
    ["collaborators", "hashtags", "tags", "locations"].forEach(function (name) {
      var searchInput = filterRoot.querySelector("[data-sf='" + name + "']");
      if (searchInput) searchInput.addEventListener("input", function () {
        var q = searchInput.value.toLowerCase();
        var list = filterRoot.querySelector(".clist[data-fn='" + name + "']");
        if (!list) return;
        list.querySelectorAll(".chip").forEach(function (chip) {
          var match = !q || chip.textContent.toLowerCase().indexOf(q) !== -1;
          chip.style.display = match ? "" : "none";
        });
      });
      var group = filterRoot.querySelector(".cg[data-fn='" + name + "']");
      if (!group) return;
      group.querySelectorAll("button[data-act]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var facets = computeFacets()[name];
          var next = cloneFilters();
          if (btn.dataset.act === "all") {
            var q = (searchInput && searchInput.value || "").toLowerCase();
            next[name] = facets.filter(function (v) { return !q || v.indexOf(q) !== -1; });
          } else {
            next[name] = [];
          }
          setFilters(next);
          syncChipGroup(name);
        });
      });
      group.querySelectorAll(".chip").forEach(function (chip) {
        chip.addEventListener("click", function () {
          var v = chip.dataset.v;
          var next = cloneFilters();
          toggleInArray(next[name], v);
          setFilters(next);
          syncChipGroup(name); // re-applies on/off + floats selected to top
        });
      });
    });
  }

  function setSort(by, dir) {
    if (by) options.instagram.sortBy = by;
    if (dir) options.instagram.direction = dir;
    snapshotRecords(true);
    chrome.runtime.sendMessage({ type: "afw:options:set", options: options });
    toolbarRenderKey = "";
    withDomWrites(renderData); // instant overlay + toolbar; badges follow
    schedule("native");
  }

  // ---- facets (chip sources for the filter popover) --------------------
  // Unique collaborators / hashtags / tagged users / locations across the
  // route's loaded records, memoized by registry version so scrolling (which
  // bumps the version) refreshes the chip set.
  var facetCache = { version: -1, collaborators: [], hashtags: [], tags: [], locations: [] };
  function computeFacets() {
    if (facetCache.version === registryVersion) return facetCache;
    var collab = {}, tags = {}, hash = {}, loc = {};
    memberRecords().forEach(function (rec) {
      (rec.collaborators || []).forEach(function (u) { collab[String(u).toLowerCase()] = true; });
      (rec.taggedUsers || []).forEach(function (u) { tags[String(u).toLowerCase()] = true; });
      (rec.hashtags || []).forEach(function (h) { hash[String(h).toLowerCase()] = true; });
      if (rec.location) loc[String(rec.location).toLowerCase()] = true;
    });
    facetCache.collaborators = Object.keys(collab).sort();
    facetCache.tags = Object.keys(tags).sort();
    facetCache.hashtags = Object.keys(hash).sort();
    facetCache.locations = Object.keys(loc).sort();
    facetCache.version = registryVersion;
    return facetCache;
  }

  function setFilters(next, opts) {
    var prev = currentFilters();
    options.instagram.filters = next;
    bumpFilters();
    filtersBumpedLocally = true;
    snapshotRecords(true);
    chrome.runtime.sendMessage({ type: "afw:options:set", options: options });
    withDomWrites(renderData);
    syncToolbarState();
    // Kick the load-scroll only when the load-range filters actually changed.
    var loadRangeChanged = prev.period !== next.period || prev.periodFrom !== next.periodFrom
      || prev.periodTo !== next.periodTo || prev.lastN !== next.lastN;
    if (loadRangeChanged) maybeStartLoadScroll();
    else updateLoadStatus();
    schedule("native");
  }
  function clearFilters() {
    stopAutoScroll();
    setFilters(defaultFilters());
    if (filterRoot) renderFilterPanel();
  }

  function disableSortingView() {
    sv.closedByUser = true;
    setSort("disabled", null);
  }

  // ---- reel video controls ---------------------------------------------
  function attachVideoControls() {
    var vids = document.querySelectorAll("video");
    for (var i = 0; i < vids.length; i++) {
      var v = vids[i];
      if (v.__afwVC) {
        if (v.__afwVCBar && v.__afwVCBar.isConnected) continue;
        cleanupVideoControl(v);
      }
      var box = v.closest("div");
      var width = v.getBoundingClientRect().width || (box && box.getBoundingClientRect().width) || 0;
      if (!box || width < 200) continue; // skip tiny previews
      v.__afwVC = true;
      mountScrubber(v);
    }
  }
  function cleanupVideoControl(video) {
    if (video && video.__afwVCCleanup) video.__afwVCCleanup();
    if (video) {
      delete video.__afwVC;
      delete video.__afwVCBar;
      delete video.__afwVCCleanup;
    }
  }
  function clearVideoControls() {
    liveBars.slice().forEach(function (bar) {
      if (bar.__afwVideo) cleanupVideoControl(bar.__afwVideo);
      else bar.remove();
    });
    liveBars.length = 0;
    refreshControlOffsets();
  }
  function mountScrubber(video) {
    var container = video.parentElement;
    if (!container) return;
    if (getComputedStyle(container).position === "static") container.style.position = "relative";
    container.classList.add("afw-has-vc");
    var bar = el("div", "afw-vc");
    var playBtn = el("button", "afw-vc-play");
    var track = el("div", "afw-vc-track");
    var fill = el("div", "afw-vc-fill");
    track.appendChild(fill);
    var time = el("span", "afw-vc-time");
    bar.appendChild(playBtn); bar.appendChild(track); bar.appendChild(time);
    bar.__afwVideo = video;
    video.__afwVCBar = bar;
    container.appendChild(bar);
    liveBars.push(bar);
    updateBarInset(bar);

    function stop(e) { e.preventDefault(); e.stopPropagation(); if (e.stopImmediatePropagation) e.stopImmediatePropagation(); }
    function tfmt(t) { t = Math.max(0, t | 0); return Math.floor(t / 60) + ":" + ("0" + (t % 60)).slice(-2); }
    function icon() {
      var state = video.paused ? "play" : "pause";
      if (playBtn.dataset.state === state) return;
      playBtn.dataset.state = state;
      playBtn.innerHTML = video.paused
        ? "<svg viewBox='0 0 24 24'><polygon points='6 4 20 12 6 20 6 4'/></svg>"
        : "<svg viewBox='0 0 24 24'><rect x='6' y='4' width='4' height='16' rx='1'/><rect x='14' y='4' width='4' height='16' rx='1'/></svg>";
    }
    function upd() {
      var d = video.duration || 0, c = video.currentTime || 0;
      fill.style.width = (d ? (c / d) * 100 : 0) + "%";
      var label = tfmt(c) + " <span class='afw-tot'>/ " + tfmt(d) + "</span>";
      if (time.__afwLabel !== label) { time.__afwLabel = label; time.innerHTML = label; }
      icon();
    }
    function toggle(e) {
      stop(e);
      if (video.paused) {
        var p = video.play();
        if (p && p.catch) p.catch(function () {});
      } else {
        video.pause();
      }
    }
    function seek(e) {
      stop(e);
      var r = track.getBoundingClientRect();
      if (video.duration) video.currentTime = ((e.clientX - r.left) / r.width) * video.duration;
    }
    playBtn.addEventListener("click", toggle);
    track.addEventListener("click", seek);
    bar.addEventListener("click", stop);
    video.addEventListener("timeupdate", upd);
    video.addEventListener("play", icon);
    video.addEventListener("pause", icon);
    video.addEventListener("loadedmetadata", upd);
    video.addEventListener("durationchange", upd);
    video.addEventListener("seeked", upd);
    video.__afwVCCleanup = function () {
      playBtn.removeEventListener("click", toggle);
      track.removeEventListener("click", seek);
      bar.removeEventListener("click", stop);
      video.removeEventListener("timeupdate", upd);
      video.removeEventListener("play", icon);
      video.removeEventListener("pause", icon);
      video.removeEventListener("loadedmetadata", upd);
      video.removeEventListener("durationchange", upd);
      video.removeEventListener("seeked", upd);
      container.classList.remove("afw-has-vc");
      if (bar.parentNode) bar.parentNode.removeChild(bar);
      var idx = liveBars.indexOf(bar);
      if (idx !== -1) liveBars.splice(idx, 1);
      refreshControlOffsets();
    };
    upd();
    refreshControlOffsets();
  }

  // ---- render loop ------------------------------------------------------
  // Two passes with separate triggers. The NATIVE pass (badges, video
  // controls, profile cards, toolbar visibility) reacts to Instagram's DOM
  // churn. The DATA pass (sorted view, counts) reacts to records/sort/route
  // changes. IG mutates constantly, so keeping the data work out of the
  // mutation path is most of the perf win.
  function renderNative() {
    syncSurface();
    if (!igOn()) { destroySortedView(false); clearBadges(); clearVideoControls(); clearProfilePanel(); showToolbar(false); return; }
    renderProfilePanel();
    var tl = tileList();
    if (options.instagram.badges) {
      pruneBadges(tl.tiles);
      injectBadges(tl.tiles);
    } else clearBadges();
    showToolbar(!!options.instagram.toolbar && activeSurface.sortable && (tl.rows.length > 0 || sv.open || activeStore.memberPks.size > 0));
    if (toolbarRoot) renderToolbar();
    if (options.instagram.videoControls) attachVideoControls();
    else clearVideoControls();
    refreshControlOffsets();
  }
  function renderData() {
    syncSurface();
    if (!igOn()) { destroySortedView(false); return; }
    renderSortedView();
    if (toolbarRoot) renderToolbar();
  }
  var scheduled = false;
  var dirtyNative = false;
  var dirtyData = false;
  var hiddenPending = false;
  function schedule(kind) {
    if (!kind || kind === "both" || kind === "native") dirtyNative = true;
    if (!kind || kind === "both" || kind === "data") dirtyData = true;
    if (scheduled) return;
    scheduled = true;
    setTimeout(function () {
      scheduled = false;
      if (document.hidden) { hiddenPending = true; return; }
      var doNative = dirtyNative, doData = dirtyData;
      dirtyNative = dirtyData = false;
      try {
        withDomWrites(function () {
          if (doData) renderData();
          if (doNative) renderNative();
        });
      } catch (e) { log("render error", e); }
    }, 200);
  }

  // ---- wiring -----------------------------------------------------------
  // records from page.js (MAIN world)
  document.addEventListener("afw:page", function (e) {
    var msg; try { msg = JSON.parse(e.detail); } catch (x) { return; }
    if (msg.type === "records" && msg.data && msg.data.records) ingest(msg.data.records);
    if (msg.type === "profile" && msg.data && msg.data.profile) ingestProfile(msg.data.profile);
    if (msg.type === "nav") schedule("both");
  });

  // observe DOM churn (new rows on scroll, React re-renders wiping our badges)
  var mo = new MutationObserver(function (mutations) {
    if (writing || onlyAfwMutations(mutations)) return;
    schedule("native");
  });

  function boot() {
    if (window.AFW && window.AFW.injectStyles) window.AFW.injectStyles(document);
    mo.observe(document.body, { childList: true, subtree: true });
    // react to option/license changes made in the popup or another tab.
    // setFilters already bumps locally before the storage round-trip, so we
    // only bump here when the change came from elsewhere (popup/other tab).
    chrome.storage.onChanged.addListener(function (changes) {
      if (changes.options) {
        var prevFilters = options && options.instagram && options.instagram.filters;
        var nextFilters = changes.options.newValue && changes.options.newValue.instagram && changes.options.newValue.instagram.filters;
        options = changes.options.newValue;
        if (!filtersBumpedLocally && JSON.stringify(prevFilters || {}) !== JSON.stringify(nextFilters || {})) {
          bumpFilters();
        }
        filtersBumpedLocally = false;
      }
      if (changes.license) license = changes.license.newValue;
      schedule("both");
    });
    Promise.all([
      new Promise(function (r) { chrome.runtime.sendMessage({ type: "afw:options:get" }, r); }),
      new Promise(function (r) { chrome.runtime.sendMessage({ type: "afw:license:get" }, r); })
    ]).then(function (res) {
      options = res[0]; license = res[1] || { pro: false };
      log("engine ready. IG active:", igOn());
      loadCachedSurface(activeSurface); // warm the registry on first load
      schedule("both");
    });
    // SPA nav watch: page.js sends "nav" instantly; this poll is the fallback.
    var lastHref = location.href;
    setInterval(function () { if (location.href !== lastHref) { lastHref = location.href; schedule("both"); } }, 1000);
    window.addEventListener("resize", function () { refreshControlOffsets(); clampToolbarPos(); }, { passive: true });
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden && hiddenPending) { hiddenPending = false; schedule("both"); }
    });
    // Escape closes the filter popover first, then the sorted view, unless an
    // IG dialog is open above both.
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      if (document.querySelector('[role="dialog"]')) return;
      if (filterHost && filterHost.style.display !== "none") { closeFilterPanel(); return; }
      if (!sv.open) return;
      withDomWrites(function () { destroySortedView(true); });
      renderToolbar();
    });
  }

  if (document.body) boot();
  else document.addEventListener("DOMContentLoaded", boot);
})();

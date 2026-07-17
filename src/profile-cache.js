// AI Flywheel - persistent Instagram About metadata cache.
(function (root, factory) {
  var api = factory(root && root.indexedDB);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) {
    root.AFW = root.AFW || {};
    root.AFW.profileCache = api;
  }
})(typeof window !== "undefined" ? window : null, function (indexedDb) {
  "use strict";

  var DB_NAME = "afw-instagram-cache";
  var DB_VERSION = 1;
  var STORE_NAME = "about-profiles";
  var TTL_MS = 24 * 60 * 60 * 1000;
  var ABOUT_FIELDS = ["basedIn", "joinDate", "verifiedAbout", "formerUsernames"];
  var dbPromise = null;

  function normalizeUsername(value) {
    var username = String(value || "").trim().replace(/^@+/, "").trim();
    return username ? username.toLowerCase() : null;
  }

  function createRecord(username, profile, updatedAt) {
    var key = normalizeUsername(username);
    if (!key) return null;
    var record = {
      username: key,
      updatedAt: updatedAt == null ? Date.now() : Number(updatedAt)
    };
    profile = profile || {};
    ABOUT_FIELDS.forEach(function (field) {
      if (profile[field] != null && profile[field] !== "") record[field] = profile[field];
    });
    return record;
  }

  function mergeAbout(profile, cached) {
    if (!profile || !cached) return false;
    var changed = false;
    ABOUT_FIELDS.forEach(function (field) {
      if (cached[field] == null || cached[field] === "" || profile[field] === cached[field]) return;
      profile[field] = cached[field];
      changed = true;
    });
    return changed;
  }

  function isFresh(record, now) {
    if (!record || record.joinDate == null || String(record.joinDate).trim() === "") return false;
    var updatedAt = Number(record.updatedAt);
    var current = now == null ? Date.now() : Number(now);
    if (!Number.isFinite(updatedAt) || !Number.isFinite(current)) return false;
    var age = current - updatedAt;
    return age >= 0 && age < TTL_MS;
  }

  function openDatabase() {
    if (!indexedDb) return Promise.resolve(null);
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve) {
      var request;
      try {
        request = indexedDb.open(DB_NAME, DB_VERSION);
      } catch (e) {
        resolve(null);
        return;
      }
      request.onupgradeneeded = function () {
        var db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: "username" });
        }
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { resolve(null); };
      request.onblocked = function () { resolve(null); };
    });
    return dbPromise;
  }

  function get(username) {
    var key = normalizeUsername(username);
    if (!key) return Promise.resolve(null);
    return openDatabase().then(function (db) {
      if (!db) return null;
      return new Promise(function (resolve) {
        var request;
        try {
          request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(key);
        } catch (e) {
          resolve(null);
          return;
        }
        request.onsuccess = function () { resolve(request.result || null); };
        request.onerror = function () { resolve(null); };
      });
    }).catch(function () { return null; });
  }

  function put(username, profile, updatedAt) {
    var record = createRecord(username, profile, updatedAt);
    if (!record) return Promise.resolve(null);
    return openDatabase().then(function (db) {
      if (!db) return null;
      return new Promise(function (resolve) {
        var request;
        try {
          request = db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put(record);
        } catch (e) {
          resolve(null);
          return;
        }
        request.onsuccess = function () { resolve(record); };
        request.onerror = function () { resolve(null); };
      });
    }).catch(function () { return null; });
  }

  return {
    DB_NAME: DB_NAME,
    DB_VERSION: DB_VERSION,
    STORE_NAME: STORE_NAME,
    TTL_MS: TTL_MS,
    normalizeUsername: normalizeUsername,
    createRecord: createRecord,
    mergeAbout: mergeAbout,
    isFresh: isFresh,
    get: get,
    put: put
  };
});

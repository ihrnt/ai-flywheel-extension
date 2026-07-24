// AI Flywheel - persistent Instagram post-record cache (IndexedDB).
// Caches the engagement records for a surface so revisiting a profile within
// the TTL loads instantly instead of re-scrolling from scratch. Records are
// keyed by pk and stored per-surface; a 24h TTL keeps data reasonably fresh.
(function (root, factory) {
  var api = factory(root && root.indexedDB);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) {
    root.AFW = root.AFW || {};
    root.AFW.postCache = api;
  }
})(typeof window !== "undefined" ? window : null, function (indexedDb) {
  "use strict";

  var DB_NAME = "afw-instagram-post-cache";
  var DB_VERSION = 1;
  var STORE_NAME = "surfaces";
  var TTL_MS = 24 * 60 * 60 * 1000;
  var MAX_RECORDS = 1000; // cap per surface so the store stays bounded
  var dbPromise = null;

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
          db.createObjectStore(STORE_NAME, { keyPath: "surface" });
        }
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { resolve(null); };
      request.onblocked = function () { resolve(null); };
    });
    return dbPromise;
  }

  function isFresh(entry, now) {
    if (!entry) return false;
    var updatedAt = Number(entry.updatedAt);
    var current = now == null ? Date.now() : Number(now);
    if (!Number.isFinite(updatedAt) || !Number.isFinite(current)) return false;
    var age = current - updatedAt;
    return age >= 0 && age < TTL_MS;
  }

  // Records are plain objects; strip nothing but bound the array.
  function serialize(records) {
    return records.slice(0, MAX_RECORDS);
  }

  function get(surface) {
    if (!surface) return Promise.resolve(null);
    return openDatabase().then(function (db) {
      if (!db) return null;
      return new Promise(function (resolve) {
        var request;
        try {
          request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(surface);
        } catch (e) {
          resolve(null);
          return;
        }
        request.onsuccess = function () {
          var entry = request.result || null;
          resolve(isFresh(entry) ? entry : null);
        };
        request.onerror = function () { resolve(null); };
      });
    }).catch(function () { return null; });
  }

  function put(surface, records, updatedAt) {
    if (!surface || !Array.isArray(records) || !records.length) return Promise.resolve(null);
    var entry = {
      surface: surface,
      updatedAt: updatedAt == null ? Date.now() : Number(updatedAt),
      records: serialize(records)
    };
    return openDatabase().then(function (db) {
      if (!db) return null;
      return new Promise(function (resolve) {
        var request;
        try {
          request = db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put(entry);
        } catch (e) {
          resolve(null);
          return;
        }
        request.onsuccess = function () { resolve(entry); };
        request.onerror = function () { resolve(null); };
      });
    }).catch(function () { return null; });
  }

  return {
    DB_NAME: DB_NAME,
    DB_VERSION: DB_VERSION,
    STORE_NAME: STORE_NAME,
    TTL_MS: TTL_MS,
    MAX_RECORDS: MAX_RECORDS,
    isFresh: isFresh,
    get: get,
    put: put
  };
});

// AI Flywheel - background service worker.
// Owns: default options seed, options get/set, Stripe checkout, licensing, downloads.

const LICENSE_SERVICE_URL = "https://aiflywheel-extension.vercel.app";
const CHECKOUT_LINKS = {
  monthly: `${LICENSE_SERVICE_URL}/api/checkout?plan=monthly`,
  yearly: `${LICENSE_SERVICE_URL}/api/checkout?plan=yearly`,
  lifetime: `${LICENSE_SERVICE_URL}/api/checkout?plan=lifetime`
};
const CHECKOUT_PLANS = new Set(Object.keys(CHECKOUT_LINKS));
const LICENSE_RETRY_MS = 15 * 60 * 1000;
const OPTIONS_VERSION = 3;
const DOWNLOAD_INDEX_KEY = "afwCompletedDownloads";
const DOWNLOAD_PENDING_KEY = "afwPendingDownloads";
const pendingDownloadKeys = new Set();
const pendingDownloadIds = new Map();

function defaultFilters() {
  return {
    minViews: null,
    maxViews: null,
    minLikes: null,
    maxLikes: null,
    minComments: null,
    maxComments: null,
    paid: "any",
    period: "all",
    periodFrom: null,
    periodTo: null,
    lastN: null,
    collaborators: [],
    hashtags: [],
    tags: [],
    locations: []
  };
}

const DEFAULT_OPTIONS = {
  tiktok: {
    // sortBy: disabled | date | views | likes | comments | shares | bookmarks
    sortBy: "disabled",
    direction: "desc", // desc | asc
    creatorSort: true, // sort creators by followers on the search page
    badges: true,      // stat badges on posts (Pro)
    downloads: true,   // download buttons (Pro)
    toolbar: true      // floating sort toolbar
  },
  instagram: {
    // sortBy: disabled | likes | comments | reelDate | reelViews | postDate
    sortBy: "disabled",
    direction: "desc",
    badges: true,
    downloads: true,
    toolbar: true,
    videoControls: true,
    filters: defaultFilters()
  }
};

const DEFAULT_LICENSE = {
  pro: false,
  licensedTo: "",
  status: "inactive",
  token: "",
  isLifetime: false,
  validUntil: null,
  checkAfter: null,
  maxDevices: 0
};

async function ensureInstallationId() {
  const stored = await chrome.storage.local.get("installationId");
  if (stored.installationId) return stored.installationId;
  const installationId = crypto.randomUUID();
  await chrome.storage.local.set({ installationId });
  return installationId;
}

async function deviceName() {
  const platform = await chrome.runtime.getPlatformInfo();
  const names = { mac: "Mac", win: "Windows", linux: "Linux", cros: "ChromeOS", android: "Android" };
  return `Chrome on ${names[platform.os] || platform.os || "device"}`;
}

async function licenseRequest(path, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  let response;
  try {
    response = await fetch(`${LICENSE_SERVICE_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch {
    throw new Error("The license service is unavailable. Check your connection and try again.");
  } finally {
    clearTimeout(timeout);
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    return {
      ...result,
      ok: false,
      error: result.error === "no_subscription"
        ? "Lifetime access does not need billing management."
        : result.error || result.message || "The license request failed."
    };
  }
  return result;
}

async function saveLicense(license, { licenseKey = "", clearKey = false } = {}) {
  const stored = await chrome.storage.local.get(["licenseKey", "licenseResumeAfter"]);
  const cachedKey = clearKey ? "" : licenseKey || stored.licenseKey || "";
  const resumeAfter = clearKey || license?.pro ? null : stored.licenseResumeAfter || null;
  const next = license?.pro
    ? { ...DEFAULT_LICENSE, ...license, lastCheckedAt: new Date().toISOString() }
    : { ...DEFAULT_LICENSE, status: license?.status || "inactive" };
  await chrome.storage.local.set({ license: next, licenseKey: cachedKey, licenseResumeAfter: resumeAfter });
  return next;
}

function mergeOptions(options) {
  var ig = options && options.instagram ? options.instagram : {};
  var storedFilters = ig.filters || {};
  var mergedFilters = { ...defaultFilters() };
  for (var k in storedFilters) {
    if (Object.prototype.hasOwnProperty.call(storedFilters, k)) {
      mergedFilters[k] = Array.isArray(storedFilters[k]) ? storedFilters[k].slice() : storedFilters[k];
    }
  }
  return {
    tiktok: { ...DEFAULT_OPTIONS.tiktok, ...(options && options.tiktok ? options.tiktok : {}) },
    instagram: { ...DEFAULT_OPTIONS.instagram, ...ig, filters: mergedFilters },
  };
}

async function ensureOptions() {
  const stored = await chrome.storage.local.get(["options", "optionsVersion"]);
  if (!stored.options) {
    const options = mergeOptions(DEFAULT_OPTIONS);
    await chrome.storage.local.set({ options, optionsVersion: OPTIONS_VERSION });
    return options;
  }
  const options = mergeOptions(stored.options);
  // The previous defaults enabled sorting. Migrate only those legacy default
  // values, so an explicit non-default choice remains intact.
  if (stored.optionsVersion !== OPTIONS_VERSION) {
    if (options.tiktok.sortBy === "views") options.tiktok.sortBy = "disabled";
    if (options.instagram.sortBy === "reelViews") options.instagram.sortBy = "disabled";
  }
  if (stored.optionsVersion !== OPTIONS_VERSION || JSON.stringify(options) !== JSON.stringify(stored.options)) {
    await chrome.storage.local.set({ options, optionsVersion: OPTIONS_VERSION });
  }
  return options;
}

async function resumeCachedLicense() {
  const stored = await chrome.storage.local.get(["license", "licenseKey", "licenseResumeAfter"]);
  const retryAt = Date.parse(stored.licenseResumeAfter || "");
  if (Number.isFinite(retryAt) && retryAt > Date.now()) return null;
  const validStoredToken = stored.license?.pro && stored.license.token;
  const resumable = !stored.license
    || stored.license.status === "inactive"
    || (stored.license.pro && !stored.license.token);
  if (!stored.licenseKey || validStoredToken || !resumable) return null;
  try {
    const installationId = await ensureInstallationId();
    const result = await licenseRequest("/api/licenses/activate", {
      licenseKey: stored.licenseKey,
      installationId,
      deviceName: await deviceName()
    });
    if (!result.ok) {
      await chrome.storage.local.set({ licenseResumeAfter: new Date(Date.now() + LICENSE_RETRY_MS).toISOString() });
      return null;
    }
    return saveLicense(result.license, { licenseKey: stored.licenseKey });
  } catch {
    await chrome.storage.local.set({ licenseResumeAfter: new Date(Date.now() + LICENSE_RETRY_MS).toISOString() });
    return null;
  }
}

async function currentLicense() {
  const stored = await chrome.storage.local.get(["license", "licenseKey"]);
  const resumed = await resumeCachedLicense();
  if (resumed) return resumed;
  const { license } = stored;
  const current = { ...DEFAULT_LICENSE, ...(license || {}) };
  if (!current.pro) return current;
  // Remove licenses created by the retired local stub. Real Pro access always has a signed token.
  if (!current.token) return saveLicense(DEFAULT_LICENSE);
  const checkAfter = Date.parse(current.checkAfter || "");
  if (Number.isFinite(checkAfter) && checkAfter > Date.now()) return current;

  const installationId = await ensureInstallationId();
  try {
    const result = await licenseRequest("/api/licenses/refresh", {
      token: current.token,
      installationId
    });
    if (!result.ok) return saveLicense(result.license || DEFAULT_LICENSE);
    return saveLicense(result.license);
  } catch {
    // Keep the last valid entitlement during a short outage, then retry on a later check.
    const retry = { ...current, checkAfter: new Date(Date.now() + LICENSE_RETRY_MS).toISOString() };
    await chrome.storage.local.set({ license: retry });
    return retry;
  }
}

function downloadOptions(msg) {
  const options = { url: msg.url, filename: msg.filename };
  if (Object.prototype.hasOwnProperty.call(msg, "saveAs")) options.saveAs = !!msg.saveAs;
  if (msg.conflictAction) options.conflictAction = msg.conflictAction;
  return options;
}

async function storedMap(key) {
  const value = (await chrome.storage.local.get(key))[key];
  return value && typeof value === "object" ? { ...value } : {};
}

async function saveMap(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

async function completedDownloadExists(key, index) {
  const entry = index[key];
  if (!entry || !Number.isInteger(entry.id)) return false;
  try {
    const items = await chrome.downloads.search({ id: entry.id });
    const item = items && items[0];
    if (item && item.state === "complete" && item.exists !== false) return true;
  } catch {
    // Treat an unavailable history item as stale so the user can retry.
  }
  delete index[key];
  await saveMap(DOWNLOAD_INDEX_KEY, index);
  return false;
}

async function managedDownload(msg) {
  const key = String(msg.filename || "");
  if (!key) throw new Error("A download filename is required.");
  if (pendingDownloadKeys.has(key)) return { ok: true, status: "in-progress" };
  pendingDownloadKeys.add(key);
  try {
    const index = await storedMap(DOWNLOAD_INDEX_KEY);
    if (await completedDownloadExists(key, index)) {
      pendingDownloadKeys.delete(key);
      return { ok: true, status: "already-downloaded", id: index[key].id };
    }

    const id = await chrome.downloads.download(downloadOptions(msg));
    pendingDownloadIds.set(id, { key, url: msg.url, filename: msg.filename });
    const pending = await storedMap(DOWNLOAD_PENDING_KEY);
    // Completion can arrive while storage is being read. In that case the
    // onChanged handler already recorded the completed file, so do not revive
    // a stale pending entry.
    if (pendingDownloadIds.has(id)) {
      pending[String(id)] = { key, url: msg.url, filename: msg.filename, requestedAt: new Date().toISOString() };
      await saveMap(DOWNLOAD_PENDING_KEY, pending);
    }
    return { ok: true, status: "downloaded", id };
  } catch (error) {
    pendingDownloadKeys.delete(key);
    throw error;
  }
}

async function releasePendingDownload(id) {
  const pending = await storedMap(DOWNLOAD_PENDING_KEY);
  const entry = pendingDownloadIds.get(id) || pending[String(id)] || null;
  if (entry) {
    pendingDownloadKeys.delete(entry.key);
    delete pending[String(id)];
    await saveMap(DOWNLOAD_PENDING_KEY, pending);
  }
  pendingDownloadIds.delete(id);
  return entry;
}

async function recordDownloadChange(delta) {
  if (!delta || !delta.state) return;
  const state = delta.state.current;
  if (state === "complete") {
    const entry = await releasePendingDownload(delta.id);
    if (!entry) return;
    const items = await chrome.downloads.search({ id: delta.id });
    const item = items && items[0];
    const index = await storedMap(DOWNLOAD_INDEX_KEY);
    index[entry.key] = {
      id: delta.id,
      url: entry.url,
      filename: item && item.filename ? item.filename : entry.filename,
      completedAt: new Date().toISOString()
    };
    await saveMap(DOWNLOAD_INDEX_KEY, index);
    return;
  }
  if (state === "interrupted") await releasePendingDownload(delta.id);
}

chrome.downloads.onChanged.addListener((delta) => {
  recordDownloadChange(delta).catch(() => {});
});

chrome.runtime.onInstalled.addListener(async () => {
  await ensureOptions();
  const stored = await chrome.storage.local.get(["license", "licenseKey", "installationId"]);
  if (!stored.license) {
    const resumed = await resumeCachedLicense();
    if (!resumed) await chrome.storage.local.set({ license: DEFAULT_LICENSE });
  }
  if (!stored.installationId) await ensureInstallationId();
});

const handlers = {
  "afw:options:get": ensureOptions,
  "afw:options:set": async (msg) => {
    await chrome.storage.local.set({ options: msg.options, optionsVersion: OPTIONS_VERSION });
    return { ok: true };
  },
  "afw:license:get": currentLicense,
  "afw:checkout:open": async (msg) => {
    const plan = String(msg.plan || "").toLowerCase();
    if (!CHECKOUT_PLANS.has(plan)) return { ok: false, error: "Choose a valid plan." };
    await chrome.tabs.create({ url: CHECKOUT_LINKS[plan] });
    return { ok: true };
  },
  "afw:license:activate": async (msg) => {
    const key = (msg.key || "").trim();
    if (!key) return { ok: false, error: "Enter a license key." };
    const installationId = await ensureInstallationId();
    const body = {
      licenseKey: key,
      installationId,
      deviceName: await deviceName()
    };
    // Set when the buyer confirms moving the license here from a listed device.
    if (msg.replaceDeviceId) body.replaceDeviceId = msg.replaceDeviceId;
    const result = await licenseRequest("/api/licenses/activate", body);
    if (!result.ok) return result;
    const license = await saveLicense(result.license, { licenseKey: key });
    return { ok: true, license };
  },
  "afw:license:portal": async () => {
    const license = await currentLicense();
    if (!license.pro || !license.token) return { ok: false, error: "Activate your license first." };
    const result = await licenseRequest("/api/portal", {
      token: license.token,
      installationId: await ensureInstallationId()
    });
    if (!result.ok) return result;
    if (!result.url) return { ok: false, error: "Billing could not be opened." };
    await chrome.tabs.create({ url: result.url });
    return { ok: true };
  },
  "afw:license:deactivate": async () => {
    const { license } = await chrome.storage.local.get("license");
    if (!license?.token) return { ok: true, license: await saveLicense(DEFAULT_LICENSE, { clearKey: true }) };
    const result = await licenseRequest("/api/licenses/deactivate", {
      token: license.token,
      installationId: await ensureInstallationId()
    });
    if (!result.ok) return result;
    return { ok: true, license: await saveLicense(DEFAULT_LICENSE, { clearKey: true }) };
  },
  "afw:download": async (msg) => {
    if (msg.dedupe) return managedDownload(msg);
    const id = await chrome.downloads.download(downloadOptions(msg));
    return { ok: true, status: "downloaded", id };
  },
  "afw:ping": async (msg) => {
    return { ok: true, pong: true, echo: msg.echo ?? null, at: Date.now() };
  }
};

// Kept public for the Node service-worker tests; harmless in the extension worker.
globalThis.AFWBackground = { managedDownload, recordDownloadChange, completedDownloadExists };

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = handlers[msg && msg.type];
  if (!handler) return false;
  handler(msg, sender)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: String(err) }));
  return true; // async response
});

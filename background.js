// AI Flywheel - background service worker.
// Owns: default options seed, options get/set, Stripe checkout, licensing, downloads.

const LICENSE_SERVICE_URL = "https://aiflywheel-extension.vercel.app";
const CHECKOUT_LINKS = {
  monthly: "https://buy.stripe.com/6oU4gt7QW7iZ1Ja70F1VK00",
  yearly: "https://buy.stripe.com/dRmcMZefkbzfevW98N1VK01",
  lifetime: "https://buy.stripe.com/7sY3cpc7cgTz2Ne1Gl1VK02"
};
const CHECKOUT_PLANS = new Set(Object.keys(CHECKOUT_LINKS));
const LICENSE_RETRY_MS = 15 * 60 * 1000;

const DEFAULT_OPTIONS = {
  tiktok: {
    // sortBy: disabled | date | views | likes | comments | shares | bookmarks
    sortBy: "views",
    direction: "desc", // desc | asc
    creatorSort: true, // sort creators by followers on the search page
    badges: true,      // stat badges on posts (Pro)
    downloads: true,   // download buttons (Pro)
    toolbar: true      // floating sort toolbar
  },
  instagram: {
    // sortBy: disabled | likes | comments | reelDate | reelViews | postDate
    sortBy: "reelViews",
    direction: "desc",
    badges: true,
    downloads: true,
    toolbar: true,
    videoControls: true
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

async function saveLicense(license) {
  const next = license?.pro
    ? { ...DEFAULT_LICENSE, ...license, lastCheckedAt: new Date().toISOString() }
    : { ...DEFAULT_LICENSE, status: license?.status || "inactive" };
  await chrome.storage.local.set({ license: next });
  return next;
}

async function currentLicense() {
  const { license } = await chrome.storage.local.get("license");
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

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(["options", "license", "installationId"]);
  if (!stored.options) await chrome.storage.local.set({ options: DEFAULT_OPTIONS });
  if (!stored.license) await chrome.storage.local.set({ license: DEFAULT_LICENSE });
  if (!stored.installationId) await ensureInstallationId();
});

const handlers = {
  "afw:options:get": async () => {
    const { options } = await chrome.storage.local.get("options");
    return options || DEFAULT_OPTIONS;
  },
  "afw:options:set": async (msg) => {
    await chrome.storage.local.set({ options: msg.options });
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
    const license = await saveLicense(result.license);
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
    if (!license?.token) return { ok: true, license: await saveLicense(DEFAULT_LICENSE) };
    const result = await licenseRequest("/api/licenses/deactivate", {
      token: license.token,
      installationId: await ensureInstallationId()
    });
    if (!result.ok) return result;
    return { ok: true, license: await saveLicense(DEFAULT_LICENSE) };
  },
  "afw:download": async (msg) => {
    const options = {
      url: msg.url,
      filename: msg.filename
    };
    if (Object.prototype.hasOwnProperty.call(msg, "saveAs")) options.saveAs = !!msg.saveAs;
    if (msg.conflictAction) options.conflictAction = msg.conflictAction;
    const id = await chrome.downloads.download(options);
    return { ok: true, id };
  },
  "afw:ping": async (msg) => {
    return { ok: true, pong: true, echo: msg.echo ?? null, at: Date.now() };
  }
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = handlers[msg && msg.type];
  if (!handler) return false;
  handler(msg, sender)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: String(err) }));
  return true; // async response
});

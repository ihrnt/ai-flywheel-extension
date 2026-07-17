// AI Flywheel popup. Reads/writes options + license through the background
// message contract only (afw:*); no direct feature logic lives here.

const send = (msg) =>
  new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(res);
    });
  });

let options = null;

// field id -> [platform, key]
const FIELDS = {
  "tt-sortBy": ["tiktok", "sortBy"],
  "tt-creatorSort": ["tiktok", "creatorSort"],
  "tt-badges": ["tiktok", "badges"],
  "tt-downloads": ["tiktok", "downloads"],
  "tt-toolbar": ["tiktok", "toolbar"],
  "ig-sortBy": ["instagram", "sortBy"],
  "ig-badges": ["instagram", "badges"],
  "ig-downloads": ["instagram", "downloads"],
  "ig-toolbar": ["instagram", "toolbar"],
  "ig-videoControls": ["instagram", "videoControls"]
};

const $ = (id) => document.getElementById(id);

function renderOptions() {
  for (const [id, [platform, key]] of Object.entries(FIELDS)) {
    const el = $(id);
    if (el.type === "checkbox") el.checked = !!options[platform][key];
    else el.value = options[platform][key];
  }
  for (const platform of ["tiktok", "instagram"]) {
    const segId = platform === "tiktok" ? "tt-direction" : "ig-direction";
    document.querySelectorAll(`#${segId} button`).forEach((b) => {
      const on = b.dataset.v === options[platform].direction;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
    });
  }
}

function renderLicense(license) {
  const isPro = !!license?.pro;
  document.body.classList.toggle("pro", isPro);
  document.body.classList.toggle("free", !isPro);
  if (!isPro) return;
  $("licensed-to").textContent = `Licensed to ${license.licensedTo}`;
  $("license-access").textContent = license.isLifetime
    ? "Lifetime access"
    : license.validUntil
      ? `Active through ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(license.validUntil))}`
      : "Active subscription";
  $("manage-plan").hidden = !!license.isLifetime;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.options && changes.options.newValue) {
    options = changes.options.newValue;
    renderOptions();
  }
  if (changes.license && changes.license.newValue) {
    renderLicense(changes.license.newValue);
  }
});

async function saveOptions() {
  await send({ type: "afw:options:set", options });
}

async function init() {
  const version = chrome.runtime.getManifest().version;
  $("version").textContent = `v${version}`;
  $("footer-version").textContent = `AI Flywheel v${version}`;

  // Paint from local storage right away. Messaging the background instead would
  // cold-start the MV3 service worker on click, and afw:license:get can fire a
  // network refresh - both would leave the popup blank until they resolve. The
  // state already lives in chrome.storage.local, so render it now.
  const stored = await chrome.storage.local.get(["options", "license"]);
  options = stored.options || (await send({ type: "afw:options:get" }));
  renderOptions();
  renderLicense(stored.license || { pro: false });

  // Ask once more after the first paint so background migrations, including
  // the disabled sorting default, are reflected in the popup immediately.
  const normalizedOptions = await send({ type: "afw:options:get" }).catch(() => null);
  if (normalizedOptions) {
    options = normalizedOptions;
    renderOptions();
  }

  // Re-validate the license in the background. currentLicense() writes the
  // fresh entitlement to storage, and the storage.onChanged listener above
  // re-renders if it changed - so this never blocks the popup from opening.
  send({ type: "afw:license:get" }).catch(() => {});

  // options wiring
  for (const [id, [platform, key]] of Object.entries(FIELDS)) {
    $(id).addEventListener("change", (e) => {
      options[platform][key] = e.target.type === "checkbox" ? e.target.checked : e.target.value;
      saveOptions();
    });
  }
  for (const [segId, platform] of [["tt-direction", "tiktok"], ["ig-direction", "instagram"]]) {
    document.querySelectorAll(`#${segId} button`).forEach((b) => {
      b.addEventListener("click", () => {
        options[platform].direction = b.dataset.v;
        renderOptions();
        saveOptions();
      });
    });
  }

  document.querySelectorAll("[data-plan]").forEach((button) => {
    button.addEventListener("click", async () => {
      $("checkout-error").textContent = "";
      const res = await send({ type: "afw:checkout:open", plan: button.dataset.plan });
      if (!res?.ok) $("checkout-error").textContent = res?.error || "Checkout could not be opened.";
    });
  });

  // License activation is validated by the device-bound licensing service.
  // When every slot is taken, the service returns the active devices and the
  // buyer can move the license here (key possession is the credential).
  const deviceLimitBox = $("device-limit");
  function clearDeviceLimit() {
    deviceLimitBox.classList.remove("show");
    deviceLimitBox.textContent = "";
  }
  function lastSeenLabel(iso) {
    const date = new Date(iso || "");
    if (Number.isNaN(date.getTime())) return "";
    return `Last seen ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date)}`;
  }
  function renderDeviceLimit(devices) {
    clearDeviceLimit();
    if (!devices?.length) return;
    deviceLimitBox.classList.add("show");
    const title = document.createElement("p");
    title.className = "dl-title";
    title.textContent = "Move the license to this device instead:";
    deviceLimitBox.appendChild(title);
    for (const device of devices) {
      const row = document.createElement("div");
      row.className = "device-row";
      const name = document.createElement("span");
      name.className = "d-name";
      name.textContent = device.deviceName || "Unknown device";
      const seen = document.createElement("span");
      seen.className = "d-seen";
      seen.textContent = lastSeenLabel(device.lastSeenAt);
      name.appendChild(seen);
      const move = document.createElement("button");
      move.className = "btn-secondary";
      move.type = "button";
      move.textContent = "Move here";
      move.addEventListener("click", () => runActivation(device.deviceId, move));
      row.appendChild(name);
      row.appendChild(move);
      deviceLimitBox.appendChild(row);
    }
  }
  async function runActivation(replaceDeviceId, sourceButton) {
    $("license-error").textContent = "";
    const button = sourceButton || $("activate");
    const idleLabel = button.textContent;
    button.disabled = true;
    button.textContent = "Checking";
    try {
      const res = await send({
        type: "afw:license:activate",
        key: $("license-key").value,
        ...(replaceDeviceId ? { replaceDeviceId } : {}),
      });
      if (!res?.ok) {
        if (res?.code === "device_limit" && Array.isArray(res.devices)) {
          renderDeviceLimit(res.devices);
        } else {
          clearDeviceLimit();
        }
        $("license-error").textContent = res?.error || "Activation failed.";
        return;
      }
      clearDeviceLimit();
      $("license-key").value = "";
      renderLicense(res.license);
    } finally {
      button.disabled = false;
      button.textContent = idleLabel;
    }
  }
  $("activate").addEventListener("click", () => runActivation());
  $("license-key").addEventListener("keydown", (event) => {
    if (event.key === "Enter") $("activate").click();
  });

  $("manage-plan").addEventListener("click", async () => {
    $("manage-error").textContent = "";
    const res = await send({ type: "afw:license:portal" });
    if (!res?.ok) $("manage-error").textContent = res?.error || "Billing could not be opened.";
  });

  let deactivateArmed = false;
  let deactivateTimer = null;
  $("deactivate-device").addEventListener("click", async () => {
    const button = $("deactivate-device");
    if (!deactivateArmed) {
      deactivateArmed = true;
      button.textContent = "Click again to confirm";
      clearTimeout(deactivateTimer);
      deactivateTimer = setTimeout(() => {
        deactivateArmed = false;
        button.textContent = "Deactivate device";
      }, 4000);
      return;
    }
    clearTimeout(deactivateTimer);
    $("manage-error").textContent = "";
    const res = await send({ type: "afw:license:deactivate" });
    if (!res?.ok) {
      $("manage-error").textContent = res?.error || "This device could not be deactivated.";
      deactivateArmed = false;
      button.textContent = "Deactivate device";
      return;
    }
    renderLicense(res.license);
  });
}

init();

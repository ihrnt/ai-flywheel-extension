// AI Flywheel - MAIN-world script (document_start).
// Runs in the page's own JS context on tiktok.com / instagram.com.
// Owns the window.fetch patch; capture engines (tiktok-engine, instagram-engine
// phases) subscribe to responses here. Talks to src/content.js via CustomEvents
// on document, with JSON-string details (Chrome passes these across worlds).

(() => {
  if (window.__afwPageLoaded) return;
  window.__afwPageLoaded = true;

  const send = (type, data) => {
    document.dispatchEvent(
      new CustomEvent("afw:page", { detail: JSON.stringify({ type, data }) })
    );
  };

  const isInstagram = location.hostname.indexOf("instagram.com") !== -1;
  const ABOUT_APP = "com.bloks.www.ig.about_this_account";

  // Feed matched Instagram responses to content.js as flat records.
  function handleBody(url, body) {
    const schema = (window.AFW && window.AFW.schema) || null; // lazy lookup
    if (!schema || !isInstagram) return;
    if (url.indexOf(ABOUT_APP) !== -1) handleAboutBody(body);
    let json;
    try {
      json = JSON.parse(body);
    } catch {
      return; // not JSON
    }
    const profile = schema.parseProfile && schema.parseProfile(json);
    if (profile) {
      profile.profileLoaded = true;
      send("profile", { platform: "instagram", profile });
    }
    const parsed = schema.parseResponse(json) || schema.parseInfo(json);
    if (parsed && parsed.records.length) {
      send("records", {
        platform: "instagram",
        surface: parsed.surface,
        records: parsed.records,
        endCursor: parsed.endCursor
      });
    }
  }

  function textKey(obj) {
    if (!obj || typeof obj !== "object") return null;
    if (Object.prototype.hasOwnProperty.call(obj, "bk.components.Text")) return "bk.components.Text";
    if (Object.prototype.hasOwnProperty.call(obj, "bk.components.TextSpan")) return "bk.components.TextSpan";
    return null;
  }

  function collectTextRows(value, rows) {
    rows = rows || [];
    if (!value || typeof value !== "object") return rows;
    if (Array.isArray(value)) {
      for (const item of value) {
        const key = textKey(item);
        if (key && item[key] && typeof item[key].text === "string" && item[key].text.trim()) {
          const row = [];
          for (const part of value) {
            const partKey = textKey(part);
            if (partKey && part[partKey]) row.push(part[partKey]);
          }
          if (row.length) rows.push(row);
          return rows;
        }
        collectTextRows(item, rows);
      }
      return rows;
    }
    for (const key in value) {
      if (Object.prototype.hasOwnProperty.call(value, key)) collectTextRows(value[key], rows);
    }
    return rows;
  }

  function rowTexts(row) {
    return row
      .map((part) => (part && typeof part.text === "string" ? part.text.trim() : ""))
      .filter(Boolean);
  }

  // Real values in the About dialog are short ("November 2011", "United
  // States", "1"). Anything sentence-length is an explainer paragraph ("The
  // verified badge means..."), never a value.
  function aboutValue(text) {
    if (!text) return null;
    if (text.length > 48) return null;
    if (/^(see why this information is important\.?|learn more\.?|about this account|close)$/i.test(text)) return null;
    return text;
  }
  function nextRowText(rows, idx) {
    for (let i = idx + 1; i < Math.min(rows.length, idx + 3); i++) {
      const texts = rowTexts(rows[i]);
      for (const text of texts) {
        if (aboutValue(text)) return text;
      }
    }
    return null;
  }

  function valueAfterLabel(rows, idx, labelRe) {
    const texts = rowTexts(rows[idx]);
    const labelIdx = texts.findIndex((text) => labelRe.test(text));
    for (let i = labelIdx + 1; i < texts.length; i++) {
      if (texts[i] && !labelRe.test(texts[i]) && !/see why this information is important/i.test(texts[i])) {
        return texts[i];
      }
    }
    return nextRowText(rows, idx);
  }

  function currentProfileUsername() {
    const m = location.pathname.match(/^\/([^/?#]+)/);
    if (!m) return null;
    let part = m[1];
    try {
      part = decodeURIComponent(part);
    } catch {
      return null;
    }
    return /^(p|reel|reels|tv|explore|search|accounts|direct|stories)$/.test(part) ? null : part;
  }

  function handleAboutBody(body) {
    const start = String(body || "").indexOf("{");
    if (start < 0) return;
    let json;
    try {
      json = JSON.parse(String(body).slice(start));
    } catch {
      return;
    }
    const rows = collectTextRows(json);
    if (!rows.length) return;
    const about = {
      username: currentProfileUsername(),
      aboutLoaded: true
    };
    // "Account based in" is not a text row - the country lives in a data node
    // keyed IG_ABOUT_THIS_ACCOUNT:about_this_account_country with an "initial"
    // value. Read it there; the dialog shows "Not shared" when it is absent.
    const countryMatch = String(body).match(
      /IG_ABOUT_THIS_ACCOUNT:about_this_account_country"[^}]*?"initial":"([^"]*)"/
    );
    about.basedIn = countryMatch && countryMatch[1] ? countryMatch[1] : "Not shared";
    // Each field is a row whose FIRST cell is exactly the label; the value is
    // the next cell (same row) or, when the label stands alone, the next row's
    // first cell. Labels match exactly and candidates run through aboutValue()
    // so the explanatory paragraphs never get mistaken for a value.
    const valueFor = (i, cells) => {
      for (let c = 1; c < cells.length; c++) {
        const value = aboutValue(cells[c]);
        if (value) return value;
      }
      return nextRowText(rows, i);
    };
    for (let i = 0; i < rows.length; i++) {
      const cells = rowTexts(rows[i]);
      const label = (cells[0] || "").trim().toLowerCase();
      if (label === "date joined") about.joinDate = valueFor(i, cells);
      else if (label === "verified") about.verifiedAbout = valueFor(i, cells);
      else if (label === "former usernames") about.formerUsernames = valueFor(i, cells);
    }
    if (about.username) send("profile", { platform: "instagram", profile: about });
  }

  // --- fetch patch -------------------------------------------------------
  // URLs whose JSON we read: feed/profile payloads plus the exact Bloks app
  // used by "About this account". Unrelated /async/wbloks/ responses are not
  // cloned or parsed.
  function watched(url) {
    return url.indexOf("/graphql") !== -1
      || url.indexOf("/api/v1/") !== -1
      || url.indexOf(ABOUT_APP) !== -1;
  }

  function forceAboutEnglish(args, url) {
    if (url.indexOf(ABOUT_APP) === -1) return;
    const request = args[0];
    const init = args[1] || {};
    const method = String(init.method || (request && request.method) || "GET").toUpperCase();
    const body = init.body;
    if (method !== "POST" || !body || typeof body.get !== "function" || typeof body.set !== "function") return;
    try {
      body.set("hl", "en");
    } catch {
      // Never let locale forcing break Instagram's request.
    }
  }

  const nativeFetch = window.fetch;
  window.fetch = async function (...args) {
    const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
    forceAboutEnglish(args, url);
    const response = await nativeFetch.apply(this, args);
    try {
      if (watched(url)) {
        response
          .clone()
          .text()
          .then((body) => handleBody(url, body))
          .catch(() => {});
      }
    } catch {
      // Never let observation break the page's own request.
    }
    return response;
  };

  // Instagram also uses XHR for some feed pages; patch it too.
  const NativeXHR = window.XMLHttpRequest;
  if (NativeXHR) {
    const open = NativeXHR.prototype.open;
    const sendXhr = NativeXHR.prototype.send;
    NativeXHR.prototype.open = function (method, url) {
      this.__afwUrl = url;
      return open.apply(this, arguments);
    };
    NativeXHR.prototype.send = function () {
      this.addEventListener("load", () => {
        try {
          const url = this.__afwUrl || "";
          if (watched(url)) {
            handleBody(url, this.responseText);
          }
        } catch {
          // ignore
        }
      });
      return sendXhr.apply(this, arguments);
    };
  }

  // SPA navigations: tell the isolated world the instant the route changes so
  // it does not have to rely on its 1s href poll.
  let activeAboutCapture = null;
  function cancelActiveAboutCapture() {
    if (activeAboutCapture && normHandle(currentProfileUsername()) !== activeAboutCapture.key) {
      activeAboutCapture.cleanup();
    }
  }
  const nativePush = history.pushState;
  const nativeReplace = history.replaceState;
  history.pushState = function () {
    const result = nativePush.apply(this, arguments);
    cancelActiveAboutCapture();
    send("nav", { href: location.href });
    return result;
  };
  history.replaceState = function () {
    const result = nativeReplace.apply(this, arguments);
    cancelActiveAboutCapture();
    send("nav", { href: location.href });
    return result;
  };
  window.addEventListener("popstate", () => {
    cancelActiveAboutCapture();
    send("nav", { href: location.href });
  });

  // Instagram web app id, needed to call the private /info/ endpoint. Read from
  // the page's script tags lazily (the DOM is not ready at document_start; and
  // serializing documentElement.innerHTML costs multiple MB on IG). Fall back
  // to the long-standing web app id.
  let appId = null;
  function getAppId() {
    if (appId) return appId;
    const scripts = document.querySelectorAll("script");
    for (let i = 0; i < scripts.length && !appId; i++) {
      const text = scripts[i].textContent;
      if (!text || text.indexOf("X-IG-App-ID") === -1) continue;
      const m = text.match(/"X-IG-App-ID"\s*:\s*"(\d+)"/);
      if (m) appId = m[1];
    }
    appId = appId || "936619743392459";
    return appId;
  }

  // --- about-this-account auto-open --------------------------------------
  // Match the working extension's direct profile-username flow. The username
  // opens the About dialog directly, while the entire dialog portal (including
  // its backdrop) stays off-screen. Every transition uses animation frames, so
  // a background tab cannot let an independent timer reveal a half-finished
  // dialog.
  const aboutFlow = new Map(); // handle -> { attempts, running, done }
  const ABOUT_TRIGGER = 'header a[href="#"] h2';
  const ABOUT_BUTTONS = 'body [role="dialog"] button';
  const ABOUT_TIMEOUT_MS = 5000;
  function normHandle(v) {
    const s = String(v || "").trim().replace(/^@+/, "").trim();
    return s ? s.toLowerCase() : null;
  }
  function triggerAboutAccount(username) {
    const key = normHandle(username);
    if (!key) return;
    const flow = aboutFlow.get(key) || { attempts: 0, running: false, done: false };
    aboutFlow.set(key, flow);
    if (flow.done || flow.running || flow.attempts >= 1) return;
    if (normHandle(currentProfileUsername()) !== key) return;
    flow.running = true;

    const hide = document.createElement("style");
    hide.setAttribute("data-afw-about", "1");
    hide.textContent = 'body>div:has([role="dialog"]){opacity:0;position:fixed;left:100%;pointer-events:none;}';

    let raf = 0;
    let phase = "prime";
    let phaseFrames = 0;
    let startedAt = 0;
    let attempted = false;
    let finished = false;
    let visibilityHandler = null;

    function finish() {
      if (finished) return;
      finished = true;
      if (raf) cancelAnimationFrame(raf);
      if (visibilityHandler) document.removeEventListener("visibilitychange", visibilityHandler);
      if (hide.parentNode) hide.remove();
      if (activeAboutCapture && activeAboutCapture.cleanup === finish) activeAboutCapture = null;
      flow.running = false;
      if (attempted) flow.done = true;
    }

    function tick(now) {
      if (finished) return;
      if (normHandle(currentProfileUsername()) !== key) return finish();

      if (phase === "prime") {
        phase = "click";
      } else if (phase === "click") {
        const trigger = document.querySelector(ABOUT_TRIGGER);
        if (!trigger || !document.body) {
          flow.done = true;
          return finish();
        }
        document.body.appendChild(hide);
        attempted = true;
        flow.attempts++;
        startedAt = now;
        try {
          trigger.click();
        } catch {
          return finish();
        }
        phase = "dialog";
        phaseFrames = 0;
      } else if (phase === "dialog") {
        const buttons = document.querySelectorAll(ABOUT_BUTTONS);
        if (!buttons.length) {
          phaseFrames = 0;
          if (now - startedAt >= ABOUT_TIMEOUT_MS) return finish();
        } else {
          phaseFrames++;
          if (phaseFrames >= 4) {
            try {
              buttons[buttons.length - 1].click();
            } catch {
              return finish();
            }
            phase = "cleanup";
            phaseFrames = 0;
          }
        }
      } else if (phase === "cleanup") {
        phaseFrames++;
        if (phaseFrames >= 3) return finish();
      }

      raf = requestAnimationFrame(tick);
    }

    function start() {
      if (finished) return;
      if (normHandle(currentProfileUsername()) !== key) return finish();
      if (!document.querySelector(ABOUT_TRIGGER)) {
        flow.done = true;
        return finish();
      }
      raf = requestAnimationFrame(tick);
    }

    activeAboutCapture = { key, cleanup: finish };
    if (document.hidden) {
      visibilityHandler = function () {
        if (document.hidden) return;
        document.removeEventListener("visibilitychange", visibilityHandler);
        visibilityHandler = null;
        start();
      };
      document.addEventListener("visibilitychange", visibilityHandler);
    } else {
      start();
    }
  }

  // --- messaging skeleton -------------------------------------------------
  document.addEventListener("afw:content", (e) => {
    let msg;
    try {
      msg = JSON.parse(e.detail);
    } catch {
      return;
    }
    if (msg.type === "ping") {
      send("pong", { echo: msg.data ?? null, world: "MAIN", href: location.href });
    }
    if (msg.type === "fetchInfo" && msg.data && msg.data.pk) {
      // Fetch single-media detail. The response flows back through the patched
      // fetch above -> parseInfo -> records, enriching the registry with the
      // video url + caption the grid payload lacked. No extra plumbing needed.
      nativeFetch("https://www.instagram.com/api/v1/media/" + msg.data.pk + "/info/", {
        headers: { "x-ig-app-id": getAppId() },
        credentials: "include"
      })
        .then((r) => r.text())
        .then((body) => handleBody("/api/v1/media/info/", body))
        .catch(() => {});
    }
    if (msg.type === "fetchShortcode" && msg.data && msg.data.code) {
      const schema = window.AFW && window.AFW.schema;
      const pk = schema && schema.shortcodeToMediaId(msg.data.code);
      if (!pk) return;
      nativeFetch("https://www.instagram.com/api/v1/media/" + pk + "/info/", {
        headers: { "x-ig-app-id": getAppId() },
        credentials: "include"
      })
        .then((r) => r.text())
        .then((body) => handleBody("/api/v1/media/shortcode/info/", body))
        .catch(() => {});
    }
    if (msg.type === "fetchProfile" && msg.data && msg.data.username) {
      const username = String(msg.data.username).replace(/^@+/, "").trim();
      nativeFetch("https://www.instagram.com/api/v1/users/web_profile_info/?username=" + encodeURIComponent(username), {
        headers: { "x-ig-app-id": getAppId() },
        credentials: "include"
      })
        .then((r) => r.text())
        .then((body) => handleBody("/api/v1/users/web_profile_info/", body))
        .catch(() => {});
    }
    if (msg.type === "fetchAbout" && msg.data && msg.data.username) {
      triggerAboutAccount(msg.data.username);
    }
  });

  send("ready", { world: "MAIN", href: location.href });
})();

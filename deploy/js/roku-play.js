// Play a Brous Movie Engine title on the living-room Roku through the Streaming Engine
// (a small Python server on the home Mac — see ~/brous-screen/server.py).
//
// Two ways to reach it:
//  1. Direct: if the engine answers on this machine (or on an address saved in Settings),
//     call it straight away. Fast, and only works from the Mac itself.
//  2. Queue: otherwise drop a "play this" job on the Worker (POST /api/play). The engine
//     polls the Worker over an outbound request and plays it. This is what makes Play work
//     from a phone on an https page, where a plain-http home-network address is blocked.
// Play buttons stay hidden until one of the two is reachable (body.engine-offline).

const STREAM_ENGINE_LOCAL = "http://127.0.0.1:8787";
const STREAM_ENGINE_KEY = "brous_stream_engine";

// Brous "My services" labels -> the engine's service ids, so what you subscribe to in
// Brous decides what plays instead of a second list kept inside the engine.
const ENGINE_SERVICE_IDS = {
  "Netflix": "netflix", "Hulu": "hulu", "HBO Max": "max", "Prime Video": "prime",
  "Disney+": "disney", "Apple TV+": "apple", "Paramount+": "paramount", "Peacock": "peacock",
  "Shudder": "shudder", "AMC+": "amc", "Starz": "starz", "Criterion": "criterion",
  "Tubi": "tubi", "Pluto TV": "pluto",
};

let streamEngineBase = "";

function engineServiceIds() {
  if (typeof myServices === "undefined" || !myServices) return [];
  return [...myServices].map((label) => ENGINE_SERVICE_IDS[label]).filter(Boolean);
}

function validEngineUrl(value) {
  return /^https?:\/\/(localhost|(\d{1,3}\.){3}\d{1,3})(:\d{2,5})?$/.test(value || "");
}

function savedEngineUrl() {
  try {
    const v = (localStorage.getItem(STREAM_ENGINE_KEY) || "").trim();
    return validEngineUrl(v) ? v : "";
  } catch (_) { return ""; }
}

function streamEngineUrls() {
  return [...new Set([savedEngineUrl(), STREAM_ENGINE_LOCAL].filter(Boolean))];
}

async function findStreamEngine() {
  if (streamEngineBase) return streamEngineBase;
  for (const base of streamEngineUrls()) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 800);
    try {
      const res = await fetch(base + "/api/max", { signal: ctrl.signal });
      if (res.ok) {
        streamEngineBase = base;
        return base;
      }
    } catch (_) {
      /* not here, try the next address */
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("Streaming Engine is not reachable directly");
}

// Calls to this site's own /api (Worker) with the shared password. Deliberately not
// apiFetch(): that wipes the saved password on any 401, which a Play check shouldn't do.
async function playApi(path, options = {}) {
  const base = (typeof apiBase === "string" ? apiBase : "").replace(/\/+$/, "");
  const headers = typeof getAuthHeaders === "function" ? { ...getAuthHeaders() } : {};
  if (options.body) headers["Content-Type"] = "application/json";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), options.timeoutMs || 10000);
  try {
    const res = await fetch(base + path, {
      method: options.method || "GET",
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(res.status === 401
        ? "Enter your password in Settings to use Play"
        : (data.error || `Error ${res.status}`));
      err.status = res.status;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

const _sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function playViaQueue(payload) {
  const { id } = await playApi("/api/play", { method: "POST", body: payload });
  if (typeof showToast === "function") showToast("Sent to your Mac…");
  const deadline = Date.now() + 50000;
  while (Date.now() < deadline) {
    await _sleep(1500);
    const st = await playApi("/api/play/status?id=" + encodeURIComponent(id));
    if (st.status === "done") return st.message || "Started";
    if (st.status === "failed" || st.status === "expired") {
      throw new Error(st.message || "Could not start it");
    }
  }
  throw new Error("Timed out waiting for your Mac. Is the Streaming Engine running?");
}

async function playDirect(base, payload) {
  const res = await fetch(base + "/api/play-title", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Could not start it");
  return data.message || "Started";
}

async function playOnRoku(item, button) {
  const title = (item && (item.title || item.name)) || "";
  if (!title) return;
  const year = ((item.release_date || item.first_air_date || "") + "").slice(0, 4);
  const payload = {
    title,
    year,
    mediaType: item._mediaType === "tv" ? "tv" : "movie",
    services: engineServiceIds(),
  };
  const previous = button ? button.textContent : "";
  if (button) {
    button.disabled = true;
    button.textContent = "Starting…";
  }
  try {
    let message;
    const base = await findStreamEngine().catch(() => "");
    if (base) {
      try {
        message = await playDirect(base, payload);
      } catch (err) {
        // The engine answered with an error: report it. Only a network failure (engine
        // went away) falls back to the queue, so a title is never started twice.
        if (!(err instanceof TypeError)) throw err;
        streamEngineBase = "";
        message = await playViaQueue(payload);
      }
    } else {
      message = await playViaQueue(payload);
    }
    if (typeof showToast === "function") showToast(message || `Starting ${title}`, "success");
  } catch (err) {
    if (typeof showToast === "function") showToast(err.message || "Could not start it", "error");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = previous || "Play";
    }
  }
}

function playOnRokuFromQueue(id, mediaType, button) {
  const item = (typeof toWatchList !== "undefined" ? toWatchList : []).find(
    (entry) => entry.id == id && (entry._mediaType || "movie") === (mediaType || "movie")
  );
  if (item) playOnRoku(item, button);
}

// ---- Is an engine reachable? Play buttons are hidden until it is. ----
function setEngineOnline(online) {
  document.body.classList.toggle("engine-offline", !online);
  const el = document.getElementById("settings-engine-status");
  if (el) {
    el.textContent = online
      ? "Streaming Engine is online."
      : "Streaming Engine not detected. Start it on your Mac (and add its worker.json) to get Play buttons.";
    el.style.color = online ? "#6ee7b7" : "";
  }
}

async function refreshEngineOnline() {
  let online = false;
  try {
    if (await findStreamEngine().catch(() => "")) {
      online = true;
    } else if (typeof apiPassword !== "undefined" && apiPassword) {
      online = !!(await playApi("/api/play/engine", { timeoutMs: 6000 })).online;
    }
  } catch (_) { /* leave offline */ }
  setEngineOnline(online);
}

function initEngineSettings() {
  const input = document.getElementById("settings-engine-url");
  if (!input) return;
  input.value = savedEngineUrl();
  input.onchange = () => {
    const v = input.value.trim();
    try {
      if (!v) localStorage.removeItem(STREAM_ENGINE_KEY);
      else if (validEngineUrl(v)) localStorage.setItem(STREAM_ENGINE_KEY, v);
      else { if (typeof showToast === "function") showToast("Use an address like http://192.168.1.50:8787", "error"); return; }
    } catch (_) {}
    streamEngineBase = "";
    refreshEngineOnline();
  };
}

document.body.classList.add("engine-offline");
initEngineSettings();
setTimeout(refreshEngineOnline, 1200);
setInterval(() => { if (!document.hidden) refreshEngineOnline(); }, 60000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshEngineOnline(); });

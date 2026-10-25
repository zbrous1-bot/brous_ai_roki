// Play a Brous Movie Engine title on the living-room Roku through Streaming Engine.
// The public site cannot reach the Roku. The browser calls this Mac directly.

const STREAM_ENGINE_CANDIDATES = [
  "http://127.0.0.1:8787",
  "http://192.168.1.212:8787",
];

let streamEngineBase = "";

function streamEngineUrls() {
  const saved = localStorage.getItem("brous_stream_engine");
  return [...new Set([saved, ...STREAM_ENGINE_CANDIDATES].filter(Boolean))];
}

async function findStreamEngine() {
  if (streamEngineBase) return streamEngineBase;
  for (const base of streamEngineUrls()) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1200);
    try {
      const res = await fetch(base + "/api/max", { signal: ctrl.signal });
      if (res.ok) {
        streamEngineBase = base;
        localStorage.setItem("brous_stream_engine", base);
        return base;
      }
    } catch (_) {
      /* try the next address */
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("Streaming Engine is not running on this Mac");
}

async function playOnRoku(item, button) {
  const title = (item && (item.title || item.name)) || "";
  if (!title) return;
  const year = ((item.release_date || item.first_air_date || "") + "").slice(0, 4);
  const mediaType = item._mediaType || "movie";
  const previous = button ? button.textContent : "";
  if (button) {
    button.disabled = true;
    button.textContent = "Starting…";
  }
  try {
    const base = await findStreamEngine();
    const res = await fetch(base + "/api/play-title", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, year, mediaType }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Could not start it");
    if (typeof showToast === "function") showToast(data.message || `Starting ${title}`, "success");
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

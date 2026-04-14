// Mobile PWA - fetches timestamps/history from Firebase REST and opens the
// YouTube app via a plain https deep link (OS intercepts).

const $ = (sel) => document.querySelector(sel);
const CONFIG_KEY = "yt-ts-sync:config";
const CACHE_KEY = "yt-ts-sync:last";

let activeTab = "progress";
let activeRefresh = null;

// ---------- config ----------
function loadConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function saveConfig(cfg) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
}

function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : { progress: [], history: [] };
  } catch {
    return { progress: [], history: [] };
  }
}
function saveCache(data) {
  localStorage.setItem(CACHE_KEY, JSON.stringify(data));
}

// ---------- fetch ----------
function fbUrl(cfg, path) {
  const base = String(cfg.databaseUrl).replace(/\/+$/, "");
  const sep = cfg.secret ? `?auth=${encodeURIComponent(cfg.secret)}` : "";
  return `${base}/${path}.json${sep}`;
}

async function fbGet(cfg, path) {
  const r = await fetch(fbUrl(cfg, path), { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  return data || {};
}

async function fetchAll(cfg) {
  const [ts, hist] = await Promise.all([
    fbGet(cfg, `timestamps/${encodeURIComponent(cfg.syncKey)}`),
    fbGet(cfg, `history/${encodeURIComponent(cfg.syncKey)}`),
  ]);
  const progress = Object.values(ts || {});
  const history = Object.values(hist || {});
  return { progress, history };
}

// ---------- formatting ----------
function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
function fmtSince(ms) {
  if (!ms) return "";
  const d = Math.max(0, Date.now() - ms);
  const s = Math.floor(d / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
function deepLink(videoId, seconds) {
  const t = Math.max(0, Math.floor(seconds || 0));
  // Plain https URL — iOS and Android intercept and open YouTube app.
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&t=${t}`;
}

// ---------- rendering ----------
function makeCard(entry) {
  const a = document.createElement("a");
  a.className = "card";
  a.href = deepLink(entry.videoId, entry.timestamp);
  // Same tab: OS can intercept and open YouTube app
  // (do NOT use target="_blank")

  const thumb = document.createElement("div");
  thumb.className = "thumb";
  const img = document.createElement("img");
  img.loading = "lazy";
  img.decoding = "async";
  img.src = entry.thumbnail || `https://i.ytimg.com/vi/${entry.videoId}/hqdefault.jpg`;
  img.alt = "";
  thumb.appendChild(img);

  const tTime = document.createElement("div");
  tTime.className = "t-time";
  tTime.textContent = fmtTime(entry.duration);
  thumb.appendChild(tTime);

  const track = document.createElement("div");
  track.className = "progress-track";
  const fill = document.createElement("div");
  fill.className = "progress-fill";
  fill.style.width = `${Math.round((entry.percent || 0) * 100)}%`;
  track.appendChild(fill);
  thumb.appendChild(track);

  const body = document.createElement("div");
  body.className = "card-body";
  const title = document.createElement("div");
  title.className = "card-title";
  title.textContent = entry.title || entry.videoId;
  body.appendChild(title);

  const meta = document.createElement("div");
  meta.className = "card-meta";
  const at = document.createElement("span");
  at.textContent = `${fmtTime(entry.timestamp)} / ${fmtTime(entry.duration)}`;
  meta.appendChild(at);
  const since = document.createElement("span");
  since.textContent = `· ${fmtSince(entry.savedAt)}`;
  meta.appendChild(since);
  body.appendChild(meta);

  a.appendChild(thumb);
  a.appendChild(body);
  return a;
}

function renderList(items, emptyText) {
  const list = $("#list");
  list.innerHTML = "";
  if (!items || items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = emptyText;
    list.appendChild(empty);
    return;
  }
  items.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  const frag = document.createDocumentFragment();
  items.forEach((e) => frag.appendChild(makeCard(e)));
  list.appendChild(frag);
}

function setStatus(text) {
  $("#status-line").textContent = text || "";
}

// ---------- refresh flow ----------
async function refresh({ silent = false } = {}) {
  const cfg = loadConfig();
  if (!cfg || !cfg.syncKey || !cfg.databaseUrl) {
    showSetup(true);
    return;
  }

  // Cancel any in-flight refresh
  if (activeRefresh) activeRefresh.cancelled = true;
  const token = { cancelled: false };
  activeRefresh = token;

  if (!silent) setStatus("Syncing…");

  // Show cached immediately
  const cache = loadCache();
  renderFromCache(cache);

  try {
    const data = await fetchAll(cfg);
    if (token.cancelled) return;
    saveCache(data);
    renderFromCache(data);
    setStatus(`Synced · ${new Date().toLocaleTimeString()}`);
  } catch (e) {
    if (token.cancelled) return;
    setStatus(`Offline · showing cached (${e.message || e})`);
  }
}

function renderFromCache(data) {
  if (activeTab === "progress") {
    renderList(
      data.progress || [],
      "No videos in progress. Watch something on your laptop to see it here."
    );
  } else {
    renderList(data.history || [], "No watch history yet.");
  }
}

// ---------- setup UI ----------
function showSetup(show) {
  $("#setup").classList.toggle("hidden", !show);
}

function setupTabs() {
  document.querySelectorAll(".tab").forEach((el) => {
    el.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((e) => e.classList.remove("active"));
      el.classList.add("active");
      activeTab = el.dataset.tab;
      renderFromCache(loadCache());
    });
  });
}

function setupControls() {
  $("#settings-btn").addEventListener("click", () => {
    const panel = $("#setup");
    panel.classList.toggle("hidden");
    if (!panel.classList.contains("hidden")) {
      const cfg = loadConfig();
      if (cfg) {
        $("#sync-key-input").value = cfg.syncKey || "";
        $("#fb-url-input").value = cfg.databaseUrl || "";
        $("#fb-secret-input").value = cfg.secret || "";
      }
    }
  });

  $("#refresh-btn").addEventListener("click", () => refresh());

  $("#save-config-btn").addEventListener("click", async () => {
    const syncKey = $("#sync-key-input").value.trim().toUpperCase();
    const databaseUrl = $("#fb-url-input").value.trim();
    const secret = $("#fb-secret-input").value.trim();
    if (!syncKey || !databaseUrl) {
      $("#setup-status").textContent = "Sync key and Firebase URL are required.";
      return;
    }
    saveConfig({ syncKey, databaseUrl, secret: secret || null });
    $("#setup-status").textContent = "Saved. Loading…";
    showSetup(false);
    await refresh();
  });
}

// ---------- wake / focus triggers ----------
function setupAutoRefresh() {
  // refresh when returning to the app
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refresh({ silent: true });
  });
  window.addEventListener("focus", () => refresh({ silent: true }));
  window.addEventListener("pageshow", () => refresh({ silent: true }));
  // periodic while visible
  setInterval(() => {
    if (document.visibilityState === "visible") refresh({ silent: true });
  }, 60_000);
}

// ---------- service worker ----------
function registerSw() {
  if (!("serviceWorker" in navigator)) return;
  // Use relative path so it works under any base URL
  navigator.serviceWorker.register("sw.js").catch((e) => {
    console.warn("SW register failed:", e);
  });
}

// ---------- boot ----------
document.addEventListener("DOMContentLoaded", () => {
  setupTabs();
  setupControls();
  setupAutoRefresh();
  registerSw();
  const cfg = loadConfig();
  if (!cfg || !cfg.syncKey || !cfg.databaseUrl) {
    showSetup(true);
    // still render cache if any
    renderFromCache(loadCache());
  } else {
    refresh();
  }
});

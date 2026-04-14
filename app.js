// Mobile PWA list page.
// - Reads list state from Firebase via shared helpers (window.YTSync).
// - Card tap navigates to in-PWA player (player.html).
// - Secondary "↗" button opens the native YouTube app via https deep link.
// - Also handles incoming Web Share Target params on startup.

const $ = (sel) => document.querySelector(sel);
const Y = window.YTSync;

let activeTab = "progress";
let activeRefresh = null;

// ---------- share target landing ----------
// If the user shared a YouTube URL INTO the PWA (Android share sheet),
// we'll land on index.html with ?url=... or ?text=... or ?title=...
// Extract an ID and bounce to the player.
(function handleShareTarget() {
  const params = new URLSearchParams(location.search);
  const candidates = [params.get("url"), params.get("text"), params.get("title")].filter(Boolean);
  for (const c of candidates) {
    const id = Y.extractVideoId(c);
    if (id) {
      location.replace(Y.playerLink(id, 0));
      return;
    }
  }
})();

// ---------- rendering ----------
function makeCard(entry) {
  const card = document.createElement("div");
  card.className = "card";

  // Primary link: in-PWA player (same tab, SPA feel).
  const primary = document.createElement("a");
  primary.className = "card-link";
  primary.href = Y.playerLink(entry.videoId, entry.timestamp);

  const thumb = document.createElement("div");
  thumb.className = "thumb";
  const img = document.createElement("img");
  img.loading = "lazy";
  img.decoding = "async";
  img.src = entry.thumbnail || Y.thumbUrl(entry.videoId);
  img.alt = "";
  thumb.appendChild(img);

  const tTime = document.createElement("div");
  tTime.className = "t-time";
  tTime.textContent = Y.fmtTime(entry.duration);
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
  at.textContent = `${Y.fmtTime(entry.timestamp)} / ${Y.fmtTime(entry.duration)}`;
  meta.appendChild(at);
  const since = document.createElement("span");
  since.textContent = `· ${Y.fmtSince(entry.savedAt)}`;
  meta.appendChild(since);
  body.appendChild(meta);

  primary.appendChild(thumb);
  primary.appendChild(body);
  card.appendChild(primary);

  // Secondary: native YouTube app handoff. Absolute-positioned, stops
  // propagation so it doesn't also trigger the primary link.
  const native = document.createElement("a");
  native.className = "open-native";
  native.href = Y.deepLink(entry.videoId, entry.timestamp);
  native.setAttribute("aria-label", "Open in YouTube app");
  native.title = "Open in YouTube app";
  native.textContent = "↗";
  // Don't use target=_blank — OS universal links need same-tab navigation.
  native.addEventListener("click", (e) => {
    e.stopPropagation();
  });
  card.appendChild(native);

  // Later tab: show a remove-from-later action next to ↗.
  if (activeTab === "later") {
    const rm = document.createElement("button");
    rm.className = "card-remove";
    rm.type = "button";
    rm.setAttribute("aria-label", "Remove from Later");
    rm.title = "Remove from Later";
    rm.textContent = "\u2715"; // ✕
    rm.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      card.classList.add("removing");
      try {
        const cfg = Y.loadConfig();
        if (cfg) await Y.removeLater(cfg, entry.videoId);
      } catch (err) {
        console.warn("remove later failed", err);
      }
      // Trim from cache and re-render so the list is consistent.
      const cache = Y.loadCache();
      cache.later = (cache.later || []).filter((e) => e.videoId !== entry.videoId);
      Y.saveCache(cache);
      card.remove();
      if (!document.querySelector("#list .card")) renderFromCache(Y.loadCache());
    });
    card.appendChild(rm);
  }

  return card;
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

function renderFromCache(data) {
  if (activeTab === "progress") {
    renderList(
      data.progress || [],
      "No videos in progress. Watch something on your laptop or tap a video here to start tracking."
    );
  } else if (activeTab === "later") {
    renderList(
      data.later || [],
      "Nothing saved for later. On YouTube, hover a video and tap the ⏱ button to add it here."
    );
  } else {
    renderList(data.history || [], "No watch history yet.");
  }
}

function setStatus(text) {
  $("#status-line").textContent = text || "";
}

// ---------- refresh flow ----------
async function refresh({ silent = false } = {}) {
  const cfg = Y.loadConfig();
  if (!cfg || !cfg.syncKey || !cfg.databaseUrl) {
    showSetup(true);
    renderFromCache(Y.loadCache());
    return;
  }
  if (activeRefresh) activeRefresh.cancelled = true;
  const token = { cancelled: false };
  activeRefresh = token;

  if (!silent) setStatus("Syncing…");
  renderFromCache(Y.loadCache());

  try {
    const data = await Y.fetchAll(cfg);
    if (token.cancelled) return;
    Y.saveCache(data);
    renderFromCache(data);
    setStatus(`Synced · ${new Date().toLocaleTimeString()}`);
  } catch (e) {
    if (token.cancelled) return;
    setStatus(`Offline · showing cached (${e.message || e})`);
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
      renderFromCache(Y.loadCache());
    });
  });
}

function setupControls() {
  $("#settings-btn").addEventListener("click", () => {
    const panel = $("#setup");
    panel.classList.toggle("hidden");
    if (!panel.classList.contains("hidden")) {
      const cfg = Y.loadConfig();
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
    Y.saveConfig({ syncKey, databaseUrl, secret: secret || null });
    $("#setup-status").textContent = "Saved. Loading…";
    showSetup(false);
    await refresh();
  });
}

// ---------- wake / focus triggers ----------
function setupAutoRefresh() {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refresh({ silent: true });
  });
  window.addEventListener("focus", () => refresh({ silent: true }));
  window.addEventListener("pageshow", () => refresh({ silent: true }));
  setInterval(() => {
    if (document.visibilityState === "visible") refresh({ silent: true });
  }, 60_000);
}

// ---------- service worker ----------
function registerSw() {
  if (!("serviceWorker" in navigator)) return;
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
  const cfg = Y.loadConfig();
  if (!cfg || !cfg.syncKey || !cfg.databaseUrl) {
    showSetup(true);
    renderFromCache(Y.loadCache());
  } else {
    refresh();
  }
});

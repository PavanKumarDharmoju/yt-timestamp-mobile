// Mobile PWA list page.
// - Reads list state from Firebase via shared helpers (window.YTSync).
// - Card tap navigates to in-PWA player (player.html).
// - Secondary "↗" button opens the native YouTube app via https deep link.
// - Also handles incoming Web Share Target params on startup.

const $ = (sel) => document.querySelector(sel);
const Y = window.YTSync;

let activeTab = "progress";
let activeRefresh = null;
let playlistsCache = [];   // summaries for the picker
let openPlaylistId = null; // non-null inside drill-in view

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

  // "+" button in the card corner opens a playlist picker.
  const addPl = document.createElement("button");
  addPl.className = "card-playlist";
  addPl.type = "button";
  addPl.setAttribute("aria-label", "Add to playlist");
  addPl.title = "Add to playlist";
  addPl.textContent = "\u002B"; // +
  addPl.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    Y.openPlaylistPicker(entry, {
      playlists: playlistsCache,
      onChange: refreshPlaylistsCache,
    });
  });
  card.appendChild(addPl);

  // Later tab: show a remove-from-later action.
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

  // Playlist drill-in: show remove-from-playlist.
  if (activeTab === "playlists" && openPlaylistId) {
    const rm = document.createElement("button");
    rm.className = "card-remove";
    rm.type = "button";
    rm.setAttribute("aria-label", "Remove from playlist");
    rm.title = "Remove from playlist";
    rm.textContent = "\u2715";
    rm.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      card.classList.add("removing");
      try {
        const cfg = Y.loadConfig();
        if (cfg) await Y.removeFromPlaylist(cfg, openPlaylistId, entry.videoId);
      } catch (err) {
        console.warn("remove from playlist failed", err);
      }
      card.remove();
      await refreshPlaylistsCache();
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
  updatePlaylistChrome();
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
  } else if (activeTab === "playlists") {
    if (openPlaylistId) {
      renderPlaylistDetail(openPlaylistId);
    } else {
      renderPlaylistsList();
    }
  } else {
    renderList(data.history || [], "No watch history yet.");
  }
}

// ---------- playlists view ----------
function updatePlaylistChrome() {
  const inPlaylists = activeTab === "playlists";
  $("#playlist-create").classList.toggle("hidden", !inPlaylists || !!openPlaylistId);
  $("#playlist-detail").classList.toggle("hidden", !inPlaylists || !openPlaylistId);
  $("#list").classList.toggle("hidden", inPlaylists && !!openPlaylistId);
}

function makePlaylistRow(pl) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "playlist-row";
  const left = document.createElement("div");
  left.className = "playlist-row-left";
  const name = document.createElement("div");
  name.className = "playlist-row-name";
  name.textContent = pl.name;
  const meta = document.createElement("div");
  meta.className = "playlist-row-meta muted small";
  const count = pl.itemCount || 0;
  meta.textContent = `${count} video${count === 1 ? "" : "s"} · ${Y.fmtSince(pl.updatedAt)}`;
  left.appendChild(name);
  left.appendChild(meta);
  const chev = document.createElement("span");
  chev.className = "chev";
  chev.textContent = "\u203A";
  row.appendChild(left);
  row.appendChild(chev);
  row.addEventListener("click", () => {
    openPlaylistId = pl.id;
    renderFromCache(Y.loadCache());
  });
  return row;
}

async function refreshPlaylistsCache() {
  const cfg = Y.loadConfig();
  if (!cfg || !cfg.syncKey || !cfg.databaseUrl) {
    playlistsCache = [];
    return;
  }
  try {
    playlistsCache = await Y.fetchPlaylists(cfg);
  } catch {
    // stay with last known
  }
}

async function renderPlaylistsList() {
  const list = $("#list");
  list.innerHTML = '<div class="empty">Loading…</div>';
  await refreshPlaylistsCache();
  if (!playlistsCache.length) {
    list.innerHTML =
      '<div class="empty">No playlists yet. Create one above to bundle videos.</div>';
    return;
  }
  list.innerHTML = "";
  const frag = document.createDocumentFragment();
  playlistsCache.forEach((pl) => frag.appendChild(makePlaylistRow(pl)));
  list.appendChild(frag);
}

async function renderPlaylistDetail(playlistId) {
  const container = $("#playlist-detail-list");
  container.innerHTML = '<div class="empty">Loading…</div>';
  const cfg = Y.loadConfig();
  if (!cfg) {
    container.innerHTML = '<div class="empty">Configure Firebase first.</div>';
    return;
  }
  let playlist;
  try {
    playlist = await Y.fetchPlaylist(cfg, playlistId);
  } catch {
    container.innerHTML = '<div class="empty">Could not load playlist.</div>';
    return;
  }
  if (!playlist) {
    container.innerHTML = '<div class="empty">Playlist not found.</div>';
    return;
  }
  $("#playlist-rename-input").value = playlist.name || "";
  const items = playlist.items || [];
  if (!items.length) {
    container.innerHTML =
      '<div class="empty">Empty playlist. Tap + on any video to add it here.</div>';
    return;
  }
  container.innerHTML = "";
  const frag = document.createDocumentFragment();
  items.forEach((e) => frag.appendChild(makeCard(e)));
  container.appendChild(frag);
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
      openPlaylistId = null;
      renderFromCache(Y.loadCache());
    });
  });
}

function setupPlaylistsUI() {
  const nameInput = $("#playlist-name-input");
  const createBtn = $("#playlist-create-btn");
  const doCreate = async () => {
    const name = nameInput.value.trim();
    if (!name) return;
    const cfg = Y.loadConfig();
    if (!cfg) return;
    createBtn.disabled = true;
    try {
      await Y.createPlaylist(cfg, name);
      nameInput.value = "";
      await refreshPlaylistsCache();
      await renderPlaylistsList();
    } finally {
      createBtn.disabled = false;
    }
  };
  createBtn.addEventListener("click", doCreate);
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doCreate();
  });

  $("#playlist-back-btn").addEventListener("click", () => {
    openPlaylistId = null;
    renderFromCache(Y.loadCache());
  });

  const renameInput = $("#playlist-rename-input");
  const commitRename = async () => {
    if (!openPlaylistId) return;
    const name = renameInput.value.trim();
    if (!name) return;
    const cfg = Y.loadConfig();
    if (!cfg) return;
    try {
      await Y.renamePlaylist(cfg, openPlaylistId, name);
      await refreshPlaylistsCache();
    } catch {
      // no-op
    }
  };
  renameInput.addEventListener("blur", commitRename);
  renameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      renameInput.blur();
    }
  });

  $("#playlist-delete-btn").addEventListener("click", async () => {
    if (!openPlaylistId) return;
    if (!confirm("Delete this playlist? This cannot be undone.")) return;
    const cfg = Y.loadConfig();
    if (!cfg) return;
    try {
      await Y.deletePlaylist(cfg, openPlaylistId);
    } finally {
      openPlaylistId = null;
      await refreshPlaylistsCache();
      renderFromCache(Y.loadCache());
    }
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
  setupPlaylistsUI();
  setupAutoRefresh();
  registerSw();
  const cfg = Y.loadConfig();
  if (!cfg || !cfg.syncKey || !cfg.databaseUrl) {
    showSetup(true);
    renderFromCache(Y.loadCache());
  } else {
    refresh();
    // Warm the picker so "+" on a card has data immediately.
    refreshPlaylistsCache();
  }
});

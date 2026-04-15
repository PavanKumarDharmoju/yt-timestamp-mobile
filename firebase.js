// Shared helpers for the PWA (list + player pages).
// Exposed on a single global: window.YTSync
// No modules, no bundler — just a plain <script src> include.

(function () {
  const CONFIG_KEY = "yt-ts-sync:config";
  const CACHE_KEY = "yt-ts-sync:last";

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

  // ---------- last-known-lists cache ----------
  function loadCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed || { progress: [], history: [], later: [] };
    } catch {
      return { progress: [], history: [], later: [] };
    }
  }
  function saveCache(data) {
    localStorage.setItem(CACHE_KEY, JSON.stringify(data));
  }
  // Patch in a single entry to both lists (used by the player after a save).
  function upsertCacheEntry(entry) {
    if (!entry || !entry.videoId) return;
    const cache = loadCache();
    const upsert = (arr) => {
      const i = arr.findIndex((e) => e.videoId === entry.videoId);
      if (i >= 0) arr[i] = entry;
      else arr.unshift(entry);
    };
    upsert(cache.progress);
    upsert(cache.history);
    saveCache(cache);
  }
  function removeFromProgressCache(videoId) {
    const cache = loadCache();
    cache.progress = (cache.progress || []).filter((e) => e.videoId !== videoId);
    saveCache(cache);
  }

  // ---------- firebase REST ----------
  function fbUrl(cfg, path) {
    const base = String(cfg.databaseUrl).replace(/\/+$/, "");
    const sep = cfg.secret ? `?auth=${encodeURIComponent(cfg.secret)}` : "";
    return `${base}/${path}.json${sep}`;
  }
  async function fbGet(cfg, path) {
    const r = await fetch(fbUrl(cfg, path), { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) || null;
  }
  async function fbPut(cfg, path, data) {
    const r = await fetch(fbUrl(cfg, path), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return true;
  }
  async function fbDelete(cfg, path) {
    const r = await fetch(fbUrl(cfg, path), { method: "DELETE" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return true;
  }

  // Fetch all three list paths in one go.
  async function fetchAll(cfg) {
    const [ts, hist, later] = await Promise.all([
      fbGet(cfg, `timestamps/${encodeURIComponent(cfg.syncKey)}`),
      fbGet(cfg, `history/${encodeURIComponent(cfg.syncKey)}`),
      fbGet(cfg, `later/${encodeURIComponent(cfg.syncKey)}`).catch(() => null),
    ]);
    return {
      progress: Object.values(ts || {}),
      history: Object.values(hist || {}),
      later: Object.values(later || {}),
    };
  }

  // Watch Later: toggle membership from the PWA.
  async function addLater(cfg, entry) {
    if (!entry || !entry.videoId) throw new Error("missing videoId");
    await fbPut(cfg, `later/${encodeURIComponent(cfg.syncKey)}/${encodeURIComponent(entry.videoId)}`, entry);
    return true;
  }
  async function removeLater(cfg, videoId) {
    await fbDelete(cfg, `later/${encodeURIComponent(cfg.syncKey)}/${encodeURIComponent(videoId)}`);
    return true;
  }

  // ---------- playlists ----------
  function generatePlaylistId() {
    return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }

  async function fetchPlaylists(cfg) {
    const data = await fbGet(cfg, `playlists/${encodeURIComponent(cfg.syncKey)}`);
    const items = Object.values(data || {}).map((p) => ({
      id: p.id,
      name: p.name,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      itemCount: p.items ? Object.keys(p.items).length : 0,
    }));
    items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return items;
  }

  async function fetchPlaylist(cfg, playlistId) {
    const pl = await fbGet(
      cfg,
      `playlists/${encodeURIComponent(cfg.syncKey)}/${encodeURIComponent(playlistId)}`
    );
    if (!pl) return null;
    return {
      id: pl.id,
      name: pl.name,
      createdAt: pl.createdAt,
      updatedAt: pl.updatedAt,
      items: Object.values(pl.items || {}).sort(
        (a, b) => (b.addedAt || 0) - (a.addedAt || 0)
      ),
    };
  }

  async function createPlaylist(cfg, name) {
    const clean = String(name || "").trim();
    if (!clean) throw new Error("missing name");
    const now = Date.now();
    const playlist = {
      id: generatePlaylistId(),
      name: clean,
      createdAt: now,
      updatedAt: now,
      items: {},
    };
    await fbPut(
      cfg,
      `playlists/${encodeURIComponent(cfg.syncKey)}/${encodeURIComponent(playlist.id)}`,
      playlist
    );
    return playlist;
  }

  async function renamePlaylist(cfg, playlistId, name) {
    const clean = String(name || "").trim();
    if (!playlistId || !clean) throw new Error("missing args");
    const now = Date.now();
    await fbPut(
      cfg,
      `playlists/${encodeURIComponent(cfg.syncKey)}/${encodeURIComponent(playlistId)}/name`,
      clean
    );
    await fbPut(
      cfg,
      `playlists/${encodeURIComponent(cfg.syncKey)}/${encodeURIComponent(playlistId)}/updatedAt`,
      now
    );
    return true;
  }

  async function deletePlaylist(cfg, playlistId) {
    if (!playlistId) throw new Error("missing playlistId");
    await fbDelete(
      cfg,
      `playlists/${encodeURIComponent(cfg.syncKey)}/${encodeURIComponent(playlistId)}`
    );
    return true;
  }

  async function addToPlaylist(cfg, playlistId, entry) {
    if (!playlistId || !entry || !entry.videoId) throw new Error("missing args");
    const now = Date.now();
    const item = { ...entry, addedAt: now };
    await fbPut(
      cfg,
      `playlists/${encodeURIComponent(cfg.syncKey)}/${encodeURIComponent(playlistId)}/items/${encodeURIComponent(entry.videoId)}`,
      item
    );
    await fbPut(
      cfg,
      `playlists/${encodeURIComponent(cfg.syncKey)}/${encodeURIComponent(playlistId)}/updatedAt`,
      now
    );
    return item;
  }

  async function removeFromPlaylist(cfg, playlistId, videoId) {
    if (!playlistId || !videoId) throw new Error("missing args");
    const now = Date.now();
    await fbDelete(
      cfg,
      `playlists/${encodeURIComponent(cfg.syncKey)}/${encodeURIComponent(playlistId)}/items/${encodeURIComponent(videoId)}`
    );
    await fbPut(
      cfg,
      `playlists/${encodeURIComponent(cfg.syncKey)}/${encodeURIComponent(playlistId)}/updatedAt`,
      now
    );
    return true;
  }

  // ---------- add-to-playlist bottom sheet ----------
  // Shared between the list page and the player page so we only maintain one
  // picker. `getPlaylists` lets the caller pass a warmed cache; if omitted
  // we fetch fresh. `onChange` fires after any mutation so the caller can
  // refresh its own summary cache.
  async function openPlaylistPicker(entry, opts = {}) {
    const cfg = loadConfig();
    if (!cfg || !cfg.syncKey || !cfg.databaseUrl) return;
    if (!entry || !entry.videoId) return;

    // One sheet at a time.
    document.querySelectorAll(".sheet-backdrop").forEach((n) => n.remove());

    let playlists = Array.isArray(opts.playlists) ? opts.playlists.slice() : null;
    if (!playlists) {
      try { playlists = await fetchPlaylists(cfg); } catch { playlists = []; }
    }

    const back = document.createElement("div");
    back.className = "sheet-backdrop";
    const sheet = document.createElement("div");
    sheet.className = "sheet";

    const head = document.createElement("div");
    head.className = "sheet-head";
    const htitle = document.createElement("div");
    htitle.className = "sheet-title";
    htitle.textContent = "Add to playlist";
    const close = document.createElement("button");
    close.className = "icon-btn";
    close.setAttribute("aria-label", "Close");
    close.textContent = "\u2715";
    close.addEventListener("click", () => back.remove());
    head.appendChild(htitle);
    head.appendChild(close);
    sheet.appendChild(head);

    const createRow = document.createElement("div");
    createRow.className = "sheet-create";
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "New playlist name\u2026";
    input.maxLength = 60;
    const createBtn = document.createElement("button");
    createBtn.className = "btn primary";
    createBtn.textContent = "Create & Add";
    const handleCreate = async () => {
      const name = input.value.trim();
      if (!name) return;
      createBtn.disabled = true;
      try {
        const pl = await createPlaylist(cfg, name);
        await addToPlaylist(cfg, pl.id, entry);
        if (typeof opts.onChange === "function") await opts.onChange();
        back.remove();
      } catch {
        createBtn.disabled = false;
        createBtn.textContent = "Failed";
      }
    };
    createBtn.addEventListener("click", handleCreate);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") handleCreate();
    });
    createRow.appendChild(input);
    createRow.appendChild(createBtn);
    sheet.appendChild(createRow);

    const body = document.createElement("div");
    body.className = "sheet-body";
    if (!playlists.length) {
      const empty = document.createElement("div");
      empty.className = "sheet-empty";
      empty.textContent = "No playlists yet \u2014 create one above.";
      body.appendChild(empty);
    } else {
      playlists.forEach((pl) => {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "sheet-row";
        const name = document.createElement("span");
        name.textContent = pl.name;
        const meta = document.createElement("span");
        meta.className = "muted small";
        meta.textContent = `${pl.itemCount || 0}`;
        row.appendChild(name);
        row.appendChild(meta);
        row.addEventListener("click", async () => {
          row.disabled = true;
          try {
            await addToPlaylist(cfg, pl.id, entry);
            row.innerHTML = "";
            row.textContent = "Added \u2713";
            if (typeof opts.onChange === "function") await opts.onChange();
            setTimeout(() => back.remove(), 500);
          } catch {
            row.disabled = false;
            row.textContent = "Failed";
          }
        });
        body.appendChild(row);
      });
    }
    sheet.appendChild(body);
    back.appendChild(sheet);
    back.addEventListener("click", (ev) => {
      if (ev.target === back) back.remove();
    });
    document.body.appendChild(back);
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

  // ---------- deep link + id extraction ----------
  function deepLink(videoId, seconds) {
    const t = Math.max(0, Math.floor(seconds || 0));
    return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&t=${t}`;
  }
  function playerLink(videoId, seconds) {
    const t = Math.max(0, Math.floor(seconds || 0));
    return `player.html?v=${encodeURIComponent(videoId)}&t=${t}`;
  }
  function thumbUrl(videoId) {
    return `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`;
  }

  // Accepts a URL or a bare 11-char ID; returns the video ID or null.
  // Covers youtube.com/watch?v=, youtu.be/, youtube.com/shorts/, and m.youtube.com.
  const ID_RE = /^[A-Za-z0-9_-]{11}$/;
  function extractVideoId(input) {
    if (!input) return null;
    input = String(input).trim();
    if (ID_RE.test(input)) return input;
    // If the input mixes text + URL (iOS share-sheet text param), grab the first URL.
    const urlMatch = input.match(/https?:\/\/\S+/);
    const candidate = urlMatch ? urlMatch[0] : input;
    let u;
    try { u = new URL(candidate); } catch { return null; }
    const host = u.hostname.replace(/^www\./, "").replace(/^m\./, "");
    if (host === "youtu.be") {
      const id = u.pathname.slice(1).split("/")[0];
      return ID_RE.test(id) ? id : null;
    }
    if (host === "youtube.com" || host === "youtube-nocookie.com" || host === "music.youtube.com") {
      if (u.pathname === "/watch") {
        const id = u.searchParams.get("v");
        return id && ID_RE.test(id) ? id : null;
      }
      const shorts = u.pathname.match(/^\/shorts\/([^/?#]+)/);
      if (shorts && ID_RE.test(shorts[1])) return shorts[1];
      const embed = u.pathname.match(/^\/embed\/([^/?#]+)/);
      if (embed && ID_RE.test(embed[1])) return embed[1];
    }
    return null;
  }

  // Build the same entry shape the extension writes.
  function buildEntry({ videoId, title, timestamp, duration, thumbnail }) {
    const dur = Math.floor(duration || 0);
    const ts = Math.floor(timestamp || 0);
    const percent = dur > 0 ? Math.max(0, Math.min(1, ts / dur)) : 0;
    return {
      videoId,
      title: title || videoId,
      timestamp: ts,
      duration: dur,
      percent,
      thumbnail: thumbnail || thumbUrl(videoId),
      savedAt: Date.now(),
    };
  }

  window.YTSync = {
    // config + cache
    loadConfig,
    saveConfig,
    loadCache,
    saveCache,
    upsertCacheEntry,
    removeFromProgressCache,
    // firebase
    fbUrl,
    fbGet,
    fbPut,
    fbDelete,
    fetchAll,
    addLater,
    removeLater,
    // playlists
    fetchPlaylists,
    fetchPlaylist,
    createPlaylist,
    renamePlaylist,
    deletePlaylist,
    addToPlaylist,
    removeFromPlaylist,
    openPlaylistPicker,
    // formatting + links
    fmtTime,
    fmtSince,
    deepLink,
    playerLink,
    thumbUrl,
    extractVideoId,
    buildEntry,
    // constants
    COMPLETE_THRESHOLD: 0.95,
    MIN_TIMESTAMP_SEC: 3,
    SAVE_INTERVAL_MS: 5000,
  };
})();

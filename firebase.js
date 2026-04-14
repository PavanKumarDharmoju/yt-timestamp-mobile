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
      return raw ? JSON.parse(raw) : { progress: [], history: [] };
    } catch {
      return { progress: [], history: [] };
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

  // Fetch both list paths in one go.
  async function fetchAll(cfg) {
    const [ts, hist] = await Promise.all([
      fbGet(cfg, `timestamps/${encodeURIComponent(cfg.syncKey)}`),
      fbGet(cfg, `history/${encodeURIComponent(cfg.syncKey)}`),
    ]);
    return {
      progress: Object.values(ts || {}),
      history: Object.values(hist || {}),
    };
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

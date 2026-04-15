// Mobile PWA player page.
// Uses the YouTube IFrame Player API (vanilla, no npm) to play the video
// inside the PWA so we can track currentTime / duration programmatically
// and mirror positions to Firebase — same shape the laptop extension writes.

const Y = window.YTSync;

// ---------- params ----------
const params = new URLSearchParams(location.search);
const videoId = Y.extractVideoId(params.get("v")) || params.get("v");
const urlStartSec = Math.max(0, parseInt(params.get("t") || "0", 10) || 0);

if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
  document.getElementById("player-error").classList.remove("hidden");
  document.getElementById("player-error-msg").textContent = "No video id in URL.";
  document.getElementById("player-error-link").href = "index.html";
}

// ---------- DOM refs ----------
const $title = document.getElementById("player-title");
const $meta = document.getElementById("player-meta");
const $sync = document.getElementById("player-sync");
const $err = document.getElementById("player-error");
const $errMsg = document.getElementById("player-error-msg");
const $errLink = document.getElementById("player-error-link");
const $openNative = document.getElementById("open-native");
const $laterBtn = document.getElementById("later-btn");

// Prime the native-app handoff links with our best known start time.
function updateNativeLinks(sec) {
  const href = Y.deepLink(videoId, sec || 0);
  $openNative.href = href;
  $errLink.href = href;
}
updateNativeLinks(urlStartSec);

// ---------- state ----------
let player = null;
let saveTimer = null;
let lastSavedAt = 0;
let savedEntryHint = null; // pre-fetched entry from Firebase (for title fallback)
let completed = false;
let startSec = urlStartSec;

// ---------- boot sequence ----------
let inLater = false;

(async function boot() {
  if (!videoId) return;

  // 1. Fetch saved position (if any) so we can resume from max(urlT, savedT).
  const cfg = Y.loadConfig();
  if (cfg && cfg.syncKey && cfg.databaseUrl) {
    try {
      const [entry, laterEntry] = await Promise.all([
        Y.fbGet(cfg, `timestamps/${encodeURIComponent(cfg.syncKey)}/${encodeURIComponent(videoId)}`),
        Y.fbGet(cfg, `later/${encodeURIComponent(cfg.syncKey)}/${encodeURIComponent(videoId)}`).catch(() => null),
      ]);
      if (entry && typeof entry.timestamp === "number") {
        savedEntryHint = entry;
        if (entry.timestamp > startSec) startSec = entry.timestamp;
      }
      if (laterEntry) setLaterState(true);
    } catch (e) {
      // Offline — try cache
      const cache = Y.loadCache();
      const hit =
        (cache.progress || []).find((e) => e.videoId === videoId) ||
        (cache.history || []).find((e) => e.videoId === videoId);
      if (hit && typeof hit.timestamp === "number") {
        savedEntryHint = hit;
        if (hit.timestamp > startSec) startSec = hit.timestamp;
      }
      const lh = (cache.later || []).find((e) => e.videoId === videoId);
      if (lh) setLaterState(true);
    }
  }

  updateNativeLinks(startSec);
  if (savedEntryHint?.title) $title.textContent = savedEntryHint.title;

  // 2. Load IFrame API and wait for it.
  loadIframeApi();
})();

// ---------- Watch Later toggle ----------
function setLaterState(on) {
  inLater = !!on;
  if (!$laterBtn) return;
  $laterBtn.classList.toggle("saved", inLater);
  $laterBtn.setAttribute("aria-label", inLater ? "Remove from Watch Later" : "Save to Watch Later");
  $laterBtn.title = inLater ? "Remove from Watch Later" : "Save to Watch Later";
  $laterBtn.textContent = inLater ? "\u2713" : "\u23F1"; // ✓ or ⏱
}

async function toggleLater() {
  if (!videoId) return;
  const cfg = Y.loadConfig();
  if (!cfg || !cfg.syncKey || !cfg.databaseUrl) {
    $sync.textContent = "· configure Firebase to save Later";
    return;
  }
  const wasOn = inLater;
  // Optimistic UI
  setLaterState(!wasOn);
  $laterBtn.disabled = true;
  try {
    if (wasOn) {
      await Y.removeLater(cfg, videoId);
      const cache = Y.loadCache();
      cache.later = (cache.later || []).filter((e) => e.videoId !== videoId);
      Y.saveCache(cache);
      $sync.textContent = "· removed from Later";
    } else {
      const tt = currentTimes();
      let title = savedEntryHint?.title;
      try { title = player?.getVideoData()?.title || title; } catch {}
      const entry = Y.buildEntry({
        videoId,
        title,
        timestamp: 0,
        duration: tt ? tt.d : (savedEntryHint?.duration || 0),
      });
      await Y.addLater(cfg, entry);
      const cache = Y.loadCache();
      cache.later = cache.later || [];
      const i = cache.later.findIndex((e) => e.videoId === videoId);
      if (i >= 0) cache.later[i] = entry; else cache.later.unshift(entry);
      Y.saveCache(cache);
      $sync.textContent = "· saved to Later";
    }
  } catch (e) {
    setLaterState(wasOn); // revert
    $sync.textContent = `· later failed (${e.message || e})`;
  } finally {
    $laterBtn.disabled = false;
  }
}

if ($laterBtn) $laterBtn.addEventListener("click", toggleLater);

// Auto-remove from Later once we've watched it (pairs with 95% complete +
// onEnded). Same reasoning YouTube applies to its own Watch Later list.
async function autoRemoveFromLaterIfPresent() {
  if (!inLater) return;
  const cfg = Y.loadConfig();
  if (!cfg || !cfg.syncKey || !cfg.databaseUrl) return;
  try {
    await Y.removeLater(cfg, videoId);
    const cache = Y.loadCache();
    cache.later = (cache.later || []).filter((e) => e.videoId !== videoId);
    Y.saveCache(cache);
    setLaterState(false);
  } catch {
    // best effort
  }
}

function loadIframeApi() {
  if (window.YT && window.YT.Player) {
    // already loaded (SPA re-entry)
    onYouTubeIframeAPIReady();
    return;
  }
  const tag = document.createElement("script");
  tag.src = "https://www.youtube.com/iframe_api";
  document.head.appendChild(tag);
  // YouTube fires this global when ready.
  window.onYouTubeIframeAPIReady = onYouTubeIframeAPIReady;
}

function onYouTubeIframeAPIReady() {
  if (!videoId || player) return;
  player = new YT.Player("player", {
    width: "100%",
    height: "100%",
    videoId,
    playerVars: {
      autoplay: 1,
      start: Math.max(0, Math.floor(startSec)),
      playsinline: 1,
      rel: 0,
      modestbranding: 1,
      fs: 1,
    },
    events: {
      onReady,
      onStateChange,
      onError,
    },
  });
}

// ---------- player events ----------
function onReady() {
  // Pull the real title now that the iframe is live (the saved hint may be stale
  // if the video was renamed since last sync).
  try {
    const data = player.getVideoData();
    if (data && data.title) $title.textContent = data.title;
  } catch {}
  refreshMeta();
}

function onStateChange(e) {
  const S = YT.PlayerState;
  switch (e.data) {
    case S.PLAYING:
      startSaveTimer();
      break;
    case S.PAUSED:
      stopSaveTimer();
      saveNow("pause");
      break;
    case S.ENDED:
      stopSaveTimer();
      handleEnded();
      break;
    case S.BUFFERING:
    case S.CUED:
    case S.UNSTARTED:
      refreshMeta();
      break;
  }
}

function onError(e) {
  // 2 = invalid parameter, 5 = HTML5 player error,
  // 100 = video not found / private,
  // 101 / 150 = embedding disabled by owner.
  stopSaveTimer();
  $err.classList.remove("hidden");
  const map = {
    2: "Invalid video id.",
    5: "Playback error. Try reloading.",
    100: "Video not found or made private.",
    101: "The video owner disabled embedded playback.",
    150: "The video owner disabled embedded playback.",
  };
  $errMsg.textContent = map[e.data] || `Playback error (${e.data}).`;
}

// ---------- save loop ----------
function startSaveTimer() {
  if (saveTimer) return;
  saveTimer = setInterval(() => {
    if (!player) return;
    try {
      if (player.getPlayerState && player.getPlayerState() !== YT.PlayerState.PLAYING) return;
    } catch { return; }
    saveNow("tick");
  }, Y.SAVE_INTERVAL_MS);
}
function stopSaveTimer() {
  if (saveTimer) {
    clearInterval(saveTimer);
    saveTimer = null;
  }
}

function currentTimes() {
  if (!player || !player.getCurrentTime) return null;
  try {
    const t = player.getCurrentTime() || 0;
    const d = player.getDuration() || 0;
    if (!d || isNaN(d)) return null;
    return { t, d };
  } catch {
    return null;
  }
}

async function saveNow(reason) {
  if (completed) return;
  const tt = currentTimes();
  if (!tt) return;
  if (tt.t < Y.MIN_TIMESTAMP_SEC) return;

  refreshMeta(tt.t, tt.d);

  const entry = Y.buildEntry({
    videoId,
    title: (() => {
      try { return player.getVideoData()?.title || savedEntryHint?.title; }
      catch { return savedEntryHint?.title; }
    })(),
    timestamp: tt.t,
    duration: tt.d,
  });

  // 95% threshold — mark complete but keep history.
  if (entry.percent >= Y.COMPLETE_THRESHOLD) {
    completed = true;
    await writeHistoryOnly(entry);
    await clearInProgress();
    await autoRemoveFromLaterIfPresent();
    $sync.textContent = `· watched to end`;
    return;
  }

  await writeBoth(entry);
}

async function writeBoth(entry) {
  Y.upsertCacheEntry(entry);
  const cfg = Y.loadConfig();
  if (!cfg || !cfg.syncKey || !cfg.databaseUrl) {
    $sync.textContent = "· local only (no Firebase)";
    return;
  }
  try {
    await Promise.all([
      Y.fbPut(cfg, `timestamps/${encodeURIComponent(cfg.syncKey)}/${encodeURIComponent(entry.videoId)}`, entry),
      Y.fbPut(cfg, `history/${encodeURIComponent(cfg.syncKey)}/${encodeURIComponent(entry.videoId)}`, entry),
    ]);
    lastSavedAt = Date.now();
    $sync.textContent = `· synced ${new Date(lastSavedAt).toLocaleTimeString()}`;
  } catch (e) {
    $sync.textContent = `· offline (${e.message || e})`;
  }
}

async function writeHistoryOnly(entry) {
  Y.upsertCacheEntry(entry);
  const cfg = Y.loadConfig();
  if (!cfg || !cfg.syncKey || !cfg.databaseUrl) return;
  try {
    await Y.fbPut(cfg, `history/${encodeURIComponent(cfg.syncKey)}/${encodeURIComponent(entry.videoId)}`, entry);
  } catch (e) {
    $sync.textContent = `· offline (${e.message || e})`;
  }
}

async function clearInProgress() {
  Y.removeFromProgressCache(videoId);
  const cfg = Y.loadConfig();
  if (!cfg || !cfg.syncKey || !cfg.databaseUrl) return;
  try {
    await Y.fbDelete(cfg, `timestamps/${encodeURIComponent(cfg.syncKey)}/${encodeURIComponent(videoId)}`);
  } catch {
    // best effort
  }
}

async function handleEnded() {
  const tt = currentTimes();
  if (!tt) return;
  const entry = Y.buildEntry({
    videoId,
    title: (() => {
      try { return player.getVideoData()?.title || savedEntryHint?.title; }
      catch { return savedEntryHint?.title; }
    })(),
    timestamp: tt.d,   // pin to full duration
    duration: tt.d,
  });
  entry.percent = 1;
  completed = true;
  await writeHistoryOnly(entry);
  await clearInProgress();
  await autoRemoveFromLaterIfPresent();
  $sync.textContent = "· watched to end";
}

// ---------- meta line ----------
function refreshMeta(t, d) {
  if (t == null || d == null) {
    const tt = currentTimes();
    if (!tt) { $meta.textContent = "—"; return; }
    t = tt.t; d = tt.d;
  }
  $meta.textContent = `${Y.fmtTime(t)} / ${Y.fmtTime(d)}`;
  updateNativeLinks(t);
}

// ---------- final-save hooks ----------
window.addEventListener("pagehide", () => {
  // No await — the browser will tear us down either way, but we fire the PUT
  // so the request is in flight before unload.
  saveNow("unload");
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") saveNow("hidden");
});

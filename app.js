(function () {
  "use strict";

  const STORAGE_KEYS = {
    lastVideoId: "ytab:lastVideoId",
    bookmarks: "ytab:bookmarks",
    positions: "ytab:lastPositionByVideo",
    history: "ytab:videoHistory"
  };
  const MAX_BOOKMARKS = 3;

  let player = null;
  let playerReady = false;
  let currentVideoId = null;
  let loadedVideoId = null;
  let bookmarks = [];
  let positionsByVideo = {};
  let videoHistory = [];
  let storageAvailable = true;
  let youtubeApiReady = false;
  let pendingSeekSeconds = null;
  let pendingVideoId = null;
  let pendingShouldPlay = false;

  const elements = {};

  window.onYouTubeIframeAPIReady = function () {
    youtubeApiReady = true;
    createPlayer();
  };

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    cacheElements();
    storageAvailable = checkStorage();
    bookmarks = loadBookmarks();
    positionsByVideo = loadPositions();
    videoHistory = loadVideoHistory();
    currentVideoId = getStoredValue(STORAGE_KEYS.lastVideoId) || null;

    bindEvents();
    if (currentVideoId) {
      elements.videoInput.value = currentVideoId;
    }
    renderBookmarks();
    renderVideoHistory();
    updateVideoTitle();
    loadYouTubeApi();

    if (!storageAvailable) {
      showStatus("Bookmarks may not persist in this browser.");
    }

    setInterval(updateCurrentTime, 750);
    setInterval(saveLastPosition, 5000);
  }

  function cacheElements() {
    elements.videoInput = document.getElementById("video-input");
    elements.loadVideo = document.getElementById("load-video");
    elements.playPause = document.getElementById("play-pause");
    elements.back30 = document.getElementById("back-30");
    elements.back10 = document.getElementById("back-10");
    elements.forward10 = document.getElementById("forward-10");
    elements.forward30 = document.getElementById("forward-30");
    elements.addBookmark = document.getElementById("add-bookmark");
    elements.bookmarkList = document.getElementById("bookmark-list");
    elements.lastPlayedTab = document.getElementById("last-played-tab");
    elements.historyTab = document.getElementById("history-tab");
    elements.lastPlayedPanel = document.getElementById("last-played-panel");
    elements.historyPanel = document.getElementById("history-panel");
    elements.lastPlayedList = document.getElementById("last-played-list");
    elements.historyList = document.getElementById("history-list");
    elements.currentTime = document.getElementById("current-time");
    elements.status = document.getElementById("status-message");
    elements.currentVideoTitle = document.getElementById("current-video-title");
  }

  function bindEvents() {
    elements.loadVideo.addEventListener("click", loadVideoFromInput);
    elements.videoInput.addEventListener("keydown", function (event) {
      if (event.key === "Enter") {
        loadVideoFromInput();
      }
    });
    elements.playPause.addEventListener("click", playPause);
    elements.back30.addEventListener("click", function () {
      seekBy(-30);
    });
    elements.back10.addEventListener("click", function () {
      seekBy(-10);
    });
    elements.forward10.addEventListener("click", function () {
      seekBy(10);
    });
    elements.forward30.addEventListener("click", function () {
      seekBy(30);
    });
    elements.addBookmark.addEventListener("click", addBookmark);
    elements.lastPlayedTab.addEventListener("click", function () {
      setActiveTab("last");
    });
    elements.historyTab.addEventListener("click", function () {
      setActiveTab("history");
    });
  }

  function loadYouTubeApi() {
    if (window.YT && window.YT.Player) {
      window.onYouTubeIframeAPIReady();
      return;
    }

    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(script);
  }

  function onPlayerReady(event) {
    if (event && event.target) {
      player = event.target;
    }
    playerReady = true;
    applyPendingPlayback();
    updateCurrentTime();
  }

  function onPlayerStateChange(event) {
    if (event && event.target) {
      player = event.target;
    }
    updatePlayPauseLabel(event.data);
    applyPendingPlayback();
  }

  function loadVideoFromInput() {
    const videoInfo = extractVideoInfo(elements.videoInput.value);
    if (!videoInfo.videoId) {
      showStatus("Could not find a YouTube video ID. Paste a YouTube URL or video ID.");
      return;
    }
    loadVideo(videoInfo.videoId, videoInfo.startSeconds, true);
  }

  function loadVideo(videoId, startSeconds, shouldPlay) {
    const safeStart = Math.max(0, Math.floor(Number(startSeconds) || 0));
    currentVideoId = videoId;
    pendingVideoId = videoId;
    pendingSeekSeconds = safeStart;
    pendingShouldPlay = shouldPlay;
    saveCurrentVideo();
    elements.currentTime.textContent = formatTime(safeStart);
    positionsByVideo[videoId] = safeStart;
    setStoredJson(STORAGE_KEYS.positions, positionsByVideo);
    upsertVideoHistory(videoId, getStoredVideoTitle(videoId), safeStart);
    renderBookmarks();
    renderVideoHistory();
    updateVideoTitle();
    showStatus("");

    if (!youtubeApiReady || !playerReady) {
      return;
    }

    loadPlayerVideo(videoId, safeStart, shouldPlay);
  }

  function extractVideoInfo(input) {
    const value = String(input || "").trim();
    const info = {
      videoId: null,
      startSeconds: 0
    };

    if (/^[a-zA-Z0-9_-]{11}$/.test(value)) {
      info.videoId = value;
      return info;
    }

    try {
      const url = new URL(value);
      if (url.hostname.includes("youtu.be")) {
        info.videoId = cleanVideoId(url.pathname.slice(1));
      } else if (url.searchParams.has("v")) {
        info.videoId = cleanVideoId(url.searchParams.get("v"));
      } else {
        const embedMatch = url.pathname.match(/\/embed\/([a-zA-Z0-9_-]{11})/);
        if (embedMatch) {
          info.videoId = embedMatch[1];
        }
      }

      info.startSeconds = parseTimeParam(url.searchParams.get("t") || url.searchParams.get("start"));
    } catch (error) {
      info.videoId = null;
    }

    return info;
  }

  function extractVideoId(input) {
    return extractVideoInfo(input).videoId;
  }

  function cleanVideoId(value) {
    const match = String(value || "").match(/[a-zA-Z0-9_-]{11}/);
    return match ? match[0] : null;
  }

  function parseTimeParam(value) {
    const raw = String(value || "").trim();
    if (!raw) {
      return 0;
    }
    if (/^\d+$/.test(raw)) {
      return Number(raw);
    }

    const match = raw.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
    if (!match) {
      return 0;
    }

    const hours = Number(match[1] || 0);
    const minutes = Number(match[2] || 0);
    const seconds = Number(match[3] || 0);
    return (hours * 3600) + (minutes * 60) + seconds;
  }

  function playPause() {
    if (!currentVideoId) {
      showStatus("Load a video first.");
      return;
    }

    if (!playerReady || !canUsePlayerMethod("getPlayerState")) {
      pendingVideoId = currentVideoId;
      pendingSeekSeconds = loadLastPosition(currentVideoId);
      pendingShouldPlay = true;
      showStatus("");
      return;
    }

    const state = player.getPlayerState();
    if (state === YT.PlayerState.PLAYING) {
      if (!ensurePlayerMethodReady("pauseVideo")) {
        return;
      }
      player.pauseVideo();
      postPlayerCommand("pauseVideo");
    } else {
      const startSeconds = canUsePlayerMethod("getCurrentTime")
        ? Math.floor(getReliableCurrentTime())
        : loadLastPosition(currentVideoId);

      if (state === YT.PlayerState.PAUSED && canUsePlayerMethod("playVideo")) {
        player.playVideo();
        postPlayerCommand("playVideo");
      } else {
        loadPlayerVideo(currentVideoId, startSeconds, true);
      }
    }
  }

  function seekBy(seconds) {
    if (!currentVideoId) {
      showStatus("Load a video first.");
      return;
    }

    if (!playerReady || !canUsePlayerMethod("getCurrentTime") || !canUsePlayerMethod("seekTo")) {
      const nextSavedTime = Math.max(0, loadLastPosition(currentVideoId) + seconds);
      loadVideo(currentVideoId, nextSavedTime, false);
      return;
    }

    const currentTime = getReliableCurrentTime();
    const duration = canUsePlayerMethod("getDuration") ? player.getDuration() || 0 : 0;
    let nextTime = Math.max(0, currentTime + seconds);
    if (duration > 0) {
      nextTime = Math.min(duration, nextTime);
    }
    player.seekTo(nextTime, true);
    postPlayerCommand("seekTo", [nextTime, true]);
    updateCurrentTime();
  }

  function addBookmark() {
    if (!currentVideoId) {
      showStatus("Load a video first.");
      return;
    }
    if (!ensurePlayerMethodReady("getCurrentTime")) {
      return;
    }

    const timeSeconds = Math.floor(getReliableCurrentTime());
    const formattedTime = formatTime(timeSeconds);
    const bookmark = {
      id: "bookmark_" + Date.now(),
      videoId: currentVideoId,
      timeSeconds: timeSeconds,
      label: "Bookmark at " + formattedTime,
      createdAt: new Date().toISOString()
    };

    bookmarks.push(bookmark);
    bookmarks = getMostRecentBookmarks(bookmarks, MAX_BOOKMARKS);
    saveBookmarks();
    renderBookmarks();
    showStatus("");
  }

  function deleteBookmark(bookmarkId) {
    bookmarks = bookmarks.filter(function (bookmark) {
      return bookmark.id !== bookmarkId;
    });
    saveBookmarks();
    renderBookmarks();
  }

  function jumpToBookmark(bookmarkId) {
    const bookmark = bookmarks.find(function (item) {
      return item.id === bookmarkId;
    });
    if (!bookmark) {
      return;
    }

    if (bookmark.videoId !== currentVideoId) {
      loadVideo(bookmark.videoId, bookmark.timeSeconds, true);
      pendingSeekSeconds = bookmark.timeSeconds;
      return;
    }

    if (!ensurePlayerMethodReady("seekTo") || !ensurePlayerMethodReady("playVideo")) {
      pendingSeekSeconds = bookmark.timeSeconds;
      return;
    }

    player.seekTo(bookmark.timeSeconds, true);
    player.playVideo();
    updateCurrentTime();
  }

  function saveBookmarks() {
    setStoredJson(STORAGE_KEYS.bookmarks, bookmarks);
  }

  function loadBookmarks() {
    const saved = getStoredJson(STORAGE_KEYS.bookmarks, []);
    const storedBookmarks = Array.isArray(saved) ? saved : [];
    const recentBookmarks = getMostRecentBookmarks(storedBookmarks, MAX_BOOKMARKS);
    if (recentBookmarks.length !== storedBookmarks.length) {
      setStoredJson(STORAGE_KEYS.bookmarks, recentBookmarks);
    }
    return recentBookmarks;
  }

  function getMostRecentBookmarks(items, limit) {
    return items
      .slice()
      .sort(function (a, b) {
        return getBookmarkCreatedAtMs(b) - getBookmarkCreatedAtMs(a);
      })
      .slice(0, limit);
  }

  function getBookmarkCreatedAtMs(bookmark) {
    const created = Date.parse(bookmark && bookmark.createdAt);
    if (Number.isFinite(created)) {
      return created;
    }
    const idTime = Number(String(bookmark && bookmark.id || "").replace("bookmark_", ""));
    return Number.isFinite(idTime) ? idTime : 0;
  }

  function renderBookmarks() {
    const visibleBookmarks = bookmarks
      .filter(function (bookmark) {
        return currentVideoId ? bookmark.videoId === currentVideoId : false;
      })
      .sort(function (a, b) {
        return getBookmarkCreatedAtMs(b) - getBookmarkCreatedAtMs(a);
      });

    elements.bookmarkList.innerHTML = "";
    visibleBookmarks.forEach(function (bookmark) {
      const item = document.createElement("li");
      item.className = "bookmark-item";

      const jumpButton = document.createElement("button");
      jumpButton.type = "button";
      jumpButton.className = "bookmark-jump";
      jumpButton.addEventListener("click", function () {
        jumpToBookmark(bookmark.id);
      });

      const time = document.createElement("span");
      time.className = "bookmark-time";
      time.textContent = formatTime(bookmark.timeSeconds);

      const label = document.createElement("span");
      label.className = "bookmark-label";
      label.textContent = bookmark.label;

      jumpButton.append(time, label);

      const actions = document.createElement("div");
      actions.className = "bookmark-actions";

      const goButton = document.createElement("button");
      goButton.type = "button";
      goButton.textContent = "Jump to";
      goButton.addEventListener("click", function () {
        jumpToBookmark(bookmark.id);
      });

      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "danger";
      deleteButton.textContent = "Delete";
      deleteButton.addEventListener("click", function () {
        deleteBookmark(bookmark.id);
      });

      actions.append(goButton, deleteButton);
      item.append(jumpButton, actions);
      elements.bookmarkList.appendChild(item);
    });
  }

  function formatTime(seconds) {
    const safeSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
    const hours = Math.floor(safeSeconds / 3600);
    const minutes = Math.floor((safeSeconds % 3600) / 60);
    const remainingSeconds = safeSeconds % 60;

    if (hours > 0) {
      return [
        String(hours).padStart(2, "0"),
        String(minutes).padStart(2, "0"),
        String(remainingSeconds).padStart(2, "0")
      ].join(":");
    }

    return [
      String(minutes).padStart(2, "0"),
      String(remainingSeconds).padStart(2, "0")
    ].join(":");
  }

  function updateCurrentTime() {
    if (!playerReady || !canUsePlayerMethod("getCurrentTime")) {
      elements.currentTime.textContent = currentVideoId ? formatTime(loadLastPosition(currentVideoId)) : "00:00";
      syncCurrentVideoTitleFromPlayer();
      return;
    }
    elements.currentTime.textContent = formatTime(getReliableCurrentTime());
    syncCurrentVideoTitleFromPlayer();
  }

  function saveLastPosition() {
    if (!playerReady || !currentVideoId || !canUsePlayerMethod("getCurrentTime")) {
      return;
    }
    positionsByVideo[currentVideoId] = Math.floor(getReliableCurrentTime());
    setStoredJson(STORAGE_KEYS.positions, positionsByVideo);
    upsertVideoHistory(currentVideoId, getCurrentDisplayTitle(), positionsByVideo[currentVideoId]);
  }

  function loadLastPosition(videoId) {
    const savedPosition = Number(positionsByVideo[videoId] || 0);
    return Number.isFinite(savedPosition) ? savedPosition : 0;
  }

  function createPlayer() {
    const startSeconds = currentVideoId ? loadLastPosition(currentVideoId) : 0;
    pendingVideoId = currentVideoId;
    pendingSeekSeconds = currentVideoId ? startSeconds : null;
    pendingShouldPlay = false;
    playerReady = false;
    loadedVideoId = currentVideoId || null;
    player = new YT.Player("player-container", {
      videoId: currentVideoId || undefined,
      playerVars: getPlayerVars(startSeconds),
      events: {
        onReady: onPlayerReady,
        onStateChange: onPlayerStateChange
      }
    });
  }

  function loadPlayerVideo(videoId, startSeconds, shouldPlay) {
    if (!playerReady || !canUsePlayerMethod("loadVideoById")) {
      return;
    }

    loadPlayerVideoAt(videoId, startSeconds, shouldPlay);
    if (!shouldPlay) {
      player.pauseVideo();
    }
  }

  function applyPendingPlayback() {
    if (!playerReady || !canUsePlayerMethod("seekTo") || pendingSeekSeconds === null) {
      return;
    }
    if (pendingVideoId && pendingVideoId !== currentVideoId) {
      return;
    }

    if (pendingVideoId && pendingVideoId !== loadedVideoId && canUsePlayerMethod("loadVideoById")) {
      loadPlayerVideoAt(pendingVideoId, pendingSeekSeconds, pendingShouldPlay);
      pendingSeekSeconds = null;
      pendingShouldPlay = false;
      return;
    }

    player.seekTo(pendingSeekSeconds, true);
    postPlayerCommand("seekTo", [pendingSeekSeconds, true]);
    if (pendingShouldPlay) {
      player.playVideo();
      postPlayerCommand("playVideo");
    } else {
      player.pauseVideo();
      postPlayerCommand("pauseVideo");
    }
    pendingSeekSeconds = null;
    pendingShouldPlay = false;
  }

  function loadPositions() {
    const saved = getStoredJson(STORAGE_KEYS.positions, {});
    return saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  }

  function loadPlayerVideoAt(videoId, startSeconds, shouldPlay) {
    player.loadVideoById(videoId, startSeconds);
    loadedVideoId = videoId;

    window.setTimeout(function () {
      if (currentVideoId === videoId && canUsePlayerMethod("seekTo")) {
        player.seekTo(startSeconds, true);
      }
      if (currentVideoId === videoId && shouldPlay && canUsePlayerMethod("playVideo")) {
        player.playVideo();
        postPlayerCommand("playVideo");
      }
      if (currentVideoId === videoId && !shouldPlay && canUsePlayerMethod("pauseVideo")) {
        player.pauseVideo();
        postPlayerCommand("pauseVideo");
      }
    }, 500);
  }

  function saveCurrentVideo() {
    if (currentVideoId) {
      setStoredValue(STORAGE_KEYS.lastVideoId, currentVideoId);
      elements.videoInput.value = currentVideoId;
    }
  }

  function loadVideoHistory() {
    const saved = getStoredJson(STORAGE_KEYS.history, []);
    return Array.isArray(saved) ? saved.filter(isValidHistoryItem) : [];
  }

  function saveVideoHistory() {
    setStoredJson(STORAGE_KEYS.history, videoHistory);
  }

  function isValidHistoryItem(item) {
    return item && typeof item.videoId === "string" && item.videoId.length === 11;
  }

  function upsertVideoHistory(videoId, title, lastPosition) {
    if (!videoId) {
      return;
    }

    const existing = videoHistory.find(function (item) {
      return item.videoId === videoId;
    });
    const now = new Date().toISOString();
    const nextTitle = title && title !== "YouTube video player" ? title : videoId;
    const nextPosition = Math.max(0, Math.floor(Number(lastPosition) || 0));

    if (existing) {
      existing.title = nextTitle || existing.title || videoId;
      existing.lastPosition = nextPosition;
      existing.updatedAt = now;
    } else {
      videoHistory.push({
        videoId: videoId,
        title: nextTitle || videoId,
        lastPosition: nextPosition,
        createdAt: now,
        updatedAt: now
      });
    }

    videoHistory.sort(function (a, b) {
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
    videoHistory = videoHistory.slice(0, 50);
    saveVideoHistory();
    renderVideoHistory();
  }

  function getStoredVideoTitle(videoId) {
    const item = videoHistory.find(function (historyItem) {
      return historyItem.videoId === videoId;
    });
    return item ? item.title : videoId;
  }

  function getCurrentDisplayTitle() {
    const iframe = document.querySelector("#player-container iframe, iframe#player-container, iframe#player");
    if (iframe && iframe.title && iframe.title !== "YouTube video player") {
      return iframe.title;
    }
    return getStoredVideoTitle(currentVideoId);
  }

  function syncCurrentVideoTitleFromPlayer() {
    if (!currentVideoId) {
      return;
    }
    const title = getCurrentDisplayTitle();
    if (!title || title === currentVideoId) {
      return;
    }
    if (title === getStoredVideoTitle(currentVideoId)) {
      elements.currentVideoTitle.textContent = title;
      return;
    }
    elements.currentVideoTitle.textContent = title;
    upsertVideoHistory(currentVideoId, title, getCurrentPositionForHistory());
  }

  function getCurrentPositionForHistory() {
    if (playerReady && canUsePlayerMethod("getCurrentTime")) {
      return Math.floor(getReliableCurrentTime());
    }
    const historyItem = videoHistory.find(function (item) {
      return item.videoId === currentVideoId;
    });
    return historyItem ? historyItem.lastPosition : loadLastPosition(currentVideoId);
  }

  function renderVideoHistory() {
    renderVideoList(elements.lastPlayedList, videoHistory.slice(0, 1));
    renderVideoList(elements.historyList, videoHistory);
  }

  function renderVideoList(listElement, videos) {
    listElement.innerHTML = "";
    videos.forEach(function (video) {
      const item = document.createElement("li");
      item.className = "video-item";

      const button = document.createElement("button");
      button.type = "button";
      button.className = "video-history-button";
      button.addEventListener("click", function () {
        loadVideo(video.videoId, video.lastPosition || 0, false);
        setActiveTab("last");
      });

      const title = document.createElement("span");
      title.className = "video-history-title";
      title.textContent = video.title || video.videoId;

      const time = document.createElement("span");
      time.className = "video-history-time";
      time.textContent = formatTime(video.lastPosition || 0);

      button.append(title, time);
      item.appendChild(button);
      listElement.appendChild(item);
    });
  }

  function setActiveTab(tabName) {
    const showHistory = tabName === "history";
    elements.lastPlayedTab.classList.toggle("active", !showHistory);
    elements.historyTab.classList.toggle("active", showHistory);
    elements.lastPlayedTab.setAttribute("aria-selected", String(!showHistory));
    elements.historyTab.setAttribute("aria-selected", String(showHistory));
    elements.lastPlayedPanel.hidden = showHistory;
    elements.historyPanel.hidden = !showHistory;
    elements.lastPlayedPanel.classList.toggle("active", !showHistory);
    elements.historyPanel.classList.toggle("active", showHistory);
  }

  function getPlayerVars(startSeconds) {
    const vars = {
      controls: 1,
      playsinline: 1,
      rel: 0
    };

    if (startSeconds > 0) {
      vars.start = Math.floor(startSeconds);
    }

    return vars;
  }

  function updateVideoTitle() {
    elements.currentVideoTitle.textContent = currentVideoId ? getStoredVideoTitle(currentVideoId) : "No video loaded";
  }

  function updatePlayPauseLabel(playerState) {
    if (playerState === YT.PlayerState.PLAYING) {
      elements.playPause.textContent = "Pause";
      return;
    }
    elements.playPause.textContent = "Play/Pause";
  }

  function ensurePlayerReady() {
    if (!playerReady || !player) {
      showStatus("Player is still loading.");
      return false;
    }
    return true;
  }

  function ensurePlayerMethodReady(methodName) {
    if (!ensurePlayerReady()) {
      return false;
    }
    if (!canUsePlayerMethod(methodName)) {
      showStatus("Player is still loading.");
      return false;
    }
    return true;
  }

  function canUsePlayerMethod(methodName) {
    return Boolean(player && typeof player[methodName] === "function");
  }

  function getReliableCurrentTime() {
    if (!canUsePlayerMethod("getCurrentTime")) {
      return currentVideoId ? loadLastPosition(currentVideoId) : 0;
    }

    const currentTime = player.getCurrentTime() || 0;
    const savedTime = currentVideoId ? loadLastPosition(currentVideoId) : 0;
    const state = canUsePlayerMethod("getPlayerState") ? player.getPlayerState() : null;
    if (currentTime === 0 && savedTime > 0 && state !== YT.PlayerState.PLAYING) {
      return savedTime;
    }
    return currentTime;
  }

  function postPlayerCommand(func, args) {
    const iframe = document.querySelector("#player-container iframe, iframe#player-container, iframe#player");
    if (!iframe || !iframe.contentWindow) {
      return;
    }

    iframe.contentWindow.postMessage(JSON.stringify({
      event: "command",
      func: func,
      args: args || []
    }), "https://www.youtube.com");
  }

  function showStatus(message) {
    elements.status.textContent = message;
  }

  function checkStorage() {
    try {
      const testKey = "ytab:storage-test";
      window.localStorage.setItem(testKey, "1");
      window.localStorage.removeItem(testKey);
      return true;
    } catch (error) {
      return false;
    }
  }

  function getStoredValue(key) {
    if (!storageAvailable) {
      return null;
    }
    try {
      return window.localStorage.getItem(key);
    } catch (error) {
      return null;
    }
  }

  function setStoredValue(key, value) {
    if (!storageAvailable) {
      return;
    }
    try {
      window.localStorage.setItem(key, value);
    } catch (error) {
      storageAvailable = false;
      showStatus("Bookmarks may not persist in this browser.");
    }
  }

  function getStoredJson(key, fallback) {
    const value = getStoredValue(key);
    if (!value) {
      return fallback;
    }
    try {
      return JSON.parse(value);
    } catch (error) {
      return fallback;
    }
  }

  function setStoredJson(key, value) {
    setStoredValue(key, JSON.stringify(value));
  }
})();

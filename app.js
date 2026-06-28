(function () {
  "use strict";

  const STORAGE_KEYS = {
    lastVideoId: "jazz-bookmark:lastVideoId",
    bookmarks: "jazz-bookmark:bookmarks",
    positions: "jazz-bookmark:lastPositionByVideo",
    history: "jazz-bookmark:videoHistory"
  };
  const SHORT_VERTICAL_THRESHOLD_SECONDS = 110;
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
    updatePlayerLayout(currentVideoId);
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
    elements.youtubeFrame = document.querySelector(".youtube-frame");
    elements.copyState = document.getElementById("copy-state");
    elements.shareState = document.getElementById("share-state");
    elements.pasteState = document.getElementById("paste-state");
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
    elements.copyState.addEventListener("click", copyStateToClipboard);
    elements.shareState.addEventListener("click", shareState);
    elements.pasteState.addEventListener("click", pasteStateFromClipboard);
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
    updateShortDurationLayout();
  }

  function loadVideoFromInput() {
    const videoInfo = extractVideoInfo(elements.videoInput.value);
    if (!videoInfo.videoId) {
      showStatus("Could not find a YouTube video ID. Paste a YouTube URL or video ID.");
      return;
    }
    loadVideo(videoInfo.videoId, videoInfo.startSeconds, true, videoInfo.layout);
  }

  function loadVideo(videoId, startSeconds, shouldPlay, layoutHint) {
    const safeStart = Math.max(0, Math.floor(Number(startSeconds) || 0));
    currentVideoId = videoId;
    pendingVideoId = videoId;
    pendingSeekSeconds = safeStart;
    pendingShouldPlay = shouldPlay;
    saveCurrentVideo();
    elements.currentTime.textContent = formatTime(safeStart);
    positionsByVideo[videoId] = safeStart;
    setStoredJson(STORAGE_KEYS.positions, positionsByVideo);
    upsertVideoHistory(videoId, getStoredVideoTitle(videoId), safeStart, layoutHint);
    updatePlayerLayout(videoId, layoutHint);
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
      startSeconds: 0,
      layout: null
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
        const pathMatch = url.pathname.match(/\/(?:embed|shorts|live|v)\/([a-zA-Z0-9_-]{11})/);
        if (pathMatch) {
          info.videoId = pathMatch[1];
        }
      }

      if (isShortsUrl(url)) {
        info.layout = "vertical";
      }
      info.startSeconds = getUrlStartSeconds(url);
    } catch (error) {
      info.videoId = null;
    }

    return info;
  }

  function cleanVideoId(value) {
    const match = String(value || "").match(/[a-zA-Z0-9_-]{11}/);
    return match ? match[0] : null;
  }

  function isShortsUrl(url) {
    return /\/shorts\/[a-zA-Z0-9_-]{11}/.test(url.pathname);
  }

  function getUrlStartSeconds(url) {
    const rawTime = url.searchParams.get("t")
      || url.searchParams.get("start")
      || url.searchParams.get("time_continue")
      || url.searchParams.get("time")
      || url.hash.replace(/^#/, "");

    return parseTimeParam(rawTime);
  }

  function parseTimeParam(value) {
    let raw = String(value || "").trim().toLowerCase();
    if (!raw) {
      return 0;
    }
    raw = raw.replace(/^t=/, "").replace(/^start=/, "");
    if (/^\d+$/.test(raw)) {
      return Number(raw);
    }

    const colonParts = raw.split(":");
    if (colonParts.length > 1 && colonParts.every(function (part) {
      return /^\d+$/.test(part);
    })) {
      return colonParts.reduce(function (total, part) {
        return (total * 60) + Number(part);
      }, 0);
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
    if (!Array.isArray(saved)) {
      return [];
    }
    return saved
      .slice()
      .sort(function (a, b) {
        return getBookmarkCreatedAtMs(b) - getBookmarkCreatedAtMs(a);
      });
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
    updateShortDurationLayout();
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
    const safeStart = Math.max(0, Math.floor(Number(startSeconds) || 0));
    const playbackRequest = {
      videoId: videoId,
      startSeconds: safeStart
    };

    try {
      player.loadVideoById(playbackRequest);
    } catch (error) {
      player.loadVideoById(videoId, safeStart);
    }
    loadedVideoId = videoId;
    reinforcePlayerStart(videoId, safeStart, shouldPlay);
  }

  function reinforcePlayerStart(videoId, startSeconds, shouldPlay) {
    [250, 900, 1800].forEach(function (delay) {
      window.setTimeout(function () {
        if (currentVideoId !== videoId) {
          return;
        }
        if (canUsePlayerMethod("seekTo")) {
          player.seekTo(startSeconds, true);
          postPlayerCommand("seekTo", [startSeconds, true]);
        }
        if (shouldPlay && canUsePlayerMethod("playVideo")) {
          player.playVideo();
          postPlayerCommand("playVideo");
        }
        if (!shouldPlay && canUsePlayerMethod("pauseVideo")) {
          player.pauseVideo();
          postPlayerCommand("pauseVideo");
        }
      }, delay);
    });
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

  function upsertVideoHistory(videoId, title, lastPosition, layoutHint) {
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
      if (layoutHint) {
        existing.layout = layoutHint;
      }
    } else {
      videoHistory.push({
        videoId: videoId,
        title: nextTitle || videoId,
        lastPosition: nextPosition,
        createdAt: now,
        updatedAt: now,
        layout: layoutHint || "horizontal"
      });
    }

    videoHistory.sort(function (a, b) {
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
    saveVideoHistory();
    renderVideoHistory();
  }

  function getStoredVideoTitle(videoId) {
    const item = videoHistory.find(function (historyItem) {
      return historyItem.videoId === videoId;
    });
    return item ? item.title : videoId;
  }

  function getStoredVideoLayout(videoId) {
    const item = videoHistory.find(function (historyItem) {
      return historyItem.videoId === videoId;
    });
    return item && item.layout === "vertical" ? "vertical" : "horizontal";
  }

  function updatePlayerLayout(videoId, layoutHint) {
    const layout = layoutHint || (videoId ? getStoredVideoLayout(videoId) : "horizontal");
    elements.youtubeFrame.classList.toggle("vertical", layout === "vertical");
  }

  function updateShortDurationLayout() {
    if (!currentVideoId || getStoredVideoLayout(currentVideoId) === "vertical" || !canUsePlayerMethod("getDuration")) {
      return;
    }

    const duration = Number(player.getDuration() || 0);
    if (!Number.isFinite(duration) || duration <= 0 || duration >= SHORT_VERTICAL_THRESHOLD_SECONDS) {
      return;
    }

    upsertVideoHistory(currentVideoId, getCurrentDisplayTitle(), getCurrentPositionForHistory(), "vertical");
    updatePlayerLayout(currentVideoId, "vertical");
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
        loadVideo(video.videoId, video.lastPosition || 0, false, video.layout);
        setActiveTab("last");
      });

      const title = document.createElement("span");
      title.className = "video-history-title";
      title.textContent = video.title || video.videoId;

      const time = document.createElement("span");
      time.className = "video-history-time";
      time.textContent = formatTime(video.lastPosition || 0);

      button.append(title, time);

      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "danger video-delete";
      deleteButton.textContent = "Delete";
      deleteButton.addEventListener("click", function () {
        deleteVideoFromHistory(video.videoId);
      });

      item.append(button, deleteButton);
      listElement.appendChild(item);
    });
  }

  function deleteVideoFromHistory(videoId) {
    videoHistory = videoHistory.filter(function (item) {
      return item.videoId !== videoId;
    });
    delete positionsByVideo[videoId];
    bookmarks = bookmarks.filter(function (bookmark) {
      return bookmark.videoId !== videoId;
    });

    saveVideoHistory();
    setStoredJson(STORAGE_KEYS.positions, positionsByVideo);
    saveBookmarks();

    if (currentVideoId === videoId) {
      currentVideoId = null;
      loadedVideoId = null;
      pendingVideoId = null;
      pendingSeekSeconds = null;
      pendingShouldPlay = false;
      removeStoredValue(STORAGE_KEYS.lastVideoId);
      elements.videoInput.value = "";
      elements.currentTime.textContent = "00:00";
      if (canUsePlayerMethod("stopVideo")) {
        player.stopVideo();
        postPlayerCommand("stopVideo");
      }
      if (canUsePlayerMethod("clearVideo")) {
        player.clearVideo();
      }
      updatePlayerLayout(null);
    }

    renderBookmarks();
    renderVideoHistory();
    updateVideoTitle();
    showStatus("");
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

  function buildStatePackage() {
    return {
      app: "Jazz Book",
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      state: {
        lastVideoId: currentVideoId || getStoredValue(STORAGE_KEYS.lastVideoId) || null,
        bookmarks: bookmarks.slice(),
        positionsByVideo: Object.assign({}, positionsByVideo),
        videoHistory: videoHistory.slice()
      }
    };
  }

  async function copyStateToClipboard() {
    const payload = JSON.stringify(buildStatePackage(), null, 2);
    try {
      await writeClipboardText(payload);
      showStatus("State copied.");
    } catch (error) {
      window.prompt("Copy this Jazz Book state:", payload);
      showStatus("Copy the state text from the prompt.");
    }
  }

  async function shareState() {
    const payload = JSON.stringify(buildStatePackage(), null, 2);
    const shareData = {
      title: "Jazz Book State",
      text: payload
    };

    try {
      if (window.File && navigator.canShare) {
        const file = new File([payload], "jazz-book-state.json", {
          type: "application/json"
        });
        const fileShareData = {
          title: "Jazz Book State",
          text: "Jazz Book state export",
          files: [file]
        };
        if (navigator.canShare(fileShareData)) {
          await navigator.share(fileShareData);
          showStatus("State shared.");
          return;
        }
      }

      if (navigator.share) {
        await navigator.share(shareData);
        showStatus("State shared.");
        return;
      }

      await writeClipboardText(payload);
      showStatus("State copied.");
    } catch (error) {
      showStatus("Share canceled.");
    }
  }

  async function pasteStateFromClipboard() {
    let rawState = "";
    try {
      rawState = await readClipboardText();
    } catch (error) {
      rawState = window.prompt("Paste Jazz Book state here:") || "";
    }

    const importedState = parseImportedState(rawState);
    if (!importedState) {
      showStatus("Could not read Jazz Book state.");
      return;
    }

    const result = mergeImportedState(importedState);
    renderBookmarks();
    renderVideoHistory();
    updateVideoTitle();
    showStatus("Merged " + result.videosAdded + " videos and " + result.bookmarksAdded + " bookmarks.");
  }

  async function writeClipboardText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    throw new Error("Clipboard write is unavailable.");
  }

  async function readClipboardText() {
    if (navigator.clipboard && navigator.clipboard.readText) {
      return navigator.clipboard.readText();
    }
    throw new Error("Clipboard read is unavailable.");
  }

  function parseImportedState(rawState) {
    if (!rawState) {
      return null;
    }

    try {
      const parsed = JSON.parse(String(rawState).trim());
      const source = parsed && parsed.state ? parsed.state : parsed;
      return normalizeImportedState(source);
    } catch (error) {
      return null;
    }
  }

  function normalizeImportedState(source) {
    if (!source || typeof source !== "object") {
      return null;
    }

    const importedHistory = Array.isArray(source.videoHistory)
      ? source.videoHistory.filter(isValidHistoryItem).map(normalizeHistoryItem)
      : [];
    const importedBookmarks = Array.isArray(source.bookmarks)
      ? source.bookmarks.map(normalizeBookmark).filter(Boolean)
      : [];
    const importedPositions = normalizePositions(source.positionsByVideo || source.positions || {});
    const importedLastVideoId = typeof source.lastVideoId === "string" && source.lastVideoId.length === 11
      ? source.lastVideoId
      : null;

    if (!importedHistory.length && !importedBookmarks.length && !Object.keys(importedPositions).length && !importedLastVideoId) {
      return null;
    }

    return {
      lastVideoId: importedLastVideoId,
      bookmarks: importedBookmarks,
      positionsByVideo: importedPositions,
      videoHistory: importedHistory
    };
  }

  function normalizeHistoryItem(item) {
    const now = new Date().toISOString();
    return {
      videoId: item.videoId,
      title: item.title || item.videoId,
      lastPosition: Math.max(0, Math.floor(Number(item.lastPosition) || 0)),
      createdAt: isIsoDate(item.createdAt) ? item.createdAt : now,
      updatedAt: isIsoDate(item.updatedAt) ? item.updatedAt : now,
      layout: item.layout === "vertical" ? "vertical" : "horizontal"
    };
  }

  function normalizeBookmark(bookmark) {
    if (!bookmark || typeof bookmark.videoId !== "string" || bookmark.videoId.length !== 11) {
      return null;
    }

    const timeSeconds = Math.max(0, Math.floor(Number(bookmark.timeSeconds) || 0));
    const createdAt = isIsoDate(bookmark.createdAt) ? bookmark.createdAt : new Date().toISOString();
    return {
      id: typeof bookmark.id === "string" && bookmark.id ? bookmark.id : "bookmark_" + Date.now(),
      videoId: bookmark.videoId,
      timeSeconds: timeSeconds,
      label: bookmark.label || "Bookmark at " + formatTime(timeSeconds),
      createdAt: createdAt
    };
  }

  function normalizePositions(source) {
    return Object.keys(source || {}).reduce(function (result, videoId) {
      const seconds = Math.floor(Number(source[videoId]));
      if (videoId.length === 11 && Number.isFinite(seconds) && seconds >= 0) {
        result[videoId] = seconds;
      }
      return result;
    }, {});
  }

  function isIsoDate(value) {
    return typeof value === "string" && Number.isFinite(Date.parse(value));
  }

  function mergeImportedState(importedState) {
    const existingHistoryIds = new Set(videoHistory.map(function (item) {
      return item.videoId;
    }));
    const existingBookmarkSignatures = new Set(bookmarks.map(getBookmarkSignature));
    const existingBookmarkIds = new Set(bookmarks.map(function (bookmark) {
      return bookmark.id;
    }));
    let videosAdded = 0;
    let bookmarksAdded = 0;

    importedState.videoHistory.forEach(function (item) {
      if (!existingHistoryIds.has(item.videoId)) {
        videoHistory.push(item);
        existingHistoryIds.add(item.videoId);
        videosAdded += 1;
      }
    });

    Object.keys(importedState.positionsByVideo).forEach(function (videoId) {
      if (positionsByVideo[videoId] === undefined) {
        positionsByVideo[videoId] = importedState.positionsByVideo[videoId];
      }
    });

    importedState.bookmarks.forEach(function (bookmark) {
      const signature = getBookmarkSignature(bookmark);
      if (existingBookmarkSignatures.has(signature)) {
        return;
      }

      const nextBookmark = Object.assign({}, bookmark);
      if (existingBookmarkIds.has(nextBookmark.id)) {
        nextBookmark.id = createImportedBookmarkId(existingBookmarkIds);
      }
      bookmarks.push(nextBookmark);
      existingBookmarkSignatures.add(signature);
      existingBookmarkIds.add(nextBookmark.id);
      bookmarksAdded += 1;
    });

    if (!currentVideoId && importedState.lastVideoId) {
      currentVideoId = importedState.lastVideoId;
      setStoredValue(STORAGE_KEYS.lastVideoId, currentVideoId);
      elements.videoInput.value = currentVideoId;
      updatePlayerLayout(currentVideoId);
    }

    videoHistory.sort(function (a, b) {
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
    bookmarks.sort(function (a, b) {
      return getBookmarkCreatedAtMs(b) - getBookmarkCreatedAtMs(a);
    });

    saveVideoHistory();
    setStoredJson(STORAGE_KEYS.positions, positionsByVideo);
    saveBookmarks();

    return {
      videosAdded: videosAdded,
      bookmarksAdded: bookmarksAdded
    };
  }

  function getBookmarkSignature(bookmark) {
    return [bookmark.videoId, Math.floor(Number(bookmark.timeSeconds) || 0), bookmark.label || ""].join("|");
  }

  function createImportedBookmarkId(existingIds) {
    let id = "bookmark_imported_" + Date.now();
    while (existingIds.has(id)) {
      id = "bookmark_imported_" + Date.now() + "_" + Math.floor(Math.random() * 1000000);
    }
    return id;
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
      const testKey = "jazz-bookmark:storage-test";
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

  function removeStoredValue(key) {
    if (!storageAvailable) {
      return;
    }
    try {
      window.localStorage.removeItem(key);
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

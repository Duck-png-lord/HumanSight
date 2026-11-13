"use strict";

const $ = id => document.getElementById(id);

let detector = null;
let mobileNetModel = null;
let modelsReady = false;

let scanFile = null;
let scanUrl = null;
let scanMode = "image";
let scanBusy = false;
let predictionLabel = null;
let detections = [];

let gifFrames = [];
let gifFrameIndex = 0;
let gifAnimationId = null;
let gifTotalDuration = 0;
let scanResultsByTime = [];
let timelineDragging = false;

let searchFile = null;

let liveStream = null;
let liveRunning = false;
let liveBusy = false;
let liveLoopId = null;
let liveDetections = [];
let lastLiveDetection = 0;

let mediaRecorder = null;
let recordingChunks = [];
let recordingUrl = null;
let recordingTimer = null;
let recordingClock = null;
let recordingStartedAt = 0;
let recordingCanvas = null;
let recordingCanvasContext = null;
let recordingDrawLoop = null;
let recordingCanvasStream = null;

const MAX_VIDEO_SCAN_MS = 30000;
const MAX_VIDEO_FRAMES = 35;
const MAX_GIF_FRAMES = 50;
const LIVE_DETECTION_INTERVAL = 300;
const MAX_RECORDING_MS = 2 * 60 * 60 * 1000;

function setStatus(message) {
  const element = $("status");
  if (element) element.textContent = message;
}

function setLiveStatus(message) {
  const element = $("liveStatus");
  if (element) element.textContent = message;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  return `${Math.floor(seconds / 60)}:${String(
    Math.floor(seconds % 60)
  ).padStart(2, "0")}`;
}

async function apiRequest(url, options = {}) {
  const response = await fetch(url, options);
  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(result.error || `Request failed (${response.status})`);
  }

  return result;
}

/* Theme and tabs */

function setupThemeAndTabs() {
  const themeSelect = $("themeSelect");
  const savedTheme = localStorage.getItem("trainer-theme");

  if (savedTheme && ["light", "dark", "pastel", "cats"].includes(savedTheme)) {
    document.body.dataset.theme = savedTheme;
    themeSelect.value = savedTheme;
  }

  themeSelect.addEventListener("change", () => {
    document.body.dataset.theme = themeSelect.value;
    localStorage.setItem("trainer-theme", themeSelect.value);
  });

  document.querySelectorAll(".tab-button").forEach(button => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".tab-button").forEach(item => {
        item.classList.toggle("active", item === button);
      });

      document.querySelectorAll(".tab-panel").forEach(panel => {
        panel.classList.toggle("active", panel.id === button.dataset.tab);
      });

      if (button.dataset.tab !== "liveTab") stopCamera();
    });
  });
}

/* Training uploads */

function setupUploader(inputId, dropId, category) {
  const input = $(inputId);
  const dropzone = $(dropId);

  input.addEventListener("change", async () => {
    await uploadTrainingImages(input.files, category);
    input.value = "";
  });

  dropzone.addEventListener("dragover", event => {
    event.preventDefault();
    dropzone.classList.add("dragover");
  });

  dropzone.addEventListener("dragleave", () => {
    dropzone.classList.remove("dragover");
  });

  dropzone.addEventListener("drop", async event => {
    event.preventDefault();
    dropzone.classList.remove("dragover");
    await uploadTrainingImages(event.dataTransfer.files, category);
  });
}

async function uploadTrainingImages(files, category) {
  const images = [...files].filter(file => file.type.startsWith("image/"));

  if (!images.length) {
    setStatus("Choose image files first.");
    return;
  }

  const form = new FormData();
  for (const image of images) form.append("images", image);

  try {
    setStatus(`Uploading ${images.length} image(s)…`);

    await apiRequest(`/api/upload/${category}`, {
      method: "POST",
      body: form
    });

    setStatus("Images uploaded.");
  } catch (error) {
    setStatus(`Upload failed: ${error.message}`);
  }
}

/* Detection-box drawing */

function containedRect(stage, sourceWidth, sourceHeight) {
  if (!sourceWidth || !sourceHeight || !stage.clientWidth || !stage.clientHeight) {
    return null;
  }

  const scale = Math.min(
    stage.clientWidth / sourceWidth,
    stage.clientHeight / sourceHeight
  );

  return {
    x: (stage.clientWidth - sourceWidth * scale) / 2,
    y: (stage.clientHeight - sourceHeight * scale) / 2,
    scale
  };
}

function drawDetections(
  canvas,
  stage,
  sourceWidth,
  sourceHeight,
  results,
  showHeads
) {
  const dpr = window.devicePixelRatio || 1;
  const width = stage.clientWidth;
  const height = stage.clientHeight;

  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  const context = canvas.getContext("2d");
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);

  const rect = containedRect(stage, sourceWidth, sourceHeight);
  if (!rect) return;

  for (const result of results) {
    const [x, y, boxWidth, boxHeight] = result.bbox;
    const px = rect.x + x * rect.scale;
    const py = rect.y + y * rect.scale;
    const pw = boxWidth * rect.scale;
    const ph = boxHeight * rect.scale;

    context.lineWidth = 3;
    context.strokeStyle = "#17d895";
    context.strokeRect(px, py, pw, ph);

    const label = `Person ${(result.score * 100).toFixed(0)}%`;
    context.font = "bold 13px system-ui, sans-serif";

    const labelWidth = context.measureText(label).width + 12;
    const labelHeight = 23;
    const labelY = Math.max(0, py - labelHeight);

    context.fillStyle = "#17d895";
    context.fillRect(px, labelY, labelWidth, labelHeight);

    context.fillStyle = "#10251d";
    context.fillText(label, px + 6, labelY + 16);

    if (showHeads) {
      const headWidth = boxWidth * 0.48;
      const headHeight = boxHeight * 0.22;
      const headX = x + (boxWidth - headWidth) / 2;
      const headY = y + boxHeight * 0.025;

      context.lineWidth = 2;
      context.strokeStyle = "#a855f7";
      context.strokeRect(
        rect.x + headX * rect.scale,
        rect.y + headY * rect.scale,
        headWidth * rect.scale,
        headHeight * rect.scale
      );
    }
  }
}

function filterPeople(results, width, height) {
  if (!width || !height) return [];

  return results.filter(item => {
    if (item.class !== "person" || item.score < 0.35) return false;

    const [, , boxWidth, boxHeight] = item.bbox;
    return boxWidth / width < 0.98 && boxHeight / height < 0.99;
  });
}

function currentScanDimensions() {
  if (scanMode === "video") {
    return {
      width: $("scanVideo").videoWidth,
      height: $("scanVideo").videoHeight
    };
  }

  if (scanMode === "gif" && gifFrames.length) {
    return {
      width: gifFrames[0].canvas.width,
      height: gifFrames[0].canvas.height
    };
  }

  return {
    width: $("scanPreview").naturalWidth,
    height: $("scanPreview").naturalHeight
  };
}

function drawScanBoxes() {
  const dimensions = currentScanDimensions();

  drawDetections(
    $("boxCanvas"),
    $("scanStage"),
    dimensions.width,
    dimensions.height,
    detections,
    $("headToggle").checked
  );
}

function drawLiveBoxes() {
  const video = $("liveVideo");

  if (!video.videoWidth || !video.videoHeight) return;

  drawDetections(
    $("liveCanvas"),
    $("liveStage"),
    video.videoWidth,
    video.videoHeight,
    liveDetections,
    $("liveHeadToggle").checked
  );
}

/* Media loading */

function waitForMedia(element, successEvent, failureMessage) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(failureMessage));
    }, 15000);

    function cleanup() {
      clearTimeout(timeout);
      element.removeEventListener(successEvent, onSuccess);
      element.removeEventListener("error", onError);
    }

    function onSuccess() {
      cleanup();
      resolve();
    }

    function onError() {
      cleanup();
      reject(new Error(failureMessage));
    }

    element.addEventListener(successEvent, onSuccess, { once: true });
    element.addEventListener("error", onError, { once: true });
  });
}

function releaseScanUrl() {
  if (scanUrl) URL.revokeObjectURL(scanUrl);
  scanUrl = null;
}

function stopGif() {
  if (gifAnimationId !== null) cancelAnimationFrame(gifAnimationId);
  gifAnimationId = null;
}

/* GIF loading and playback */

async function loadGif(file) {
  if (!window.gifuct) {
    throw new Error("GIF library did not load. Check your internet connection.");
  }

  const parsed = window.gifuct.parseGIF(await file.arrayBuffer());
  const frames = window.gifuct
    .decompressFrames(parsed, true)
    .slice(0, MAX_GIF_FRAMES);

  if (!frames.length) throw new Error("No GIF frames could be read.");

  const width = parsed.lsd.width;
  const height = parsed.lsd.height;
  const composed = document.createElement("canvas");
  composed.width = width;
  composed.height = height;

  const context = composed.getContext("2d");
  gifFrames = [];

  for (const frame of frames) {
    const imageData = new ImageData(
      new Uint8ClampedArray(frame.patch),
      frame.dims.width,
      frame.dims.height
    );

    context.putImageData(imageData, frame.dims.left, frame.dims.top);

    const frameCanvas = document.createElement("canvas");
    frameCanvas.width = width;
    frameCanvas.height = height;
    frameCanvas.getContext("2d").drawImage(composed, 0, 0);

    gifFrames.push({
      canvas: frameCanvas,
      delay: Math.max(30, (frame.delay || 10) * 10)
    });

    if (frame.disposalType === 2) {
      context.clearRect(
        frame.dims.left,
        frame.dims.top,
        frame.dims.width,
        frame.dims.height
      );
    }
  }

  gifTotalDuration = gifFrames.reduce((sum, frame) => sum + frame.delay, 0);
  gifFrameIndex = 0;
  showGifFrame(0);
}

function showGifFrame(index) {
  if (!gifFrames.length) return;

  gifFrameIndex = (index + gifFrames.length) % gifFrames.length;

  const canvas = $("gifCanvas");
  const frame = gifFrames[gifFrameIndex].canvas;

  canvas.width = frame.width;
  canvas.height = frame.height;
  canvas.getContext("2d").drawImage(frame, 0, 0);

  if (scanResultsByTime.length) {
    const time = gifFrames
      .slice(0, gifFrameIndex)
      .reduce((sum, item) => sum + item.delay, 0) / 1000;

    detections = nearestResults(time);
  }

  drawScanBoxes();
  updateMediaControls();
}

function playGif() {
  if (!gifFrames.length || gifAnimationId !== null) return;

  let lastFrame = performance.now();

  function animate(now) {
    if (gifAnimationId === null) return;

    if (now - lastFrame >= gifFrames[gifFrameIndex].delay) {
      lastFrame = now;
      showGifFrame(gifFrameIndex + 1);
    }

    gifAnimationId = requestAnimationFrame(animate);
    updateMediaControls();
  }

  gifAnimationId = requestAnimationFrame(animate);
  updateMediaControls();
}

/* Scan media controls */

function mediaDuration() {
  if (scanMode === "video") {
    const duration = $("scanVideo").duration;
    return Number.isFinite(duration) ? duration : 0;
  }

  return scanMode === "gif" ? gifTotalDuration / 1000 : 0;
}

function mediaCurrentTime() {
  if (scanMode === "video") return $("scanVideo").currentTime || 0;

  if (scanMode === "gif" && gifFrames.length) {
    return gifFrames
      .slice(0, gifFrameIndex)
      .reduce((sum, frame) => sum + frame.delay, 0) / 1000;
  }

  return 0;
}

function updateMediaControls() {
  const duration = mediaDuration();
  const hasMedia = duration > 0 &&
    (scanMode === "video" || scanMode === "gif");

  $("mediaControls").hidden = !hasMedia;
  $("mediaPlayButton").hidden = !hasMedia;

  if (!hasMedia) return;

  const current = Math.min(mediaCurrentTime(), duration);

  $("mediaCurrentTime").textContent = formatTime(current);
  $("mediaDuration").textContent = formatTime(duration);

  if (scanMode === "video") {
    const video = $("scanVideo");
    $("mediaPlayButton").textContent =
      video.paused || video.ended ? "▶" : "❚❚";
  } else {
    $("mediaPlayButton").textContent =
      gifAnimationId === null ? "▶" : "❚❚";
  }

  if (!timelineDragging && duration > 0) {
    $("mediaTimeline").value = String(
      Math.round(current / duration * 1000)
    );
  }
}

function nearestResults(time) {
  if (!scanResultsByTime.length) return [];

  return scanResultsByTime.reduce((best, current) =>
    Math.abs(current.time - time) < Math.abs(best.time - time)
      ? current
      : best
  ).detections;
}

async function loadScanFile(file) {
  releaseScanUrl();
  stopGif();

  gifFrames = [];
  gifFrameIndex = 0;
  gifTotalDuration = 0;
  scanResultsByTime = [];
  detections = [];
  scanFile = file;
  predictionLabel = null;
  scanUrl = URL.createObjectURL(file);

  $("scanPreview").classList.remove("visible");
  $("scanVideo").classList.remove("visible");
  $("gifCanvas").classList.remove("visible");
  $("scanPlaceholder").hidden = true;
  $("mediaControls").hidden = true;
  $("mediaPlayButton").hidden = true;
  $("correctButton").disabled = true;
  $("incorrectButton").disabled = true;
  $("confidence").textContent = "";

  const isVideo =
    file.type.startsWith("video/") ||
    /\.(mp4|webm|mov|m4v|ogv)$/i.test(file.name);

  const isGif = file.type === "image/gif" || /\.gif$/i.test(file.name);

  try {
    if (isVideo) {
      scanMode = "video";

      const video = $("scanVideo");
      video.pause();
      video.src = scanUrl;
      video.load();

      await waitForMedia(
        video,
        "loadedmetadata",
        "Could not load video metadata."
      );

      await waitForMedia(
        video,
        "loadeddata",
        "Could not read a video frame."
      );

      video.currentTime = 0;
      video.classList.add("visible");
    } else if (isGif) {
      scanMode = "gif";
      await loadGif(file);
      $("gifCanvas").classList.add("visible");
    } else {
      scanMode = "image";

      const image = $("scanPreview");
      image.src = scanUrl;

      await waitForMedia(image, "load", "Could not load this image.");
      image.classList.add("visible");
    }

    $("prediction").textContent = "Ready to scan";
    setStatus("File ready. Press Scan image or video.");
    updateMediaControls();
    drawScanBoxes();
  } catch (error) {
    $("scanPlaceholder").hidden = false;
    $("prediction").textContent = "Could not load file";
    setStatus(error.message);
  }
}

$("scanInput").addEventListener("change", event => {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (file) loadScanFile(file);
});

$("mediaPlayButton").addEventListener("click", async () => {
  if (scanMode === "video") {
    const video = $("scanVideo");

    try {
      if (video.paused) await video.play();
      else video.pause();
    } catch (error) {
      setStatus(`Could not play video: ${error.message}`);
    }

    updateMediaControls();
  } else if (scanMode === "gif") {
    if (gifAnimationId === null) playGif();
    else stopGif();

    updateMediaControls();
  }
});

$("scanVideo").addEventListener("play", updateMediaControls);
$("scanVideo").addEventListener("pause", updateMediaControls);
$("scanVideo").addEventListener("ended", updateMediaControls);

$("scanVideo").addEventListener("timeupdate", () => {
  updateMediaControls();

  if (scanResultsByTime.length) {
    detections = nearestResults($("scanVideo").currentTime);
    drawScanBoxes();
  }
});

$("mediaTimeline").addEventListener("input", () => {
  timelineDragging = true;

  const time = Number($("mediaTimeline").value) / 1000 * mediaDuration();
  $("mediaCurrentTime").textContent = formatTime(time);

  if (scanMode === "video") {
    $("scanVideo").currentTime = time;
  } else if (scanMode === "gif" && gifFrames.length) {
    let elapsed = 0;
    let index = 0;

    while (
      index < gifFrames.length - 1 &&
      elapsed + gifFrames[index].delay < time * 1000
    ) {
      elapsed += gifFrames[index].delay;
      index++;
    }

    showGifFrame(index);
  }
});

$("mediaTimeline").addEventListener("change", () => {
  timelineDragging = false;
  updateMediaControls();
});

/* Scanning */

async function detectScanSource(source) {
  const dimensions = currentScanDimensions();
  const predictions = await detector.detect(source, 20, 0.25);

  return filterPeople(predictions, dimensions.width, dimensions.height);
}

async function seekTo(video, time) {
  if (Math.abs(video.currentTime - time) < 0.02 && video.readyState >= 2) {
    return;
  }

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      video.removeEventListener("seeked", onSeeked);
      reject(new Error("Timed out seeking to a video frame."));
    }, 5000);

    function onSeeked() {
      clearTimeout(timeout);
      resolve();
    }

    video.addEventListener("seeked", onSeeked, { once: true });
    video.currentTime = time;
  });
}

async function scanVideo() {
  const video = $("scanVideo");
  const duration = video.duration;

  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("Video duration is unavailable.");
  }

  const frameCount = Math.min(
    MAX_VIDEO_FRAMES,
    Math.max(1, Math.floor(duration * 1.5))
  );

  const started = performance.now();
  const resultsByTime = [];

  video.pause();

  for (let index = 0; index < frameCount; index++) {
    if (performance.now() - started > MAX_VIDEO_SCAN_MS) break;

    const time = frameCount === 1
      ? 0
      : index / (frameCount - 1) * Math.max(0, duration - 0.05);

    await seekTo(video, time);

    const frameDetections = await detectScanSource(video);

    resultsByTime.push({ time, detections: frameDetections });
    detections = frameDetections;
    drawScanBoxes();

    const percent = Math.round((index + 1) / frameCount * 100);
    $("progressArea").hidden = false;
    $("progressBar").style.width = `${percent}%`;
    $("progressText").textContent =
      `Scanning video frame ${index + 1} of ${frameCount}…`;

    await new Promise(resolve => setTimeout(resolve, 0));
  }

  scanResultsByTime = resultsByTime;
  await seekTo(video, 0);

  return resultsByTime.flatMap(item => item.detections);
}

async function scanGifFrames() {
  const resultsByTime = [];
  const step = Math.max(1, Math.ceil(gifFrames.length / MAX_GIF_FRAMES));

  stopGif();

  for (let index = 0; index < gifFrames.length; index += step) {
    showGifFrame(index);

    const frameDetections = await detectScanSource($("gifCanvas"));
    const time = gifFrames
      .slice(0, index)
      .reduce((sum, frame) => sum + frame.delay, 0) / 1000;

    resultsByTime.push({ time, detections: frameDetections });
    detections = frameDetections;
    drawScanBoxes();

    $("progressArea").hidden = false;
    $("progressBar").style.width =
      `${Math.round((index + 1) / gifFrames.length * 100)}%`;
    $("progressText").textContent = `Scanning GIF frame ${index + 1}…`;

    await new Promise(resolve => setTimeout(resolve, 0));
  }

  scanResultsByTime = resultsByTime;
  return resultsByTime.flatMap(item => item.detections);
}

$("scanButton").addEventListener("click", async () => {
  if (scanBusy) return;

  if (!scanFile) {
    setStatus("Choose an image, GIF, or video first.");
    return;
  }

  if (!modelsReady) {
    setStatus("AI models are still loading. Please wait.");
    return;
  }

  scanBusy = true;
  $("scanButton").disabled = true;
  $("prediction").textContent = "Scanning…";
  $("progressArea").hidden = false;
  $("progressBar").style.width = "0%";
  $("progressText").textContent = "Preparing scan…";
  $("correctButton").disabled = true;
  $("incorrectButton").disabled = true;

  try {
    let results;

    if (scanMode === "video") {
      results = await scanVideo();
    } else if (scanMode === "gif") {
      results = await scanGifFrames();
    } else {
      results = await detectScanSource($("scanPreview"));
      detections = results;
      drawScanBoxes();
    }

    if (results.length) {
      predictionLabel = "person";

      const confidence = Math.max(...results.map(item => item.score));
      $("prediction").textContent =
        `${results.length} person detection${results.length === 1 ? "" : "s"} found`;
      $("confidence").textContent =
        `Highest box confidence: ${(confidence * 100).toFixed(0)}%`;
    } else {
      predictionLabel = "not-person";
      $("prediction").textContent = "No person detected";
      $("confidence").textContent = "";
    }

    if (scanMode === "image") {
      $("correctButton").disabled = false;
      $("incorrectButton").disabled = false;
    }

    $("progressBar").style.width = "100%";
    $("progressText").textContent = "Scan complete.";
    setStatus("Scan complete.");
  } catch (error) {
    console.error(error);
    $("prediction").textContent = "Scan failed";
    $("progressText").textContent = error.message;
    setStatus(`Scan failed: ${error.message}`);
  } finally {
    scanBusy = false;
    $("scanButton").disabled = false;
    updateMediaControls();
  }
});

$("headToggle").addEventListener("change", drawScanBoxes);

/* Feedback */

async function saveFeedback(wasCorrect) {
  if (!scanFile || !predictionLabel || scanMode !== "image") return;

  const label = wasCorrect
    ? predictionLabel
    : predictionLabel === "person" ? "not-person" : "person";

  try {
    const form = new FormData();
    form.append("image", scanFile);

    await apiRequest(
      `/api/feedback/image?label=${encodeURIComponent(label)}`,
      { method: "POST", body: form }
    );

    await apiRequest("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image: scanFile.name,
        prediction: predictionLabel,
        correctLabel: label,
        correct: wasCorrect
      })
    });

    $("feedbackNote").textContent =
      `Feedback saved to the ${label === "person" ? "Person" : "Not Person"} folder.`;

    $("correctButton").disabled = true;
    $("incorrectButton").disabled = true;
    setStatus("Feedback saved.");
  } catch (error) {
    setStatus(`Could not save feedback: ${error.message}`);
  }
}

$("correctButton").addEventListener("click", () => saveFeedback(true));
$("incorrectButton").addEventListener("click", () => saveFeedback(false));

/* Image search */

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not load image."));
    image.src = url;
  });
}

$("searchInput").addEventListener("change", event => {
  searchFile = event.target.files?.[0] || null;
  event.target.value = "";

  $("searchResults").replaceChildren();
  $("searchMessage").textContent = "";

  if (!searchFile) return;

  const preview = $("searchPreview");

  if (preview.dataset.url) URL.revokeObjectURL(preview.dataset.url);

  preview.dataset.url = URL.createObjectURL(searchFile);
  preview.src = preview.dataset.url;
  preview.classList.add("visible");
  $("searchPlaceholder").hidden = true;
});

$("searchButton").addEventListener("click", async () => {
  if (!searchFile) {
    $("searchMessage").textContent = "Choose an image first.";
    return;
  }

  if (!modelsReady) {
    $("searchMessage").textContent = "AI models are still loading.";
    return;
  }

  $("searchButton").disabled = true;
  $("searchResults").replaceChildren();
  $("searchMessage").textContent = "Searching…";

  let queryEmbedding = null;

  try {
    const preview = $("searchPreview");
    const predictions = await detector.detect(preview, 10, 0.3);

    if (!predictions.some(item => item.class === "person")) {
      $("searchMessage").textContent = "No person was detected in that image.";
      return;
    }

    queryEmbedding = mobileNetModel.infer(preview, true);

    const collections = await apiRequest("/api/images");
    const matches = [];

    for (const item of collections.person || []) {
      let embedding = null;

      try {
        const image = await loadImage(item.url);
        embedding = mobileNetModel.infer(image, true);

        const similarity = tf.tidy(() => {
          const first = queryEmbedding.flatten();
          const second = embedding.flatten();

          return tf.sum(tf.mul(first, second))
            .div(tf.norm(first).mul(tf.norm(second)))
            .dataSync()[0];
        });

        matches.push({
          ...item,
          similarity: Number.isFinite(similarity) ? similarity : -1
        });
      } catch (error) {
        console.warn("Skipping image:", item.name, error);
      } finally {
        if (embedding) embedding.dispose();
      }
    }

    matches.sort((a, b) => b.similarity - a.similarity);

    const bestMatches = matches.slice(0, 3);
    const results = $("searchResults");

    if (!bestMatches.length) {
      $("searchMessage").textContent = "No saved Person images found.";
      return;
    }

    for (const match of bestMatches) {
      const card = document.createElement("article");
      card.className = "match-card";

      const image = document.createElement("img");
      image.src = match.url;
      image.alt = `Similar image: ${match.name}`;

      const details = document.createElement("div");
      details.className = "match-details";

      const name = document.createElement("strong");
      name.textContent = match.name;

      const score = document.createElement("span");
      score.textContent =
        `Visual similarity: ${(match.similarity * 100).toFixed(1)}%`;

      details.append(name, score);
      card.append(image, details);
      results.append(card);
    }

    $("searchMessage").textContent =
      "Top matches from your Person collection:";
  } catch (error) {
    $("searchMessage").textContent = `Search failed: ${error.message}`;
  } finally {
    if (queryEmbedding) queryEmbedding.dispose();
    $("searchButton").disabled = false;
  }
});

/* Live camera */

async function startCamera() {
  if (liveRunning) return;

  if (!navigator.mediaDevices?.getUserMedia) {
    setLiveStatus("Camera needs HTTPS or the installed desktop app.");
    return;
  }

  if (!modelsReady) {
    setLiveStatus("AI models are still loading. Please wait.");
    return;
  }

  $("startCameraButton").disabled = true;
  setLiveStatus("Requesting camera permission…");

  try {
    liveStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: "user",
        width: { ideal: 640 },
        height: { ideal: 480 }
      }
    });

    const video = $("liveVideo");
    video.srcObject = liveStream;

    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = () => reject(new Error("Could not load webcam video."));
    });

    await video.play();

    liveRunning = true;
    liveDetections = [];
    lastLiveDetection = 0;

    video.classList.add("visible");
    $("livePlaceholder").hidden = true;
    $("stopCameraButton").disabled = false;
    $("startRecordingButton").disabled = !window.MediaRecorder;

    setLiveStatus("Camera on. Detecting people locally.");
    liveTick();
  } catch (error) {
    console.error(error);

    if (liveStream) {
      liveStream.getTracks().forEach(track => track.stop());
      liveStream = null;
    }

    $("liveVideo").srcObject = null;
    $("liveVideo").classList.remove("visible");
    $("livePlaceholder").hidden = false;
    $("startCameraButton").disabled = false;
    $("stopCameraButton").disabled = true;
    $("startRecordingButton").disabled = true;

    setLiveStatus(
      error.name === "NotAllowedError"
        ? "Camera access denied. Allow webcam permission and try again."
        : `Could not start camera: ${error.message}`
    );
  }
}

function liveTick() {
  if (!liveRunning) return;

  liveLoopId = requestAnimationFrame(liveTick);

  if (
    liveBusy ||
    performance.now() - lastLiveDetection < LIVE_DETECTION_INTERVAL
  ) {
    return;
  }

  const video = $("liveVideo");
  if (!video.videoWidth || video.readyState < 2) return;

  liveBusy = true;
  lastLiveDetection = performance.now();

  detector.detect(video, 10, 0.3)
    .then(results => {
      if (!liveRunning) return;

      liveDetections = filterPeople(
        results,
        video.videoWidth,
        video.videoHeight
      );

      drawLiveBoxes();

      setLiveStatus(
        liveDetections.length
          ? `${liveDetections.length} person${liveDetections.length === 1 ? "" : "s"} detected`
          : "Camera on. No people detected."
      );
    })
    .catch(error => {
      console.error(error);
      setLiveStatus(`Detection error: ${error.message}`);
    })
    .finally(() => {
      liveBusy = false;
    });
}

function stopCamera() {
  liveRunning = false;

  if (liveLoopId !== null) cancelAnimationFrame(liveLoopId);
  liveLoopId = null;
  liveBusy = false;

  if (liveStream) {
    liveStream.getTracks().forEach(track => track.stop());
    liveStream = null;
  }

  const video = $("liveVideo");
  video.pause();
  video.srcObject = null;
  video.classList.remove("visible");

  liveDetections = [];

  const canvas = $("liveCanvas");
  canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);

  $("livePlaceholder").hidden = false;
  $("startCameraButton").disabled = false;
  $("stopCameraButton").disabled = true;
  $("startRecordingButton").disabled = true;

  if (mediaRecorder?.state === "recording") stopRecording();

  setLiveStatus("Camera is off.");
}

/* Recording with detection boxes included */

function supportedRecordingFormat() {
  if (!window.MediaRecorder) return null;

  const types = [
    { mimeType: "video/mp4;codecs=avc1.42E01E", extension: "mp4" },
    { mimeType: "video/mp4", extension: "mp4" },
    { mimeType: "video/webm;codecs=vp9", extension: "webm" },
    { mimeType: "video/webm;codecs=vp8", extension: "webm" },
    { mimeType: "video/webm", extension: "webm" }
  ];

  return types.find(type => MediaRecorder.isTypeSupported(type.mimeType)) || null;
}

function drawRecordingFrame() {
  if (!recordingCanvas || !recordingCanvasContext) return;

  const video = $("liveVideo");
  const width = video.videoWidth;
  const height = video.videoHeight;

  if (width && height) {
    if (recordingCanvas.width !== width || recordingCanvas.height !== height) {
      recordingCanvas.width = width;
      recordingCanvas.height = height;
    }

    recordingCanvasContext.clearRect(0, 0, width, height);

    // Mirror the camera image like the live preview.
    recordingCanvasContext.save();
    recordingCanvasContext.translate(width, 0);
    recordingCanvasContext.scale(-1, 1);
    recordingCanvasContext.drawImage(video, 0, 0, width, height);
    recordingCanvasContext.restore();

    // Detection coordinates are in the original, unmirrored camera frame.
    for (const result of liveDetections) {
      const [x, y, boxWidth, boxHeight] = result.bbox;
      const mirroredX = width - x - boxWidth;

      recordingCanvasContext.lineWidth = Math.max(3, width / 320);
      recordingCanvasContext.strokeStyle = "#17d895";
      recordingCanvasContext.strokeRect(
        mirroredX,
        y,
        boxWidth,
        boxHeight
      );

      const label = `Person ${(result.score * 100).toFixed(0)}%`;
      const fontSize = Math.max(14, width / 50);
      const labelHeight = Math.max(25, width / 45);

      recordingCanvasContext.font =
        `bold ${fontSize}px system-ui, sans-serif`;

      const labelWidth =
        recordingCanvasContext.measureText(label).width + 12;
      const labelY = Math.max(0, y - labelHeight);

      recordingCanvasContext.fillStyle = "#17d895";
      recordingCanvasContext.fillRect(
        mirroredX,
        labelY,
        labelWidth,
        labelHeight
      );

      recordingCanvasContext.fillStyle = "#10251d";
      recordingCanvasContext.fillText(
        label,
        mirroredX + 6,
        labelY + labelHeight * 0.72
      );

      if ($("liveHeadToggle").checked) {
        const headWidth = boxWidth * 0.48;
        const headHeight = boxHeight * 0.22;
        const headX =
          width - (x + (boxWidth - headWidth) / 2) - headWidth;
        const headY = y + boxHeight * 0.025;

        recordingCanvasContext.lineWidth = Math.max(2, width / 500);
        recordingCanvasContext.strokeStyle = "#a855f7";
        recordingCanvasContext.strokeRect(
          headX,
          headY,
          headWidth,
          headHeight
        );
      }
    }
  }

  recordingDrawLoop = requestAnimationFrame(drawRecordingFrame);
}

function startRecording() {
  if (!liveStream || !liveRunning) {
    $("recordingStatus").textContent = "Start the camera first.";
    return;
  }

  if (!window.MediaRecorder ||
      !HTMLCanvasElement.prototype.captureStream) {
    $("recordingStatus").textContent =
      "Recording with hitboxes is not supported in this browser.";
    return;
  }

  const format = supportedRecordingFormat();

  if (!format) {
    $("recordingStatus").textContent =
      "This browser does not support MP4 or WebM recording.";
    return;
  }

  try {
    if (recordingUrl) URL.revokeObjectURL(recordingUrl);

    recordingChunks = [];
    recordingUrl = null;
    $("recordingDownload").hidden = true;

    recordingCanvas = document.createElement("canvas");
    recordingCanvas.width = $("liveVideo").videoWidth || 640;
    recordingCanvas.height = $("liveVideo").videoHeight || 480;
    recordingCanvasContext = recordingCanvas.getContext("2d");

    // Record the canvas composite, which contains both video and boxes.
    recordingCanvasStream = recordingCanvas.captureStream(30);

    mediaRecorder = new MediaRecorder(
      recordingCanvasStream,
      { mimeType: format.mimeType }
    );

    mediaRecorder.addEventListener("dataavailable", event => {
      if (event.data && event.data.size > 0) {
        recordingChunks.push(event.data);
      }
    });

    mediaRecorder.addEventListener("stop", () => {
      if (recordingDrawLoop !== null) {
        cancelAnimationFrame(recordingDrawLoop);
      }

      recordingDrawLoop = null;

      if (recordingCanvasStream) {
        recordingCanvasStream.getTracks().forEach(track => track.stop());
      }

      recordingCanvasStream = null;

      if (!recordingChunks.length) {
        $("recordingStatus").textContent =
          "No recording data was captured.";
      } else {
        const blob = new Blob(recordingChunks, {
          type: format.mimeType
        });

        recordingUrl = URL.createObjectURL(blob);

        const link = $("recordingDownload");
        const timestamp = new Date()
          .toISOString()
          .replace(/[:.]/g, "-");

        link.href = recordingUrl;
        link.download = `webcam-${timestamp}.${format.extension}`;
        link.textContent =
          `Download ${format.extension.toUpperCase()} recording`;
        link.hidden = false;

        $("recordingStatus").textContent =
          "Recording ready. Detection boxes are included.";
      }

      recordingCanvas = null;
      recordingCanvasContext = null;

      clearTimeout(recordingTimer);
      clearInterval(recordingClock);

      $("startRecordingButton").disabled = !liveRunning;
      $("stopRecordingButton").disabled = true;
    });

    mediaRecorder.addEventListener("error", event => {
      $("recordingStatus").textContent =
        `Recording error: ${event.error?.message || "unknown error"}`;
    });

    drawRecordingFrame();
    mediaRecorder.start(1000);

    recordingStartedAt = Date.now();
    $("startRecordingButton").disabled = true;
    $("stopRecordingButton").disabled = false;
    $("recordingStatus").textContent = "Recording: 0:00";

    recordingClock = setInterval(() => {
      const seconds = Math.floor(
        (Date.now() - recordingStartedAt) / 1000
      );

      $("recordingStatus").textContent =
        `Recording: ${formatTime(seconds)}`;
    }, 1000);

    recordingTimer = setTimeout(() => {
      if (mediaRecorder?.state === "recording") stopRecording();
    }, MAX_RECORDING_MS);
  } catch (error) {
    console.error(error);

    if (recordingCanvasStream) {
      recordingCanvasStream.getTracks().forEach(track => track.stop());
    }

    recordingCanvasStream = null;
    recordingCanvas = null;
    recordingCanvasContext = null;

    $("recordingStatus").textContent =
      `Could not start recording: ${error.message}`;
    $("startRecordingButton").disabled = !liveRunning;
    $("stopRecordingButton").disabled = true;
  }
}

function stopRecording() {
  clearTimeout(recordingTimer);
  clearInterval(recordingClock);

  if (mediaRecorder?.state === "recording") {
    $("recordingStatus").textContent = "Finishing recording…";
    mediaRecorder.stop();
  } else {
    $("stopRecordingButton").disabled = true;
  }
}

/* Full screen */

async function toggleFullscreen() {
  const liveCard = document.querySelector(".live-card");

  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else if (liveCard.requestFullscreen) {
      await liveCard.requestFullscreen();
    }
  } catch (error) {
    setLiveStatus(`Could not enter full screen: ${error.message}`);
  }
}

$("fullscreenButton").addEventListener("click", toggleFullscreen);

document.addEventListener("fullscreenchange", () => {
  $("fullscreenButton").textContent = document.fullscreenElement
    ? "⛶ Exit full screen"
    : "⛶ Full screen";

  requestAnimationFrame(() => {
    drawLiveBoxes();
    drawScanBoxes();
  });
});

/* Connect buttons */

$("startCameraButton").addEventListener("click", startCamera);
$("stopCameraButton").addEventListener("click", stopCamera);
$("startRecordingButton").addEventListener("click", startRecording);
$("stopRecordingButton").addEventListener("click", stopRecording);
$("liveHeadToggle").addEventListener("change", drawLiveBoxes);

/* Resize and cleanup */

window.addEventListener("resize", () => {
  drawLiveBoxes();
  drawScanBoxes();
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden && liveRunning) stopCamera();
});

window.addEventListener("pagehide", () => {
  stopCamera();
  stopGif();

  if (scanUrl) URL.revokeObjectURL(scanUrl);
  if (recordingUrl) URL.revokeObjectURL(recordingUrl);

  const searchPreview = $("searchPreview");
  if (searchPreview.dataset.url) {
    URL.revokeObjectURL(searchPreview.dataset.url);
  }
});

/* Load models */

async function loadModels() {
  try {
    setStatus("Loading AI models…");

    if (!window.tf || !window.cocoSsd || !window.mobilenet) {
      throw new Error(
        "AI scripts did not load. Check your internet connection."
      );
    }

    [detector, mobileNetModel] = await Promise.all([
      window.cocoSsd.load(),
      window.mobilenet.load({ version: 2, alpha: 1.0 })
    ]);

    modelsReady = true;
    setStatus("Ready.");
    setLiveStatus("Camera is off. Press Start camera when ready.");
  } catch (error) {
    console.error(error);
    setStatus(`Model loading failed: ${error.message}`);
    setLiveStatus(`Detection model unavailable: ${error.message}`);
  }
}

/* Initialize */

setupThemeAndTabs();
setupUploader("personInput", "personDrop", "person");
setupUploader("otherInput", "otherDrop", "not-person");
loadModels();

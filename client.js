"use strict";

let detector = null;
let mobileNetModel = null;

let scanFile = null;
let searchFile = null;
let predictionLabel = null;
let detections = [];
let scanMode = "image";
let scanUrl = null;
let scanBusy = false;

let gifFrames = [];
let gifFrameIndex = 0;
let gifAnimationId = null;
let gifTotalDuration = 0;
let scanResultsByTime = [];
let timelineDragging = false;

let liveStream = null;
let liveRunning = false;
let liveBusy = false;
let liveAnimationId = null;
let liveFrameCallbackId = null;
let liveLastInference = 0;
let liveDetections = [];

let mediaRecorder = null;
let recordingChunks = [];
let recordingTimeout = null;
let recordingClock = null;
let recordingUrl = null;
let recordingStartedAt = 0;

const MAX_SCAN_MS = 30000;
const MAX_VIDEO_FRAMES = 45;
const MAX_GIF_FRAMES = 60;
const LIVE_MIN_INTERVAL_MS = 250;
const MAX_RECORDING_MS = 2 * 60 * 60 * 1000;

const $ = id => document.getElementById(id);

async function request(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(body.error || `Request failed (${response.status})`);
  }

  return body;
}

function setStatus(message) {
  const status = $("status");
  if (status) status.textContent = message;
}

function setProgress(message, percent = null) {
  $("progressArea").hidden = false;
  $("progressText").textContent = message;

  const bar = $("progressBar");
  if (percent === null) {
    bar.classList.add("busy");
    bar.style.width = "";
  } else {
    bar.classList.remove("busy");
    bar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  }
}

function isVideoFile(file) {
  return file.type.startsWith("video/") ||
    /\.(mp4|webm|mov|m4v|ogv)$/i.test(file.name);
}

function isGifFile(file) {
  return file.type === "image/gif" || /\.gif$/i.test(file.name);
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;

  return `${Math.floor(seconds / 60)}:${String(
    Math.floor(seconds % 60)
  ).padStart(2, "0")}`;
}

/* Scan preview and detection boxes */

function getScanSourceDimensions() {
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

function getContainedRect(stage, width, height) {
  if (!width || !height || !stage.clientWidth || !stage.clientHeight) {
    return null;
  }

  const scale = Math.min(
    stage.clientWidth / width,
    stage.clientHeight / height
  );

  return {
    x: (stage.clientWidth - width * scale) / 2,
    y: (stage.clientHeight - height * scale) / 2,
    scale
  };
}

function estimatedHeadBox(bbox) {
  const [x, y, width, height] = bbox;
  const headWidth = width * 0.48;
  const headHeight = height * 0.22;

  return [
    x + (width - headWidth) / 2,
    y + height * 0.025,
    headWidth,
    headHeight
  ];
}

function drawBoxesOnCanvas(
  canvas,
  stage,
  sourceWidth,
  sourceHeight,
  results,
  showHeads
) {
  const dpr = window.devicePixelRatio || 1;
  const stageWidth = stage.clientWidth;
  const stageHeight = stage.clientHeight;

  canvas.width = Math.round(stageWidth * dpr);
  canvas.height = Math.round(stageHeight * dpr);
  canvas.style.width = `${stageWidth}px`;
  canvas.style.height = `${stageHeight}px`;

  const context = canvas.getContext("2d");
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, stageWidth, stageHeight);

  const contained = getContainedRect(stage, sourceWidth, sourceHeight);
  if (!contained) return;

  for (const result of results) {
    const [x, y, width, height] = result.bbox;
    const px = contained.x + x * contained.scale;
    const py = contained.y + y * contained.scale;
    const pw = width * contained.scale;
    const ph = height * contained.scale;

    context.lineWidth = 3;
    context.strokeStyle = "#17d895";
    context.strokeRect(px, py, pw, ph);

    const label = `Person ${(result.score * 100).toFixed(0)}%`;
    context.font = "bold 13px system-ui, sans-serif";

    const labelWidth = context.measureText(label).width + 12;
    const labelY = Math.max(0, py - 23);

    context.fillStyle = "#17d895";
    context.fillRect(px, labelY, labelWidth, 23);

    context.fillStyle = "#10251d";
    context.fillText(label, px + 6, labelY + 16);

    if (showHeads) {
      const [hx, hy, hw, hh] = estimatedHeadBox(result.bbox);
      const sx = contained.x + hx * contained.scale;
      const sy = contained.y + hy * contained.scale;
      const sw = hw * contained.scale;
      const sh = hh * contained.scale;

      context.lineWidth = 2.5;
      context.strokeStyle = "#a855f7";
      context.strokeRect(sx, sy, sw, sh);

      context.fillStyle = "#a855f7";
      context.fillRect(sx, Math.max(0, sy - 20), 54, 20);

      context.fillStyle = "#fff";
      context.font = "bold 12px system-ui, sans-serif";
      context.fillText("Head*", sx + 6, Math.max(14, sy - 6));
    }
  }
}

function drawScanBoxes() {
  const { width, height } = getScanSourceDimensions();

  drawBoxesOnCanvas(
    $("boxCanvas"),
    $("scanStage"),
    width,
    height,
    detections,
    $("headToggle").checked
  );
}

function clearScanBoxes() {
  detections = [];

  const canvas = $("boxCanvas");
  canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
}

function intersectionOverUnion(first, second) {
  const [ax, ay, aw, ah] = first.bbox;
  const [bx, by, bw, bh] = second.bbox;

  const left = Math.max(ax, bx);
  const top = Math.max(ay, by);
  const right = Math.min(ax + aw, bx + bw);
  const bottom = Math.min(ay + ah, by + bh);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const union = aw * ah + bw * bh - intersection;

  return union > 0 ? intersection / union : 0;
}

function filterPersonDetections(results, width, height) {
  if (!width || !height) return [];

  const frameArea = width * height;

  const candidates = results.filter(result => {
    if (result.class !== "person" || result.score < 0.4) return false;

    const [, , boxWidth, boxHeight] = result.bbox;
    const areaRatio = (boxWidth * boxHeight) / frameArea;

    return areaRatio < 0.72 &&
      boxWidth / width < 0.92 &&
      boxHeight / height < 0.97;
  });

  const kept = [];

  for (const result of candidates.sort((a, b) => b.score - a.score)) {
    if (!kept.some(other => intersectionOverUnion(other, result) > 0.5)) {
      kept.push(result);
    }
  }

  return kept;
}

async function detectPersonObjects(source) {
  if (!detector) {
    throw new Error("The person-detection model is not ready.");
  }

  const { width, height } = getScanSourceDimensions();
  const results = await detector.detect(source, 20, 0.25);

  return filterPersonDetections(results, width, height);
}

/* Media loading and playback */

function waitForEvent(target, eventName) {
  return new Promise((resolve, reject) => {
    const onSuccess = () => {
      cleanup();
      resolve();
    };

    const onError = () => {
      cleanup();
      reject(new Error(`Could not load ${eventName}.`));
    };

    function cleanup() {
      target.removeEventListener(eventName, onSuccess);
      target.removeEventListener("error", onError);
    }

    target.addEventListener(eventName, onSuccess, { once: true });
    target.addEventListener("error", onError, { once: true });
  });
}

function waitForVideoFrame(video) {
  if (video.readyState >= 2) return Promise.resolve();

  return Promise.race([
    waitForEvent(video, "loadeddata"),
    new Promise((_, reject) => {
      setTimeout(
        () => reject(new Error("Timed out waiting for a video frame.")),
        4000
      );
    })
  ]);
}

function seekVideo(video, time) {
  if (Math.abs(video.currentTime - time) < 0.025 && video.readyState >= 2) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out seeking video frame."));
    }, 4000);

    const onSeeked = () => {
      cleanup();
      resolve();
    };

    const onError = () => {
      cleanup();
      reject(new Error("Video could not be decoded."));
    };

    function cleanup() {
      clearTimeout(timeout);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
    }

    video.addEventListener("seeked", onSeeked, { once: true });
    video.addEventListener("error", onError, { once: true });
    video.currentTime = time;
  });
}

function stopGifPlayback() {
  if (gifAnimationId !== null) {
    cancelAnimationFrame(gifAnimationId);
  }

  gifAnimationId = null;
}

function getMediaDuration() {
  if (scanMode === "video") {
    const duration = $("scanVideo").duration;
    return Number.isFinite(duration) ? duration : 0;
  }

  return scanMode === "gif" ? gifTotalDuration / 1000 : 0;
}

function getCurrentMediaTime() {
  if (scanMode === "video") {
    return $("scanVideo").currentTime || 0;
  }

  if (scanMode === "gif" && gifFrames.length) {
    let elapsed = 0;

    for (let index = 0; index < gifFrameIndex; index++) {
      elapsed += gifFrames[index].delay;
    }

    return elapsed / 1000;
  }

  return 0;
}

function updateMediaControls() {
  const duration = getMediaDuration();

  const hasMedia =
    (scanMode === "video" && duration > 0) ||
    (scanMode === "gif" && gifFrames.length > 0);

  $("mediaControls").hidden = !hasMedia;

  const playButton = $("mediaPlayButton");
  playButton.hidden = !hasMedia;

  const playing =
    scanMode === "video"
      ? !$("scanVideo").paused && !$("scanVideo").ended
      : scanMode === "gif" && gifAnimationId !== null;

  playButton.textContent = playing ? "❚❚" : "▶";
  playButton.setAttribute(
    "aria-label",
    playing ? "Pause media" : "Play media"
  );

  if (!hasMedia) return;

  const time = Math.min(getCurrentMediaTime(), duration);

  $("mediaCurrentTime").textContent = formatTime(time);
  $("mediaDuration").textContent = formatTime(duration);

  if (!timelineDragging && duration > 0) {
    $("mediaTimeline").value = String(Math.round((time / duration) * 1000));
  }
}

function closestDetectionsToTime(time) {
  if (!scanResultsByTime.length) return [];

  let closest = scanResultsByTime[0];

  for (const item of scanResultsByTime) {
    if (Math.abs(item.time - time) < Math.abs(closest.time - time)) {
      closest = item;
    }
  }

  return closest.detections;
}

function drawGifFrame(index) {
  if (!gifFrames.length) return;

  gifFrameIndex = (index + gifFrames.length) % gifFrames.length;

  const frame = gifFrames[gifFrameIndex];
  const canvas = $("gifCanvas");

  canvas.width = frame.canvas.width;
  canvas.height = frame.canvas.height;
  canvas.getContext("2d").drawImage(frame.canvas, 0, 0);

  let elapsed = 0;

  for (let position = 0; position < gifFrameIndex; position++) {
    elapsed += gifFrames[position].delay;
  }

  detections = closestDetectionsToTime(elapsed / 1000);
  drawScanBoxes();
  updateMediaControls();
}

function playGif() {
  if (!gifFrames.length || gifAnimationId !== null) return;

  let lastFrameTime = performance.now();

  const animate = now => {
    if (gifAnimationId === null) return;

    const delay = Math.max(20, gifFrames[gifFrameIndex].delay);

    if (now - lastFrameTime >= delay) {
      lastFrameTime = now;
      drawGifFrame(gifFrameIndex + 1);
    }

    gifAnimationId = requestAnimationFrame(animate);
    updateMediaControls();
  };

  gifAnimationId = requestAnimationFrame(animate);
  updateMediaControls();
}

async function decodeGif(file) {
  if (!window.gifuct) {
    throw new Error("GIF decoder did not load. Check your internet connection.");
  }

  const parsed = window.gifuct.parseGIF(await file.arrayBuffer());
  const decodedFrames = window.gifuct
    .decompressFrames(parsed, true)
    .slice(0, MAX_GIF_FRAMES);

  if (!decodedFrames.length) {
    throw new Error("The GIF contains no readable frames.");
  }

  const width = parsed.lsd.width;
  const height = parsed.lsd.height;

  const composed = document.createElement("canvas");
  composed.width = width;
  composed.height = height;

  const composedContext = composed.getContext("2d");

  const previous = document.createElement("canvas");
  previous.width = width;
  previous.height = height;

  const previousContext = previous.getContext("2d");

  gifFrames = [];

  for (const frame of decodedFrames) {
    if (frame.disposalType === 3) {
      previousContext.clearRect(0, 0, width, height);
      previousContext.drawImage(composed, 0, 0);
    }

    const patch = new ImageData(
      new Uint8ClampedArray(frame.patch),
      frame.dims.width,
      frame.dims.height
    );

    composedContext.putImageData(
      patch,
      frame.dims.left,
      frame.dims.top
    );

    const output = document.createElement("canvas");
    output.width = width;
    output.height = height;
    output.getContext("2d").drawImage(composed, 0, 0);

    gifFrames.push({
      canvas: output,
      delay: Math.max(20, (frame.delay || 10) * 10)
    });

    if (frame.disposalType === 2) {
      composedContext.clearRect(
        frame.dims.left,
        frame.dims.top,
        frame.dims.width,
        frame.dims.height
      );
    } else if (frame.disposalType === 3) {
      composedContext.clearRect(0, 0, width, height);
      composedContext.drawImage(previous, 0, 0);
    }
  }

  gifTotalDuration = gifFrames.reduce((sum, frame) => sum + frame.delay, 0);
  gifFrameIndex = 0;
  drawGifFrame(0);
}

function clearOldScanUrl() {
  if (scanUrl) {
    URL.revokeObjectURL(scanUrl);
    scanUrl = null;
  }
}

function resetScanFile(file) {
  clearOldScanUrl();
  stopGifPlayback();

  gifFrames = [];
  gifFrameIndex = 0;
  gifTotalDuration = 0;
  scanResultsByTime = [];
  scanFile = file;
  scanUrl = URL.createObjectURL(file);
  predictionLabel = null;

  clearScanBoxes();

  $("correctButton").disabled = true;
  $("incorrectButton").disabled = true;
  $("confidence").textContent = "";
}

$("scanInput").addEventListener("change", async event => {
  const file = event.target.files?.[0];
  event.target.value = "";

  if (!file) return;

  resetScanFile(file);

  const image = $("scanPreview");
  const video = $("scanVideo");
  const gifCanvas = $("gifCanvas");

  image.classList.remove("visible");
  video.classList.remove("visible");
  gifCanvas.classList.remove("visible");
  $("scanPlaceholder").hidden = true;

  try {
    if (isVideoFile(file)) {
      scanMode = "video";
      video.pause();
      video.src = scanUrl;
      video.load();

      await waitForEvent(video, "loadedmetadata");
      await waitForVideoFrame(video);

      video.currentTime = 0;
      video.classList.add("visible");
    } else if (isGifFile(file)) {
      scanMode = "gif";
      await decodeGif(file);
      gifCanvas.classList.add("visible");
    } else {
      scanMode = "image";
      image.src = scanUrl;
      await waitForEvent(image, "load");
      image.classList.add("visible");
    }

    $("prediction").textContent = "Ready to scan";
    setStatus("File ready. Start the scan when you’re ready.");
    drawScanBoxes();
    updateMediaControls();
  } catch (error) {
    $("scanPlaceholder").hidden = false;
    $("mediaControls").hidden = true;
    $("prediction").textContent = "Could not load file";
    setStatus(`Could not load file: ${error.message}`);
  }
});

$("mediaPlayButton").addEventListener("click", async () => {
  if (scanMode === "video") {
    const video = $("scanVideo");

    try {
      if (video.paused) {
        await video.play();
      } else {
        video.pause();
      }
    } catch (error) {
      setStatus(`Could not play video: ${error.message}`);
    }

    updateMediaControls();
    return;
  }

  if (scanMode === "gif") {
    if (gifAnimationId !== null) {
      stopGifPlayback();
    } else {
      playGif();
    }

    updateMediaControls();
  }
});

$("scanVideo").addEventListener("play", updateMediaControls);
$("scanVideo").addEventListener("pause", updateMediaControls);
$("scanVideo").addEventListener("ended", updateMediaControls);

$("scanVideo").addEventListener("timeupdate", () => {
  updateMediaControls();

  if (scanResultsByTime.length) {
    detections = closestDetectionsToTime($("scanVideo").currentTime);
    drawScanBoxes();
  }
});

$("mediaTimeline").addEventListener("input", () => {
  timelineDragging = true;

  const duration = getMediaDuration();
  const time = Number($("mediaTimeline").value) / 1000 * duration;

  $("mediaCurrentTime").textContent = formatTime(time);

  if (scanMode === "video") {
    $("scanVideo").currentTime = time;
  } else if (scanMode === "gif" && gifFrames.length) {
    let elapsed = 0;
    let index = 0;
    const target = time * 1000;

    while (
      index < gifFrames.length - 1 &&
      elapsed + gifFrames[index].delay < target
    ) {
      elapsed += gifFrames[index].delay;
      index++;
    }

    drawGifFrame(index);
  }
});

$("mediaTimeline").addEventListener("change", () => {
  timelineDragging = false;
  updateMediaControls();
});

/* Scan buttons */

async function scanStillImage() {
  const results = await detectPersonObjects($("scanPreview"));

  detections = results;
  drawScanBoxes();

  return results;
}

async function scanGif() {
  const sampledResults = [];
  const started = performance.now();
  const step = Math.max(1, Math.ceil(gifFrames.length / MAX_GIF_FRAMES));

  stopGifPlayback();

  for (let index = 0; index < gifFrames.length; index += step) {
    if (performance.now() - started > 5000) break;

    drawGifFrame(index);

    const results = await detectPersonObjects($("gifCanvas"));
    const time = gifFrames
      .slice(0, index)
      .reduce((sum, frame) => sum + frame.delay, 0) / 1000;

    sampledResults.push({ time, detections: results });
    detections = results;
    drawScanBoxes();

    const progress = Math.round((index + 1) / gifFrames.length * 100);

    setProgress(
      `Scanning GIF frame ${index + 1} of ${gifFrames.length}…`,
      progress
    );

    await new Promise(resolve => setTimeout(resolve, 0));
  }

  scanResultsByTime = sampledResults;
  drawGifFrame(gifFrameIndex);

  return sampledResults.flatMap(item => item.detections);
}

async function scanVideo() {
  const video = $("scanVideo");
  const duration = Number.isFinite(video.duration) ? video.duration : 0;

  if (!duration) {
    throw new Error("Video duration is unavailable.");
  }

  const started = performance.now();

  const frameCount = Math.min(
    MAX_VIDEO_FRAMES,
    Math.max(1, Math.floor(MAX_SCAN_MS / 300))
  );

  const sampledResults = [];

  video.pause();

  for (let index = 0; index < frameCount; index++) {
    if (performance.now() - started >= MAX_SCAN_MS) break;

    const time = frameCount <= 1
      ? 0
      : index / (frameCount - 1) * Math.max(0, duration - 0.03);

    await seekVideo(video, time);

    const results = await detectPersonObjects(video);

    sampledResults.push({ time, detections: results });
    detections = results;
    drawScanBoxes();

    setProgress(
      `Scanning video frame ${index + 1} of ${frameCount}…`,
      Math.round((index + 1) / frameCount * 100)
    );

    await new Promise(resolve => setTimeout(resolve, 0));
  }

  scanResultsByTime = sampledResults;
  video.currentTime = 0;
  detections = closestDetectionsToTime(0);

  drawScanBoxes();
  updateMediaControls();

  return sampledResults.flatMap(item => item.detections);
}

function showScanResults(results) {
  if (results.length) {
    predictionLabel = "person";

    $("prediction").textContent =
      `${results.length} person detection${results.length === 1 ? "" : "s"} found`;

    const highestConfidence = Math.max(...results.map(item => item.score));

    $("confidence").textContent =
      `Highest box confidence: ${(highestConfidence * 100).toFixed(0)}%`;
  } else {
    predictionLabel = "not-person";
    $("prediction").textContent = "No person detected";
    $("confidence").textContent = "";
  }

  if (scanMode === "image") {
    $("correctButton").disabled = false;
    $("incorrectButton").disabled = false;
  }
}

$("scanButton").addEventListener("click", async () => {
  if (scanBusy) return;

  if (!scanFile) {
    setStatus("Choose an image, GIF, or video first.");
    return;
  }

  if (!detector) {
    setStatus("The detection model is still loading.");
    return;
  }

  scanBusy = true;
  $("scanButton").disabled = true;
  $("prediction").textContent = "Scanning…";
  predictionLabel = null;
  scanResultsByTime = [];

  clearScanBoxes();

  const started = performance.now();

  try {
    setProgress("Preparing scan…", 0);

    let results;

    if (scanMode === "video") {
      results = await scanVideo();
    } else if (scanMode === "gif") {
      results = await scanGif();
    } else {
      results = await scanStillImage();
    }

    showScanResults(results);
    setProgress("Scan complete.", 100);

    setStatus(
      `Scan complete in ${((performance.now() - started) / 1000).toFixed(1)}s.`
    );
  } catch (error) {
    console.error(error);

    $("prediction").textContent = "Scan failed";
    setProgress(error.message, 100);
    setStatus(`Scan failed: ${error.message}`);
  } finally {
    scanBusy = false;
    $("scanButton").disabled = false;
    updateMediaControls();
  }
});

$("headToggle").addEventListener("change", drawScanBoxes);

/* Save image feedback */

async function saveFeedback(wasCorrect) {
  if (!scanFile || !predictionLabel || scanMode !== "image") return;

  const correctLabel = wasCorrect
    ? predictionLabel
    : predictionLabel === "person" ? "not-person" : "person";

  try {
    const imageForm = new FormData();
    imageForm.append("image", scanFile);

    await request(
      `/api/feedback/image?label=${encodeURIComponent(correctLabel)}`,
      {
        method: "POST",
        body: imageForm
      }
    );

    await request("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image: scanFile.name,
        prediction: predictionLabel,
        correctLabel,
        correct: wasCorrect
      })
    });

    $("feedbackNote").textContent =
      `Feedback saved to the ${
        correctLabel === "person" ? "Person" : "Not Person"
      } folder.`;

    $("correctButton").disabled = true;
    $("incorrectButton").disabled = true;

    setStatus("Feedback saved.");
  } catch (error) {
    setStatus(`Could not save feedback: ${error.message}`);
  }
}

$("correctButton").addEventListener("click", () => saveFeedback(true));
$("incorrectButton").addEventListener("click", () => saveFeedback(false));

/* Search saved Person images by visual similarity */

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

  if (preview.dataset.url) {
    URL.revokeObjectURL(preview.dataset.url);
  }

  preview.dataset.url = URL.createObjectURL(searchFile);
  preview.src = preview.dataset.url;
  preview.classList.add("visible");
  $("searchPlaceholder").hidden = true;
});

function renderSearchResults(results) {
  const container = $("searchResults");
  container.replaceChildren();

  for (const item of results) {
    const card = document.createElement("article");
    card.className = "match-card";

    const image = document.createElement("img");
    image.src = item.url;
    image.alt = `Similar image: ${item.name}`;

    const details = document.createElement("div");
    details.className = "match-details";

    const name = document.createElement("strong");
    name.textContent = item.name;

    const score = document.createElement("span");
    score.textContent =
      `Visual similarity: ${Math.max(0, item.similarity * 100).toFixed(1)}%`;

    details.append(name, score);
    card.append(image, details);
    container.append(card);
  }
}

$("searchButton").addEventListener("click", async () => {
  if (!searchFile) {
    $("searchMessage").textContent = "Choose an image first.";
    return;
  }

  if (!detector || !mobileNetModel) {
    $("searchMessage").textContent = "Models are still loading.";
    return;
  }

  $("searchButton").disabled = true;
  $("searchResults").replaceChildren();
  $("searchMessage").textContent = "Checking for a person…";

  let queryEmbedding = null;

  try {
    const preview = $("searchPreview");
    const objectPredictions = await detector.detect(preview, 10, 0.35);

    if (!objectPredictions.some(item => item.class === "person")) {
      $("searchMessage").textContent =
        "No person detected, so the Person collection was not searched.";
      return;
    }

    queryEmbedding = mobileNetModel.infer(preview, true);
    $("searchMessage").textContent = "Searching saved Person images…";

    const collections = await request("/api/images");
    const results = [];

    for (const item of collections.person || []) {
      let imageEmbedding = null;

      try {
        const image = await loadImage(item.url);
        imageEmbedding = mobileNetModel.infer(image, true);

        const similarity = tf.tidy(() => {
          const first = queryEmbedding.flatten();
          const second = imageEmbedding.flatten();

          return tf.sum(tf.mul(first, second))
            .div(tf.norm(first).mul(tf.norm(second)))
            .dataSync()[0];
        });

        results.push({
          ...item,
          similarity: Number.isFinite(similarity) ? similarity : -1
        });
      } catch (error) {
        console.warn(`Skipping ${item.name}:`, error);
      } finally {
        if (imageEmbedding) imageEmbedding.dispose();
      }
    }

    results.sort((a, b) => b.similarity - a.similarity);

    const bestMatches = results.slice(0, 3);

    if (!bestMatches.length) {
      $("searchMessage").textContent =
        "No saved Person images were available.";
      return;
    }

    $("searchMessage").textContent =
      "Top matches from your saved Person images:";

    renderSearchResults(bestMatches);
  } catch (error) {
    $("searchMessage").textContent = `Search failed: ${error.message}`;
  } finally {
    if (queryEmbedding) queryEmbedding.dispose();
    $("searchButton").disabled = false;
  }
});

/* Tabs and theme selection */

document.querySelectorAll(".tab-button").forEach(button => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".tab-button").forEach(tab => {
      tab.classList.remove("active");
    });

    document.querySelectorAll(".tab-panel").forEach(panel => {
      panel.classList.remove("active");
    });

    button.classList.add("active");
    $(button.dataset.tab).classList.add("active");

    if (button.dataset.tab !== "liveTab") {
      stopLiveCamera();
    }
  });
});

$("themeSelect").addEventListener("change", event => {
  document.body.dataset.theme = event.target.value;
  localStorage.setItem("trainer-theme", event.target.value);
});

const savedTheme = localStorage.getItem("trainer-theme");

if (["light", "dark", "pastel", "cats"].includes(savedTheme)) {
  document.body.dataset.theme = savedTheme;
  $("themeSelect").value = savedTheme;
}

/* Upload training images */

function setupUploader(inputId, dropId, label) {
  const input = $(inputId);
  const zone = $(dropId);

  input.addEventListener("change", async event => {
    await uploadTrainingFiles(event.target.files, label);
    input.value = "";
  });

  zone.addEventListener("dragover", event => {
    event.preventDefault();
    zone.classList.add("dragover");
  });

  zone.addEventListener("dragleave", () => {
    zone.classList.remove("dragover");
  });

  zone.addEventListener("drop", event => {
    event.preventDefault();
    zone.classList.remove("dragover");
    uploadTrainingFiles(event.dataTransfer.files, label);
  });
}

async function uploadTrainingFiles(files, label) {
  const images = [...files].filter(file => file.type.startsWith("image/"));

  if (!images.length) {
    setStatus("Choose image files.");
    return;
  }

  const form = new FormData();

  for (const image of images) {
    form.append("images", image);
  }

  try {
    setStatus(`Uploading ${images.length} image(s)…`);

    await request(`/api/upload/${label}`, {
      method: "POST",
      body: form
    });

    setStatus("Images saved.");
  } catch (error) {
    setStatus(`Upload failed: ${error.message}`);
  }
}

setupUploader("personInput", "personDrop", "person");
setupUploader("otherInput", "otherDrop", "not-person");

/* Webcam person detection */

function drawLiveBoxes() {
  const video = $("liveVideo");

  if (!video.videoWidth || !video.videoHeight) return;

  drawBoxesOnCanvas(
    $("liveCanvas"),
    $("liveStage"),
    video.videoWidth,
    video.videoHeight,
    liveDetections,
    $("liveHeadToggle").checked
  );
}

function stopLiveLoop() {
  liveRunning = false;
  liveBusy = false;

  if (liveAnimationId !== null) {
    cancelAnimationFrame(liveAnimationId);
  }

  liveAnimationId = null;

  const video = $("liveVideo");

  if (
    liveFrameCallbackId !== null &&
    typeof video.cancelVideoFrameCallback === "function"
  ) {
    video.cancelVideoFrameCallback(liveFrameCallbackId);
  }

  liveFrameCallbackId = null;
}

function stopLiveCamera() {
  stopLiveLoop();

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
  $("liveStatus").textContent = "Camera is off.";

  if (mediaRecorder && mediaRecorder.state === "recording") {
    stopRecording();
  }
}

async function startLiveCamera() {
  if (liveRunning) return;

  if (!navigator.mediaDevices?.getUserMedia) {
    $("liveStatus").textContent =
      "Camera is unavailable here. Use HTTPS or the desktop app.";
    return;
  }

  if (!detector) {
    $("liveStatus").textContent = "The detection model is still loading.";
    return;
  }

  $("startCameraButton").disabled = true;
  $("liveStatus").textContent = "Requesting camera permission…";

  try {
    liveStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: "user",
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 24, max: 30 }
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
    liveLastInference = 0;
    liveDetections = [];

    video.classList.add("visible");
    $("livePlaceholder").hidden = true;
    $("stopCameraButton").disabled = false;
    $("startRecordingButton").disabled = !window.MediaRecorder;
    $("liveStatus").textContent = "Camera on. Detecting people locally.";

    runLiveLoop();
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

    if (
      error.name === "NotAllowedError" ||
      error.name === "SecurityError"
    ) {
      $("liveStatus").textContent =
        "Camera permission was denied. Allow webcam access and try again.";
    } else if (error.name === "NotFoundError") {
      $("liveStatus").textContent = "No webcam was found.";
    } else {
      $("liveStatus").textContent =
        `Could not start camera: ${error.message}`;
    }
  }
}

function scheduleLiveLoop() {
  if (!liveRunning) return;

  const video = $("liveVideo");

  if (typeof video.requestVideoFrameCallback === "function") {
    liveFrameCallbackId = video.requestVideoFrameCallback(() => {
      liveFrameCallbackId = null;
      runLiveLoop();
    });
  } else {
    liveAnimationId = requestAnimationFrame(() => {
      liveAnimationId = null;
      runLiveLoop();
    });
  }
}

async function runLiveLoop() {
  if (!liveRunning) return;

  if (liveBusy) {
    scheduleLiveLoop();
    return;
  }

  const video = $("liveVideo");

  if (!detector || video.readyState < 2 || !video.videoWidth) {
    scheduleLiveLoop();
    return;
  }

  if (performance.now() - liveLastInference < LIVE_MIN_INTERVAL_MS) {
    scheduleLiveLoop();
    return;
  }

  liveBusy = true;
  liveLastInference = performance.now();

  try {
    const results = await detector.detect(video, 10, 0.3);

    if (liveRunning) {
      liveDetections = filterPersonDetections(
        results,
        video.videoWidth,
        video.videoHeight
      );

      drawLiveBoxes();

      $("liveStatus").textContent = liveDetections.length
        ? `${liveDetections.length} person${liveDetections.length === 1 ? "" : "s"} detected`
        : "Camera on. No people detected.";
    }
  } catch (error) {
    console.error(error);
    $("liveStatus").textContent = `Live detection error: ${error.message}`;
  } finally {
    liveBusy = false;

    if (liveRunning) {
      scheduleLiveLoop();
    }
  }
}

/* Webcam recording */

function supportedRecordingType() {
  if (!window.MediaRecorder) return "";

  const types = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm"
  ];

  return types.find(type => MediaRecorder.isTypeSupported(type)) || "";
}

function setRecordingStatus(message) {
  $("recordingStatus").textContent = message;
}

function updateRecordingClock() {
  if (!mediaRecorder || mediaRecorder.state !== "recording") return;

  const elapsedSeconds = Math.floor((Date.now() - recordingStartedAt) / 1000);

  setRecordingStatus(
    `Recording: ${formatTime(elapsedSeconds)} elapsed. Stops automatically after 2 hours.`
  );
}

function startRecording() {
  if (!liveStream || !liveRunning) {
    setRecordingStatus("Start the camera before recording.");
    return;
  }

  if (!window.MediaRecorder) {
    setRecordingStatus("Video recording is not supported by this browser.");
    return;
  }

  try {
    if (recordingUrl) {
      URL.revokeObjectURL(recordingUrl);
      recordingUrl = null;
    }

    $("recordingDownload").hidden = true;
    recordingChunks = [];

    const mimeType = supportedRecordingType();

    mediaRecorder = new MediaRecorder(
      liveStream,
      mimeType ? { mimeType } : undefined
    );

    mediaRecorder.addEventListener("dataavailable", event => {
      if (event.data && event.data.size > 0) {
        recordingChunks.push(event.data);
      }
    });

    mediaRecorder.addEventListener("error", event => {
      setRecordingStatus(
        `Recording error: ${event.error?.message || "unknown error"}`
      );
    });

    mediaRecorder.addEventListener("stop", () => {
      clearTimeout(recordingTimeout);
      clearInterval(recordingClock);

      if (recordingChunks.length) {
        const blob = new Blob(recordingChunks, {
          type: mediaRecorder.mimeType || "video/webm"
        });

        recordingUrl = URL.createObjectURL(blob);

        const download = $("recordingDownload");
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

        download.href = recordingUrl;
        download.download = `webcam-recording-${timestamp}.webm`;
        download.textContent = "Download recording";
        download.hidden = false;

        setRecordingStatus(
          "Recording finished. Use the download link to save it."
        );
      } else {
        setRecordingStatus("No recording data was captured.");
      }

      $("startRecordingButton").disabled = !liveRunning;
      $("stopRecordingButton").disabled = true;
    });

    mediaRecorder.start(1000);
    recordingStartedAt = Date.now();

    $("startRecordingButton").disabled = true;
    $("stopRecordingButton").disabled = false;

    updateRecordingClock();
    recordingClock = setInterval(updateRecordingClock, 1000);

    recordingTimeout = setTimeout(() => {
      if (mediaRecorder?.state === "recording") {
        setRecordingStatus("Two-hour recording limit reached; stopping.");
        stopRecording();
      }
    }, MAX_RECORDING_MS);
  } catch (error) {
    console.error(error);

    setRecordingStatus(`Could not start recording: ${error.message}`);
    $("startRecordingButton").disabled = !liveRunning;
    $("stopRecordingButton").disabled = true;
  }
}

function stopRecording() {
  clearTimeout(recordingTimeout);
  clearInterval(recordingClock);

  if (mediaRecorder?.state === "recording") {
    mediaRecorder.stop();
    setRecordingStatus("Finalizing recording…");
  } else {
    $("stopRecordingButton").disabled = true;
  }
}

/* Full-screen Live Camera */

async function toggleLiveFullscreen() {
  const liveCard = document.querySelector(".live-card");

  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else if (liveCard.requestFullscreen) {
      await liveCard.requestFullscreen();
    } else {
      $("liveStatus").textContent = "Full screen is not supported here.";
    }
  } catch (error) {
    $("liveStatus").textContent =
      `Could not change full screen: ${error.message}`;
  }
}

$("fullscreenButton").addEventListener("click", toggleLiveFullscreen);

document.addEventListener("fullscreenchange", () => {
  $("fullscreenButton").textContent = document.fullscreenElement
    ? "⛶ Exit full screen"
    : "⛶ Full screen";

  requestAnimationFrame(() => {
    drawLiveBoxes();
    drawScanBoxes();
  });
});

/* Wire up live camera controls */

$("startCameraButton").addEventListener("click", startLiveCamera);
$("stopCameraButton").addEventListener("click", stopLiveCamera);
$("startRecordingButton").addEventListener("click", startRecording);
$("stopRecordingButton").addEventListener("click", stopRecording);
$("liveHeadToggle").addEventListener("change", drawLiveBoxes);

/* Cleanup and resize */

window.addEventListener("resize", () => {
  drawScanBoxes();
  drawLiveBoxes();
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden && liveRunning) {
    stopLiveCamera();
  }
});

window.addEventListener("pagehide", () => {
  stopLiveCamera();

  if (scanUrl) {
    URL.revokeObjectURL(scanUrl);
  }

  const searchPreview = $("searchPreview");

  if (searchPreview.dataset.url) {
    URL.revokeObjectURL(searchPreview.dataset.url);
  }

  if (recordingUrl) {
    URL.revokeObjectURL(recordingUrl);
  }
});

/* Load models */

async function startApp() {
  try {
    setStatus("Loading detection and similarity models…");

    if (!window.tf || !window.cocoSsd || !window.mobilenet) {
      throw new Error(
        "AI libraries did not load. Check your internet connection."
      );
    }

    [detector, mobileNetModel] = await Promise.all([
      window.cocoSsd.load(),
      window.mobilenet.load({ version: 2, alpha: 1.0 })
    ]);

    setStatus("Ready. Choose a file to scan, or open Live Camera.");
  } catch (error) {
    console.error(error);

    setStatus(`Could not load models: ${error.message}`);
    $("liveStatus").textContent =
      "Detection model unavailable. Check your internet connection and refresh.";
  }
}

startApp();

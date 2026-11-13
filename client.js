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
let liveLastInference = 0;
let liveDetections = [];
let liveFrameCallbackId = null;

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
  $("status").textContent = message;
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
  return file.type.startsWith("video/") || /\.(mp4|webm|mov|m4v|ogv)$/i.test(file.name);
}

function isGifFile(file) {
  return file.type === "image/gif" || /\.gif$/i.test(file.name);
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

function mediaDuration() {
  if (scanMode === "video") {
    return Number.isFinite($("scanVideo").duration) ? $("scanVideo").duration : 0;
  }
  return scanMode === "gif" ? gifTotalDuration / 1000 : 0;
}

function currentMediaTime() {
  if (scanMode === "video") return $("scanVideo").currentTime || 0;

  if (scanMode === "gif" && gifFrames.length) {
    let elapsed = 0;
    for (let i = 0; i < gifFrameIndex; i++) elapsed += gifFrames[i].delay;
    return Math.min(elapsed / 1000, gifTotalDuration / 1000);
  }

  return 0;
}

function updatePlayButton() {
  const button = $("mediaPlayButton");
  const hasMedia = scanMode === "video" || (scanMode === "gif" && gifFrames.length > 0);
  button.hidden = !hasMedia;

  const playing = scanMode === "video"
    ? !$("scanVideo").paused && !$("scanVideo").ended
    : scanMode === "gif" && gifAnimationId !== null;

  button.textContent = playing ? "❚❚" : "▶";
  button.setAttribute("aria-label", playing ? "Pause media" : "Play media");
}

function updateMediaControls() {
  const duration = mediaDuration();
  const available = (scanMode === "video" && duration > 0) ||
    (scanMode === "gif" && gifFrames.length > 0);

  $("mediaControls").hidden = !available;
  if (!available) {
    updatePlayButton();
    return;
  }

  const time = Math.min(currentMediaTime(), duration);
  $("mediaCurrentTime").textContent = formatTime(time);
  $("mediaDuration").textContent = formatTime(duration);

  if (!timelineDragging && duration > 0) {
    $("mediaTimeline").value = String(Math.round(time / duration * 1000));
  }
  updatePlayButton();
}

function frameDimensions() {
  if (scanMode === "video") {
    return { width: $("scanVideo").videoWidth, height: $("scanVideo").videoHeight };
  }

  if (scanMode === "gif" && gifFrames.length) {
    return { width: gifFrames[0].canvas.width, height: gifFrames[0].canvas.height };
  }

  return { width: $("scanPreview").naturalWidth, height: $("scanPreview").naturalHeight };
}

function displayedFrameRect(stage, width, height) {
  if (!width || !height || !stage.clientWidth || !stage.clientHeight) return null;
  const scale = Math.min(stage.clientWidth / width, stage.clientHeight / height);

  return {
    x: (stage.clientWidth - width * scale) / 2,
    y: (stage.clientHeight - height * scale) / 2,
    scale
  };
}

function estimateHeadBox([x, y, width, height]) {
  const headWidth = width * 0.48;
  const headHeight = height * 0.22;
  return [x + (width - headWidth) / 2, y + height * 0.025, headWidth, headHeight];
}

function drawDetections(canvas, stage, sourceWidth, sourceHeight, results, showHeads) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(stage.clientWidth * dpr);
  canvas.height = Math.round(stage.clientHeight * dpr);
  canvas.style.width = `${stage.clientWidth}px`;
  canvas.style.height = `${stage.clientHeight}px`;

  const context = canvas.getContext("2d");
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, stage.clientWidth, stage.clientHeight);

  const shown = displayedFrameRect(stage, sourceWidth, sourceHeight);
  if (!shown) return;

  for (const item of results) {
    const [x, y, width, height] = item.bbox;
    const px = shown.x + x * shown.scale;
    const py = shown.y + y * shown.scale;
    const pw = width * shown.scale;
    const ph = height * shown.scale;

    context.lineWidth = 3;
    context.strokeStyle = "#17d895";
    context.strokeRect(px, py, pw, ph);

    const label = `Person ${(item.score * 100).toFixed(0)}%`;
    context.font = "bold 13px system-ui, sans-serif";
    const labelWidth = context.measureText(label).width + 12;
    const labelY = Math.max(0, py - 23);

    context.fillStyle = "#17d895";
    context.fillRect(px, labelY, labelWidth, 23);
    context.fillStyle = "#10251d";
    context.fillText(label, px + 6, labelY + 16);

    if (showHeads) {
      const [hx, hy, hw, hh] = estimateHeadBox(item.bbox);
      const sx = shown.x + hx * shown.scale;
      const sy = shown.y + hy * shown.scale;
      const sw = hw * shown.scale;
      const sh = hh * shown.scale;

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

function drawBoxes() {
  const { width, height } = frameDimensions();
  drawDetections($("boxCanvas"), $("scanStage"), width, height, detections, $("headToggle").checked);
}

function clearBoxes() {
  detections = [];
  const canvas = $("boxCanvas");
  canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
}

function intersectionOverUnion(a, b) {
  const [ax, ay, aw, ah] = a.bbox;
  const [bx, by, bw, bh] = b.bbox;
  const left = Math.max(ax, bx);
  const top = Math.max(ay, by);
  const right = Math.min(ax + aw, bx + bw);
  const bottom = Math.min(ay + ah, by + bh);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const union = aw * ah + bw * bh - intersection;
  return union > 0 ? intersection / union : 0;
}

function filterDetections(results, width, height) {
  if (!width || !height) return [];

  const frameArea = width * height;
  const plausible = results.filter(item => {
    if (item.class !== "person" || item.score < 0.4) return false;
    const [, , boxWidth, boxHeight] = item.bbox;
    const areaRatio = boxWidth * boxHeight / frameArea;
    return areaRatio < 0.72 && boxWidth / width < 0.92 && boxHeight / height < 0.97;
  });

  const kept = [];
  for (const item of plausible.sort((a, b) => b.score - a.score)) {
    if (!kept.some(other => intersectionOverUnion(other, item) > 0.5)) kept.push(item);
  }
  return kept;
}

async function detectFrame(source) {
  const { width, height } = frameDimensions();
  return filterDetections(await detector.detect(source, 20, 0.25), width, height);
}

function waitForEvent(target, eventName) {
  return new Promise((resolve, reject) => {
    const success = () => {
      cleanup();
      resolve();
    };
    const failure = () => {
      cleanup();
      reject(new Error(`Could not load ${eventName}.`));
    };
    const cleanup = () => {
      target.removeEventListener(eventName, success);
      target.removeEventListener("error", failure);
    };
    target.addEventListener(eventName, success, { once: true });
    target.addEventListener("error", failure, { once: true });
  });
}

function waitForVideoFrame(video) {
  if (video.readyState >= 2) return Promise.resolve();
  return Promise.race([
    waitForEvent(video, "loadeddata"),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Timed out waiting for a video frame.")), 3000)
    )
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
    }, 3000);

    const seeked = () => {
      cleanup();
      resolve();
    };
    const error = () => {
      cleanup();
      reject(new Error("Video could not be decoded."));
    };
    function cleanup() {
      clearTimeout(timeout);
      video.removeEventListener("seeked", seeked);
      video.removeEventListener("error", error);
    }

    video.addEventListener("seeked", seeked, { once: true });
    video.addEventListener("error", error, { once: true });
    video.currentTime = time;
  });
}

function stopGifPlayback() {
  if (gifAnimationId !== null) cancelAnimationFrame(gifAnimationId);
  gifAnimationId = null;
}

function findDetectionsNearTime(time) {
  if (!scanResultsByTime.length) return [];

  let nearest = scanResultsByTime[0];
  for (const entry of scanResultsByTime) {
    if (Math.abs(entry.time - time) < Math.abs(nearest.time - time)) nearest = entry;
  }
  return nearest.detections;
}

function drawGifFrame(index) {
  if (!gifFrames.length) return;

  gifFrameIndex = Math.max(0, Math.min(index, gifFrames.length - 1));
  const frame = gifFrames[gifFrameIndex];
  const canvas = $("gifCanvas");
  canvas.width = frame.canvas.width;
  canvas.height = frame.canvas.height;
  canvas.getContext("2d").drawImage(frame.canvas, 0, 0);

  let elapsed = 0;
  for (let i = 0; i < gifFrameIndex; i++) elapsed += gifFrames[i].delay;
  detections = findDetectionsNearTime(elapsed / 1000);
  drawBoxes();
  updateMediaControls();
}

function playGif() {
  if (!gifFrames.length || gifAnimationId !== null) return;
  let lastSwitch = performance.now();

  const animate = now => {
    if (gifAnimationId === null) return;
    if (now - lastSwitch >= Math.max(20, gifFrames[gifFrameIndex].delay)) {
      lastSwitch = now;
      drawGifFrame((gifFrameIndex + 1) % gifFrames.length);
    }
    gifAnimationId = requestAnimationFrame(animate);
    updateMediaControls();
  };

  gifAnimationId = requestAnimationFrame(animate);
  updatePlayButton();
}

async function decodeGif(file) {
  if (!window.gifuct) throw new Error("GIF decoder did not load. Check your internet connection.");

  const parsed = window.gifuct.parseGIF(await file.arrayBuffer());
  const frames = window.gifuct.decompressFrames(parsed, true).slice(0, MAX_GIF_FRAMES);
  if (!frames.length) throw new Error("The GIF contains no readable frames.");

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

  for (const frame of frames) {
    if (frame.disposalType === 3) {
      previousContext.clearRect(0, 0, width, height);
      previousContext.drawImage(composed, 0, 0);
    }

    const patch = new ImageData(
      new Uint8ClampedArray(frame.patch),
      frame.dims.width,
      frame.dims.height
    );
    composedContext.putImageData(patch, frame.dims.left, frame.dims.top);

    const output = document.createElement("canvas");
    output.width = width;
    output.height = height;
    output.getContext("2d").drawImage(composed, 0, 0);
    gifFrames.push({ canvas: output, delay: Math.max(20, (frame.delay || 10) * 10) });

    if (frame.disposalType === 2) {
      composedContext.clearRect(frame.dims.left, frame.dims.top, frame.dims.width, frame.dims.height);
    } else if (frame.disposalType === 3) {
      composedContext.clearRect(0, 0, width, height);
      composedContext.drawImage(previous, 0, 0);
    }
  }

  gifTotalDuration = gifFrames.reduce((total, frame) => total + frame.delay, 0);
  gifFrameIndex = 0;
  drawGifFrame(0);
}

function setScanPreview(file) {
  if (scanUrl) URL.revokeObjectURL(scanUrl);

  stopGifPlayback();
  gifFrames = [];
  gifFrameIndex = 0;
  gifTotalDuration = 0;
  scanResultsByTime = [];
  scanFile = file;
  scanUrl = URL.createObjectURL(file);
  predictionLabel = null;

  clearBoxes();
  $("correctButton").disabled = true;
  $("incorrectButton").disabled = true;
  $("confidence").textContent = "";
}

$("scanInput").addEventListener("change", async event => {
  const file = event.target.files[0];
  if (!file) return;

  setScanPreview(file);
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
    drawBoxes();
    updateMediaControls();
  } catch (error) {
    $("scanPlaceholder").hidden = false;
    $("mediaControls").hidden = true;
    setStatus(`Could not load file: ${error.message}`);
  }

  event.target.value = "";
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
  } else if (scanMode === "gif") {
    if (gifAnimationId !== null) stopGifPlayback();
    else playGif();
    updateMediaControls();
  }
});

$("scanVideo").addEventListener("play", updateMediaControls);
$("scanVideo").addEventListener("pause", updateMediaControls);
$("scanVideo").addEventListener("ended", updateMediaControls);
$("scanVideo").addEventListener("timeupdate", () => {
  updateMediaControls();
  if (scanResultsByTime.length) {
    detections = findDetectionsNearTime($("scanVideo").currentTime);
    drawBoxes();
  }
});

$("mediaTimeline").addEventListener("input", () => {
  timelineDragging = true;
  const duration = mediaDuration();
  const time = Number($("mediaTimeline").value) / 1000 * duration;
  $("mediaCurrentTime").textContent = formatTime(time);

  if (scanMode === "video") {
    $("scanVideo").currentTime = time;
  } else if (scanMode === "gif") {
    let elapsed = 0;
    let index = 0;
    const target = time * 1000;

    for (; index < gifFrames.length - 1; index++) {
      if (elapsed + gifFrames[index].delay >= target) break;
      elapsed += gifFrames[index].delay;
    }

    drawGifFrame(index);
  }
});

$("mediaTimeline").addEventListener("change", () => {
  timelineDragging = false;
  updateMediaControls();
});

async function scanStillImage() {
  detections = await detectFrame($("scanPreview"));
  drawBoxes();
  return detections;
}

async function scanGif() {
  const sampled = [];
  const started = performance.now();
  const step = Math.max(1, Math.ceil(gifFrames.length / MAX_GIF_FRAMES));
  stopGifPlayback();

  for (let index = 0; index < gifFrames.length; index += step) {
    if (performance.now() - started >= 5000) break;

    drawGifFrame(index);
    const results = await detectFrame($("gifCanvas"));
    const time = gifFrames.slice(0, index).reduce((sum, frame) => sum + frame.delay, 0) / 1000;
    sampled.push({ time, detections: results });
    detections = results;
    drawBoxes();

    setProgress(`Scanning GIF frame ${index + 1} of ${gifFrames.length}…`,
      Math.min(99, Math.round(index / Math.max(1, gifFrames.length - 1) * 100)));
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  scanResultsByTime = sampled;
  drawGifFrame(gifFrameIndex);
  return sampled.flatMap(item => item.detections);
}

async function scanVideo() {
  const video = $("scanVideo");
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  if (!duration) throw new Error("Video duration is unavailable.");

  const started = performance.now();
  const count = Math.min(MAX_VIDEO_FRAMES, Math.max(1, Math.floor(MAX_SCAN_MS / 300)));
  const sampled = [];
  video.pause();

  for (let index = 0; index < count; index++) {
    if (performance.now() - started >= MAX_SCAN_MS) break;

    const time = count <= 1 ? 0 : index / (count - 1) * Math.max(0, duration - 0.03);
    await seekVideo(video, time);
    const results = await detectFrame(video);
    sampled.push({ time, detections: results });
    detections = results;
    drawBoxes();
    setProgress(`Scanning video frame ${index + 1} of ${count}…`, Math.round((index + 1) / count * 100));
  }

  scanResultsByTime = sampled;
  video.currentTime = 0;
  detections = findDetectionsNearTime(0);
  drawBoxes();
  updateMediaControls();
  return sampled.flatMap(item => item.detections);
}

function finishPrediction(results) {
  if (results.length) {
    predictionLabel = "person";
    $("prediction").textContent = `${results.length} person detection${results.length === 1 ? "" : "s"} found`;
    $("confidence").textContent = `Highest box confidence: ${(Math.max(...results.map(item => item.score)) * 100).toFixed(0)}%`;
  } else {
    predictionLabel = "not-person";
    $("prediction").textContent = "No person detected";
    $("confidence").textContent = "";
  }

  if (scanMode === "image" && !isGifFile(scanFile)) {
    $("correctButton").disabled = false;
    $("incorrectButton").disabled = false;
  }
}

$("scanButton").addEventListener("click", async () => {
  if (scanBusy) return;
  if (!scanFile) return setStatus("Choose an image, GIF, or video first.");
  if (!detector) return setStatus("The detection model is still loading.");

  scanBusy = true;
  $("scanButton").disabled = true;
  $("prediction").textContent = "Scanning…";
  predictionLabel = null;
  scanResultsByTime = [];
  clearBoxes();
  const started = performance.now();

  try {
    setProgress("Preparing scan…", 0);
    let results;

    if (scanMode === "video") results = await scanVideo();
    else if (scanMode === "gif") results = await scanGif();
    else results = await scanStillImage();

    finishPrediction(results);
    setProgress("Scan complete.", 100);
    setStatus(`Scan complete in ${((performance.now() - started) / 1000).toFixed(1)}s.`);
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

$("headToggle").addEventListener("change", drawBoxes);

async function saveFeedback(wasCorrect) {
  if (!scanFile || !predictionLabel || scanMode !== "image") return;

  const correctLabel = wasCorrect
    ? predictionLabel
    : predictionLabel === "person" ? "not-person" : "person";

  try {
    const form = new FormData();
    form.append("image", scanFile);

    await request(`/api/feedback/image?label=${correctLabel}`, {
      method: "POST",
      body: form
    });

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
      `Feedback saved to the ${correctLabel === "person" ? "Person" : "Not Person"} folder.`;
    $("correctButton").disabled = true;
    $("incorrectButton").disabled = true;
    setStatus("Feedback saved.");
  } catch (error) {
    setStatus(`Could not save feedback: ${error.message}`);
  }
}

$("correctButton").addEventListener("click", () => saveFeedback(true));
$("incorrectButton").addEventListener("click", () => saveFeedback(false));

$("searchInput").addEventListener("change", event => {
  searchFile = event.target.files[0] || null;
  $("searchResults").replaceChildren();
  $("searchMessage").textContent = "";

  if (!searchFile) return;
  const image = $("searchPreview");
  if (image.dataset.url) URL.revokeObjectURL(image.dataset.url);
  image.dataset.url = URL.createObjectURL(searchFile);
  image.src = image.dataset.url;
  image.classList.add("visible");
  $("searchPlaceholder").hidden = true;
});

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
    const predictions = await detector.detect(preview, 10, 0.35);

    if (!predictions.some(item => item.class === "person")) {
      $("searchMessage").textContent = "No person detected, so the Person collection was not searched.";
      return;
    }

    queryEmbedding = mobileNetModel.infer(preview, true);
    $("searchMessage").textContent = "Searching saved Person images…";
    const collections = await request("/api/images");
    const results = [];

    for (const item of collections.person || []) {
      let embedding = null;

      try {
        const image = await loadImage(item.url);
        embedding = mobileNetModel.infer(image, true);

        const similarity = tf.tidy(() => {
          const a = queryEmbedding.flatten();
          const b = embedding.flatten();
          return tf.sum(tf.mul(a, b)).div(tf.norm(a).mul(tf.norm(b))).dataSync()[0];
        });

        results.push({ ...item, similarity: Number.isFinite(similarity) ? similarity : -1 });
      } catch (error) {
        console.warn(`Skipping ${item.name}:`, error);
      } finally {
        if (embedding) embedding.dispose();
      }
    }

    results.sort((a, b) => b.similarity - a.similarity);
    const top = results.slice(0, 3);

    if (!top.length) {
      $("searchMessage").textContent = "No saved Person images were available.";
      return;
    }

    $("searchMessage").textContent = "Top matches from your saved Person images:";
    renderSearchResults(top);
  } catch (error) {
    $("searchMessage").textContent = `Search failed: ${error.message}`;
  } finally {
    if (queryEmbedding) queryEmbedding.dispose();
    $("searchButton").disabled = false;
  }
});

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not load image."));
    image.src = url;
  });
}

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
    score.textContent = `Visual similarity: ${Math.max(0, item.similarity * 100).toFixed(1)}%`;

    details.append(name, score);
    card.append(image, details);
    container.append(card);
  }
}

document.querySelectorAll(".tab-button").forEach(button => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".tab-button").forEach(tab => tab.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach(panel => panel.classList.remove("active"));
    button.classList.add("active");
    $(button.dataset.tab).classList.add("active");

    if (button.dataset.tab !== "liveTab") stopLiveCamera();
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

  zone.addEventListener("dragleave", () => zone.classList.remove("dragover"));

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
  images.forEach(image => form.append("images", image));

  try {
    setStatus(`Uploading ${images.length} image(s)…`);
    await request(`/api/upload/${label}`, { method: "POST", body: form });
    setStatus("Images saved.");
  } catch (error) {
    setStatus(`Upload failed: ${error.message}`);
  }
}

setupUploader("personInput", "personDrop", "person");
setupUploader("otherInput", "otherDrop", "not-person");

function drawLiveBoxes() {
  const video = $("liveVideo");
  drawDetections(
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

  if (liveAnimationId !== null) cancelAnimationFrame(liveAnimationId);
  liveAnimationId = null;

  const video = $("liveVideo");
  if (liveFrameCallbackId !== null && typeof video.cancelVideoFrameCallback === "function") {
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

  if (mediaRecorder?.state === "recording") stopRecording();
}

async function startLiveCamera() {
  if (liveRunning) return;

  if (!navigator.mediaDevices?.getUserMedia) {
    $("liveStatus").textContent = "Camera requires browser permission and a supported app environment.";
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
    stopLiveCamera();

    if (error.name === "NotAllowedError" || error.name === "SecurityError") {
      $("liveStatus").textContent = "Camera permission was denied. Allow camera access, then try again.";
    } else if (error.name === "NotFoundError") {
      $("liveStatus").textContent = "No webcam was found.";
    } else {
      $("liveStatus").textContent = `Could not start camera: ${error.message}`;
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
  if (!liveRunning || liveBusy) {
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
      liveDetections = filterDetections(results, video.videoWidth, video.videoHeight);
      drawLiveBoxes();
      $("liveStatus").textContent = liveDetections.length
        ? `${liveDetections.length} person${liveDetections.length === 1 ? "" : "s"} detected`
        : "Camera on. No people detected.";
    }
  } catch (error) {
    console.error(error);
    $("liveStatus").textContent = `Live scan error: ${error.message}`;
  } finally {
    liveBusy = false;
    if (liveRunning) scheduleLiveLoop();
  }
}

function chooseRecordingType() {
  if (!window.MediaRecorder) return "";
  return [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm"
  ].find(type => MediaRecorder.isTypeSupported(type)) || "";
}

function updateRecordingStatus() {
  if (!mediaRecorder || mediaRecorder.state !== "recording") return;
  const elapsed = Math.floor((Date.now() - recordingStartedAt) / 1000);
  $("recordingStatus").textContent =
    `Recording: ${formatTime(elapsed)} elapsed. Stops automatically after 2 hours.`;
}

function startRecording() {
  if (!liveStream || !liveRunning) {
    $("recordingStatus").textContent = "Start the camera first.";
    return;
  }

  if (!window.MediaRecorder) {
    $("recordingStatus").textContent = "Recording is not supported by this browser.";
    return;
  }

  try {
    if (recordingUrl) {
      URL.revokeObjectURL(recordingUrl);
      recordingUrl = null;
    }

    $("recordingDownload").hidden = true;
    recordingChunks = [];
    const type = chooseRecordingType();
    mediaRecorder = new MediaRecorder(liveStream, type ? { mimeType: type } : undefined);

    mediaRecorder.ondataavailable = event => {
      if (event.data?.size) recordingChunks.push(event.data);
    };

    mediaRecorder.onerror = event => {
      $("recordingStatus").textContent =
        `Recording error: ${event.error?.message || "unknown error"}`;
    };

    mediaRecorder.onstop = () => {
      clearTimeout(recordingTimeout);
      clearInterval(recordingClock);

      if (recordingChunks.length) {
        const blob = new Blob(recordingChunks, {
          type: mediaRecorder.mimeType || "video/webm"
        });
        recordingUrl = URL.createObjectURL(blob);

        const link = $("recordingDownload");
        link.href = recordingUrl;
        link.download = `webcam-recording-${new Date().toISOString().replace(/[:.]/g, "-")}.webm`;
        link.textContent = "Download webcam recording";
        link.hidden = false;
        $("recordingStatus").textContent = "Recording stopped. Download the video to save it.";
      } else {
        $("recordingStatus").textContent = "No recording data was captured.";
      }

      $("startRecordingButton").disabled = !liveRunning;
      $("stopRecordingButton").disabled = true;
    };

    mediaRecorder.start(1000);
    recordingStartedAt = Date.now();
    $("startRecordingButton").disabled = true;
    $("stopRecordingButton").disabled = false;
    updateRecordingStatus();
    recordingClock = setInterval(updateRecordingStatus, 1000);

    recordingTimeout = setTimeout(() => {
      if (mediaRecorder?.state === "recording") {
        $("recordingStatus").textContent = "Two-hour maximum reached; stopping.";
        stopRecording();
      }
    }, MAX_RECORDING_MS);
  } catch (error) {
    $("recordingStatus").textContent = `Could not start recording: ${error.message}`;
    $("startRecordingButton").disabled = !liveRunning;
    $("stopRecordingButton").disabled = true;
  }
}

function stopRecording() {
  clearTimeout(recordingTimeout);
  clearInterval(recordingClock);

  if (mediaRecorder?.state === "recording") {
    mediaRecorder.stop();
    $("recordingStatus").textContent = "Finalizing recording…";
  } else {
    $("stopRecordingButton").disabled = true;
  }
}

$("startCameraButton").addEventListener("click", startLiveCamera);
$("stopCameraButton").addEventListener("click", stopLiveCamera);
$("startRecordingButton").addEventListener("click", startRecording);
$("stopRecordingButton").addEventListener("click", stopRecording);
$("liveHeadToggle").addEventListener("change", drawLiveBoxes);

window.addEventListener("resize", () => {
  drawBoxes();
  drawLiveBoxes();
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden && liveRunning) stopLiveCamera();
});

window.addEventListener("pagehide", () => {
  stopLiveCamera();
  if (recordingUrl) URL.revokeObjectURL(recordingUrl);
});

async function start() {
  try {
    setStatus("Loading detection and similarity models…");

    [detector, mobileNetModel] = await Promise.all([
      cocoSsd.load(),
      mobilenet.load({ version: 2, alpha: 1.0 })
    ]);

    setStatus("Ready. Choose a file to scan, or open Live Camera.");
  } catch (error) {
    console.error(error);
    setStatus(`Could not load models: ${error.message}`);
  }
}

start();

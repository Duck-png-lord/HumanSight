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
let gifStartedAt = 0;
let gifAnimationId = null;
let gifTotalDuration = 0;

let scanResultsByTime = [];
let timelineDragging = false;

const MAX_SCAN_MS = 30_000;
const TARGET_SCAN_MS = 5_000;
const MAX_VIDEO_FRAMES = 45;
const MAX_GIF_FRAMES = 60;

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
  return file.type.startsWith("video/") ||
    /\.(mp4|webm|mov|m4v|ogv)$/i.test(file.name);
}

function isGifFile(file) {
  return file.type === "image/gif" || /\.gif$/i.test(file.name);
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;

  const minutes = Math.floor(seconds / 60);
  const remaining = Math.floor(seconds % 60);

  return `${minutes}:${String(remaining).padStart(2, "0")}`;
}

function mediaDuration() {
  if (scanMode === "video") {
    const duration = $("scanVideo").duration;
    return Number.isFinite(duration) ? duration : 0;
  }

  if (scanMode === "gif") return gifTotalDuration / 1000;
  return 0;
}

function currentMediaTime() {
  if (scanMode === "video") return $("scanVideo").currentTime || 0;

  if (scanMode === "gif" && gifFrames.length) {
    let elapsed = 0;

    for (let i = 0; i < gifFrameIndex; i++) {
      elapsed += gifFrames[i].delay;
    }

    if (isGifPlaying()) {
      elapsed += performance.now() - gifStartedAt;
    }

    return Math.min(elapsed / 1000, gifTotalDuration / 1000);
  }

  return 0;
}

function isGifPlaying() {
  return gifAnimationId !== null;
}

function updateMediaControls() {
  const controls = $("mediaControls");
  const duration = mediaDuration();

  const hasTimeline =
    (scanMode === "video" && Number.isFinite($("scanVideo").duration)) ||
    (scanMode === "gif" && gifFrames.length > 0);

  controls.hidden = !hasTimeline;

  if (!hasTimeline) return;

  const time = Math.min(currentMediaTime(), duration);
  $("mediaCurrentTime").textContent = formatTime(time);
  $("mediaDuration").textContent = formatTime(duration);

  if (!timelineDragging && duration > 0) {
    $("mediaTimeline").value = String(Math.round((time / duration) * 1000));
  }

  updatePlayButton();
}

function updatePlayButton() {
  const button = $("mediaPlayButton");
  const isMedia = scanMode === "video" ||
    (scanMode === "gif" && gifFrames.length > 0);

  button.hidden = !isMedia;

  let playing = false;

  if (scanMode === "video") {
    playing = !$("scanVideo").paused && !$("scanVideo").ended;
  } else if (scanMode === "gif") {
    playing = isGifPlaying();
  }

  button.textContent = playing ? "❚❚" : "▶";
  button.setAttribute("aria-label", playing ? "Pause media" : "Play media");
}

function frameDimensions() {
  if (scanMode === "video") {
    const video = $("scanVideo");
    return { width: video.videoWidth, height: video.videoHeight };
  }

  if (scanMode === "gif" && gifFrames.length) {
    return {
      width: gifFrames[0].canvas.width,
      height: gifFrames[0].canvas.height
    };
  }

  const image = $("scanPreview");
  return { width: image.naturalWidth, height: image.naturalHeight };
}

function getDisplayedFrameRect() {
  const stage = $("scanStage");
  const { width, height } = frameDimensions();

  if (!width || !height) return null;

  const scale = Math.min(stage.clientWidth / width, stage.clientHeight / height);
  const displayWidth = width * scale;
  const displayHeight = height * scale;

  return {
    x: (stage.clientWidth - displayWidth) / 2,
    y: (stage.clientHeight - displayHeight) / 2,
    scale
  };
}

function estimateHeadBox([x, y, width, height]) {
  const headWidth = width * 0.48;
  const headHeight = height * 0.22;

  return [
    x + (width - headWidth) / 2,
    y + height * 0.025,
    headWidth,
    headHeight
  ];
}

function drawBoxes() {
  const canvas = $("boxCanvas");
  const stage = $("scanStage");
  const dpr = window.devicePixelRatio || 1;

  canvas.width = Math.round(stage.clientWidth * dpr);
  canvas.height = Math.round(stage.clientHeight * dpr);
  canvas.style.width = `${stage.clientWidth}px`;
  canvas.style.height = `${stage.clientHeight}px`;

  const context = canvas.getContext("2d");
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, stage.clientWidth, stage.clientHeight);

  const displayed = getDisplayedFrameRect();
  if (!displayed) return;

  for (const detection of detections) {
    const [x, y, width, height] = detection.bbox;
    const px = displayed.x + x * displayed.scale;
    const py = displayed.y + y * displayed.scale;
    const pw = width * displayed.scale;
    const ph = height * displayed.scale;

    context.lineWidth = 3;
    context.strokeStyle = "#17d895";
    context.strokeRect(px, py, pw, ph);

    const label = `Person ${(detection.score * 100).toFixed(0)}%`;
    context.font = "bold 13px system-ui, sans-serif";
    const labelWidth = context.measureText(label).width + 12;
    const labelY = Math.max(0, py - 23);

    context.fillStyle = "#17d895";
    context.fillRect(px, labelY, labelWidth, 23);
    context.fillStyle = "#10251d";
    context.fillText(label, px + 6, labelY + 16);

    if ($("headToggle").checked) {
      const head = estimateHeadBox(detection.bbox);
      const hx = displayed.x + head[0] * displayed.scale;
      const hy = displayed.y + head[1] * displayed.scale;
      const hw = head[2] * displayed.scale;
      const hh = head[3] * displayed.scale;

      context.lineWidth = 2.5;
      context.strokeStyle = "#a855f7";
      context.strokeRect(hx, hy, hw, hh);

      context.fillStyle = "#a855f7";
      context.fillRect(hx, Math.max(0, hy - 20), 54, 20);
      context.fillStyle = "#fff";
      context.font = "bold 12px system-ui, sans-serif";
      context.fillText("Head*", hx + 6, Math.max(14, hy - 6));
    }
  }
}

function clearBoxes() {
  detections = [];
  const canvas = $("boxCanvas");
  canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
}

function iou(a, b) {
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
    const areaRatio = (boxWidth * boxHeight) / frameArea;

    return areaRatio < 0.72 &&
      boxWidth / width < 0.92 &&
      boxHeight / height < 0.97;
  });

  const sorted = plausible.sort((a, b) => b.score - a.score);
  const kept = [];

  for (const item of sorted) {
    if (!kept.some(existing => iou(existing, item) > 0.5)) {
      kept.push(item);
    }
  }

  return kept;
}

async function detectFrame(source) {
  const { width, height } = frameDimensions();
  const results = await detector.detect(source, 20, 0.25);
  return filterDetections(results, width, height);
}

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

    const cleanup = () => {
      target.removeEventListener(eventName, onSuccess);
      target.removeEventListener("error", onError);
    };

    target.addEventListener(eventName, onSuccess, { once: true });
    target.addEventListener("error", onError, { once: true });
  });
}

function waitForVideoFrame(video, timeoutMs = 2000) {
  if (video.readyState >= 2) return Promise.resolve();

  return Promise.race([
    waitForEvent(video, "loadeddata"),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Timed out waiting for video frame.")), timeoutMs)
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
    }, 2000);

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
    gifAnimationId = null;
  }
}

function drawGifFrame(index) {
  if (!gifFrames.length) return;

  gifFrameIndex = (index + gifFrames.length) % gifFrames.length;

  const canvas = $("gifCanvas");
  const frame = gifFrames[gifFrameIndex];

  canvas.width = frame.canvas.width;
  canvas.height = frame.canvas.height;

  const context = canvas.getContext("2d");
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(frame.canvas, 0, 0);

  const timestamp = gifFrames
    .slice(0, gifFrameIndex)
    .reduce((sum, item) => sum + item.delay, 0);

  detections = findDetectionsNearTime(timestamp / 1000);
  drawBoxes();
  updateMediaControls();
}

function playGif() {
  if (!gifFrames.length || gifAnimationId !== null) return;

  gifStartedAt = performance.now();
  let lastFrameSwitch = performance.now();

  const animate = now => {
    if (gifAnimationId === null) return;

    const frame = gifFrames[gifFrameIndex];
    const delay = Math.max(20, frame.delay);

    if (now - lastFrameSwitch >= delay) {
      lastFrameSwitch = now;

      if (gifFrameIndex >= gifFrames.length - 1) {
        drawGifFrame(0);
      } else {
        drawGifFrame(gifFrameIndex + 1);
      }
    }

    updateMediaControls();
    gifAnimationId = requestAnimationFrame(animate);
  };

  gifAnimationId = requestAnimationFrame(animate);
  updatePlayButton();
}

function pauseGif() {
  stopGifPlayback();
  updateMediaControls();
}

async function decodeGif(file) {
  if (!window.gifuct) {
    throw new Error("GIF decoder did not load. Check your internet connection.");
  }

  const buffer = await file.arrayBuffer();
  const parsed = window.gifuct.parseGIF(buffer);
  const decompressed = window.gifuct.decompressFrames(parsed, true);

  if (!decompressed.length) {
    throw new Error("The GIF contains no readable frames.");
  }

  const frames = decompressed.slice(0, MAX_GIF_FRAMES);
  const width = parsed.lsd.width;
  const height = parsed.lsd.height;
  const patchCanvas = document.createElement("canvas");
  patchCanvas.width = width;
  patchCanvas.height = height;

  const patchContext = patchCanvas.getContext("2d");
  const priorImage = document.createElement("canvas");
  priorImage.width = width;
  priorImage.height = height;

  const priorContext = priorImage.getContext("2d");
  const outputFrames = [];

  for (const frame of frames) {
    if (frame.disposalType === 3) {
      priorContext.clearRect(0, 0, width, height);
      priorContext.drawImage(patchCanvas, 0, 0);
    }

    const imageData = new ImageData(
      new Uint8ClampedArray(frame.patch),
      frame.dims.width,
      frame.dims.height
    );

    patchContext.putImageData(imageData, frame.dims.left, frame.dims.top);

    const renderedFrame = document.createElement("canvas");
    renderedFrame.width = width;
    renderedFrame.height = height;
    renderedFrame.getContext("2d").drawImage(patchCanvas, 0, 0);

    outputFrames.push({
      canvas: renderedFrame,
      delay: Math.max(20, (frame.delay || 10) * 10)
    });

    if (frame.disposalType === 2) {
      patchContext.clearRect(
        frame.dims.left,
        frame.dims.top,
        frame.dims.width,
        frame.dims.height
      );
    } else if (frame.disposalType === 3) {
      patchContext.clearRect(0, 0, width, height);
      patchContext.drawImage(priorImage, 0, 0);
    }
  }

  gifFrames = outputFrames;
  gifTotalDuration = gifFrames.reduce((sum, frame) => sum + frame.delay, 0);
  gifFrameIndex = 0;
  drawGifFrame(0);
}

function findDetectionsNearTime(time) {
  if (!scanResultsByTime.length) return [];

  let nearest = scanResultsByTime[0];
  let nearestDistance = Math.abs(nearest.time - time);

  for (const item of scanResultsByTime) {
    const distance = Math.abs(item.time - time);

    if (distance < nearestDistance) {
      nearest = item;
      nearestDistance = distance;
    }
  }

  return nearest ? nearest.detections : [];
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
  $("feedbackNote").textContent = "Feedback saving is for still images only.";
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
      await waitForVideoFrame(video);

      video.classList.add("visible");
      $("mediaControls").hidden = false;
    } else if (isGifFile(file)) {
      scanMode = "gif";
      await decodeGif(file);
      gifCanvas.classList.add("visible");
      $("mediaControls").hidden = false;
      setStatus("GIF loaded. Use the timeline to seek and the button to play/pause.");
    } else {
      scanMode = "image";
      image.src = scanUrl;
      await waitForEvent(image, "load");
      image.classList.add("visible");
      $("mediaControls").hidden = true;
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

  updatePlayButton();
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
    if (isGifPlaying()) pauseGif();
    else playGif();
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
  const time = (Number($("mediaTimeline").value) / 1000) * duration;

  $("mediaCurrentTime").textContent = formatTime(time);

  if (scanMode === "video") {
    $("scanVideo").currentTime = time;
  } else if (scanMode === "gif" && gifFrames.length) {
    const targetMs = time * 1000;
    let accumulated = 0;
    let index = 0;

    for (; index < gifFrames.length - 1; index++) {
      if (accumulated + gifFrames[index].delay >= targetMs) break;
      accumulated += gifFrames[index].delay;
    }

    drawGifFrame(index);
  }
});

$("mediaTimeline").addEventListener("change", () => {
  timelineDragging = false;
  updateMediaControls();
});

async function scanStillImage() {
  const image = $("scanPreview");
  const results = await detectFrame(image);

  detections = results;
  drawBoxes();

  return results;
}

async function scanGif() {
  const sampled = [];
  const started = performance.now();
  const total = gifFrames.length;
  const step = Math.max(1, Math.ceil(total / MAX_GIF_FRAMES));

  pauseGif();

  for (let index = 0; index < total; index += step) {
    if (performance.now() - started >= TARGET_SCAN_MS) break;

    drawGifFrame(index);
    const found = await detectFrame($("gifCanvas"));
    const time = gifFrames
      .slice(0, index)
      .reduce((sum, frame) => sum + frame.delay, 0) / 1000;

    sampled.push({ time, detections: found });
    detections = found;
    drawBoxes();

    const sampleNumber = sampled.length;
    setProgress(`Scanning GIF frame ${index + 1} of ${total}…`,
      Math.min(99, Math.round((index / Math.max(1, total - 1)) * 100)));

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
  const estimatedCostPerFrame = 300;
  const estimatedAvailable = Math.max(1, Math.floor(MAX_SCAN_MS / estimatedCostPerFrame));
  const frameCount = Math.min(MAX_VIDEO_FRAMES, estimatedAvailable);
  const sampled = [];

  video.pause();

  for (let index = 0; index < frameCount; index++) {
    if (performance.now() - started >= MAX_SCAN_MS) break;

    const time = frameCount <= 1
      ? 0
      : (index / (frameCount - 1)) * Math.max(0, duration - 0.03);

    await seekVideo(video, time);

    const found = await detectFrame(video);
    sampled.push({ time, detections: found });
    detections = found;
    drawBoxes();

    setProgress(
      `Scanning video frame ${index + 1} of ${frameCount}…`,
      Math.round(((index + 1) / frameCount) * 100)
    );

    if (performance.now() - started >= MAX_SCAN_MS) break;
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
    $("prediction").textContent =
      `${results.length} person detection${results.length === 1 ? "" : "s"} found`;

    const bestScore = Math.max(...results.map(item => item.score));
    $("confidence").textContent =
      `Highest box confidence: ${(bestScore * 100).toFixed(0)}%`;
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
  $("confidence").textContent = "";
  predictionLabel = null;
  scanResultsByTime = [];
  clearBoxes();

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

    finishPrediction(results);
    setProgress("Scan complete.", 100);

    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    setStatus(`Scan complete in ${seconds}s.`);
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
window.addEventListener("resize", drawBoxes);

async function saveFeedback(wasCorrect) {
  if (!scanFile || !predictionLabel || scanMode !== "image" || isGifFile(scanFile)) {
    return;
  }

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

  const preview = $("searchPreview");

  if (preview.dataset.url) {
    URL.revokeObjectURL(preview.dataset.url);
  }

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

  if (!detector || !mobileNetModel) {
    $("searchMessage").textContent = "Models are still loading. Try again shortly.";
    return;
  }

  $("searchButton").disabled = true;
  $("searchResults").replaceChildren();
  $("searchMessage").textContent = "Checking whether the image contains a person…";

  let queryEmbedding = null;

  try {
    const preview = $("searchPreview");
    const predictions = await detector.detect(preview, 10, 0.35);

    if (!predictions.some(item => item.class === "person")) {
      $("searchMessage").textContent =
        "No person detected, so the Person image collection was not searched.";
      return;
    }

    $("searchMessage").textContent = "Searching saved Person images…";
    queryEmbedding = mobileNetModel.infer(preview, true);

    const images = await request("/api/images");
    const results = [];

    for (const item of images.person || []) {
      let databaseEmbedding;

      try {
        const image = await loadImage(item.url);
        databaseEmbedding = mobileNetModel.infer(image, true);

        const similarity = tf.tidy(() => {
          const a = queryEmbedding.flatten();
          const b = databaseEmbedding.flatten();

          return tf.sum(tf.mul(a, b))
            .div(tf.norm(a).mul(tf.norm(b)))
            .dataSync()[0];
        });

        results.push({
          ...item,
          similarity: Number.isFinite(similarity) ? similarity : -1
        });
      } catch (error) {
        console.warn(`Skipping ${item.name}:`, error);
      } finally {
        if (databaseEmbedding) databaseEmbedding.dispose();
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
    console.error(error);
    $("searchMessage").textContent = `Search failed: ${error.message}`;
  } finally {
    if (queryEmbedding) queryEmbedding.dispose();
    $("searchButton").disabled = false;
  }
});

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not load database image."));
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
    score.textContent =
      `Visual similarity: ${Math.max(0, item.similarity * 100).toFixed(1)}%`;

    details.append(name, score);
    card.append(image, details);
    container.append(card);
  }
}

document.querySelectorAll(".tab-button").forEach(button => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".tab-button")
      .forEach(tab => tab.classList.remove("active"));
    document.querySelectorAll(".tab-panel")
      .forEach(panel => panel.classList.remove("active"));

    button.classList.add("active");
    $(button.dataset.tab).classList.add("active");
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

setupUploader("personInput", "personDrop", "person");
setupUploader("otherInput", "otherDrop", "not-person");

function setupUploader(inputId, dropId, label) {
  const input = $(inputId);
  const dropzone = $(dropId);

  input.addEventListener("change", async event => {
    await uploadTrainingFiles(event.target.files, label);
    input.value = "";
  });

  dropzone.addEventListener("dragover", event => {
    event.preventDefault();
    dropzone.classList.add("dragover");
  });

  dropzone.addEventListener("dragleave", () => {
    dropzone.classList.remove("dragover");
  });

  dropzone.addEventListener("drop", event => {
    event.preventDefault();
    dropzone.classList.remove("dragover");
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
    setStatus("Images saved in the training folder.");
  } catch (error) {
    setStatus(`Upload failed: ${error.message}`);
  }
}

async function start() {
  try {
    setStatus("Loading detection and similarity models…");

    [detector, mobileNetModel] = await Promise.all([
      cocoSsd.load(),
      mobilenet.load({ version: 2, alpha: 1.0 })
    ]);

    setStatus("Ready. Choose an image, GIF, or video to scan.");
  } catch (error) {
    console.error(error);
    setStatus(`Could not load models: ${error.message}`);
  }
}

start();

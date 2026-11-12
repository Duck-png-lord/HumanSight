let detector = null;
let mobileNetModel = null;
let scanFile = null;
let searchFile = null;
let predictionLabel = null;
let detections = [];
let scanMode = "image";
let scanUrl = null;
let scanTimer = null;
let scanBusy = false;

const MAX_SCAN_MS = 30_000;
const TARGET_SCAN_MS = 5_000;
const MAX_VIDEO_FRAMES = 45;
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

function frameDimensions() {
  if (scanMode === "video") {
    const video = $("scanVideo");
    return { width: video.videoWidth, height: video.videoHeight };
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

  const showHeads = $("headToggle").checked;

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

    if (showHeads) {
      const head = estimateHeadBox(detection.bbox);
      const hx = displayed.x + head[0] * displayed.scale;
      const hy = displayed.y + head[1] * displayed.scale;
      const hw = head[2] * displayed.scale;
      const hh = head[3] * displayed.scale;

      context.lineWidth = 2.5;
      context.strokeStyle = "#a855f7";
      context.strokeRect(hx, hy, hw, hh);

      context.fillStyle = "#a855f7";
      context.fillRect(hx, Math.max(0, hy - 20), 48, 20);
      context.fillStyle = "#fff";
      context.font = "bold 12px system-ui, sans-serif";
      context.fillText("Head", hx + 6, Math.max(14, hy - 6));
    }
  }
}

/*
 * COCO-SSD does not provide head detections. This makes an approximate
 * head-region box from the upper part of each person box.
 */
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
  const frameArea = width * height;

  // Reject near-full-frame boxes and tiny low-quality detections.
  const plausible = results.filter(item => {
    if (item.class !== "person" || item.score < 0.4) return false;

    const [, , boxWidth, boxHeight] = item.bbox;
    const areaRatio = (boxWidth * boxHeight) / frameArea;
    const widthRatio = boxWidth / width;
    const heightRatio = boxHeight / height;

    return areaRatio < 0.72 && widthRatio < 0.92 && heightRatio < 0.97;
  });

  const sorted = plausible.sort((a, b) => b.score - a.score);
  const kept = [];

  for (const item of sorted) {
    if (!kept.some(existing => iou(existing, item) > 0.5)) kept.push(item);
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

function waitForVideoFrame(video, timeoutMs = 1500) {
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
    }, 1500);

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

function setScanPreview(file) {
  if (scanUrl) URL.revokeObjectURL(scanUrl);
  scanUrl = URL.createObjectURL(file);
  scanFile = file;
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
  image.classList.remove("visible");
  video.classList.remove("visible");
  $("scanPlaceholder").hidden = true;

  try {
    if (isVideoFile(file)) {
      scanMode = "video";
      video.src = scanUrl;
      video.load();
      await waitForEvent(video, "loadedmetadata");
      await waitForVideoFrame(video);
      video.currentTime = 0;
      await waitForVideoFrame(video);
      video.classList.add("visible");
      drawBoxes();
    } else {
      scanMode = "image";
      image.src = scanUrl;
      await waitForEvent(image, "load");
      image.classList.add("visible");

      if (isGifFile(file)) {
        setStatus("GIF selected. Its animation will be scanned.");
      }
      drawBoxes();
    }

    $("prediction").textContent = "Ready to scan";
    setStatus("File ready. Start the scan when you’re ready.");
  } catch (error) {
    $("scanPlaceholder").hidden = false;
    setStatus(`Could not load file: ${error.message}`);
  }

  event.target.value = "";
});

async function scanStillImage() {
  const image = $("scanPreview");
  const isAnimatedGif = isGifFile(scanFile);
  const source = image;

  if (!isAnimatedGif) {
    const results = await detectFrame(source);
    detections = results;
    drawBoxes();
    return results;
  }

  /*
   * Animated GIFs are rendered by the browser as an animated image.
   * Sample the current displayed frame repeatedly; the browser continues
   * animating during the small delay between samples.
   */
  const sampled = [];
  const started = performance.now();
  let count = 0;

  while (count < 12 && performance.now() - started < TARGET_SCAN_MS) {
    sampled.push(...await detectFrame(source));
    count++;
    setProgress(`Scanning GIF frame ${count}…`, Math.min(95, count * 8));
    await new Promise(resolve => setTimeout(resolve, 180));
  }

  const { width, height } = frameDimensions();
  detections = mergeFrameResults(sampled, width, height);
  drawBoxes();
  return detections;
}

function mergeFrameResults(results, width, height) {
  return filterDetections(results, width, height);
}

async function scanVideo() {
  const video = $("scanVideo");
  const duration = Number.isFinite(video.duration) ? video.duration : 0;

  if (!duration) {
    throw new Error("Video duration is unavailable.");
  }

  const started = performance.now();
  const estimatedCostPerFrame = 300;
  const estimatedAvailable = Math.max(1, Math.floor(MAX_SCAN_MS / estimatedCostPerFrame));
  const frameCount = Math.min(MAX_VIDEO_FRAMES, estimatedAvailable);
  const frameStep = frameCount <= 2 ? duration : duration / (frameCount - 1);
  const sampled = [];

  video.pause();

  for (let index = 0; index < frameCount; index++) {
    if (performance.now() - started >= MAX_SCAN_MS) break;

    const time = Math.min(duration - 0.02, index * frameStep);
    await seekVideo(video, Math.max(0, time));

    const found = await detectFrame(video);
    sampled.push(...found);
    detections = found;
    drawBoxes();

    const percent = Math.round(((index + 1) / frameCount) * 100);
    setProgress(`Scanning video frame ${index + 1} of ${frameCount}…`, percent);

    if (performance.now() - started >= MAX_SCAN_MS) break;
  }

  if (sampled.length) {
    /*
     * Keep the detections from the most recently analyzed frame on screen.
     * This avoids drawing unrelated boxes from different video positions
     * over the same frame.
     */
    drawBoxes();
  }

  video.currentTime = 0;
  return detections;
}

function finishPrediction(results) {
  if (results.length) {
    predictionLabel = "person";
    $("prediction").textContent =
      `${results.length} ${results.length === 1 ? "person" : "people"} detected`;

    const bestScore = Math.max(...results.map(item => item.score));
    $("confidence").textContent =
      `Highest box confidence: ${(bestScore * 100).toFixed(0)}%`;

    if (scanMode === "image" && !isGifFile(scanFile)) {
      $("correctButton").disabled = false;
      $("incorrectButton").disabled = false;
    }
  } else {
    predictionLabel = "not-person";
    $("prediction").textContent = "No person detected";

    if (scanMode === "image" && !isGifFile(scanFile)) {
      $("correctButton").disabled = false;
      $("incorrectButton").disabled = false;
    }
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
  clearBoxes();

  const started = performance.now();
  scanTimer = setTimeout(() => {
    if (scanBusy) {
      setStatus("Scan is taking longer than expected. Waiting for the current frame…");
    }
  }, MAX_SCAN_MS);

  try {
    setProgress("Preparing scan…", 0);

    const results = scanMode === "video"
      ? await scanVideo()
      : await scanStillImage();

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
    clearTimeout(scanTimer);
    scanTimer = null;
    scanBusy = false;
    $("scanButton").disabled = false;
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

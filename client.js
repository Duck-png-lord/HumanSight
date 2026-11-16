"use strict";

const $ = id => document.getElementById(id);

let detector = null;
let modelsReady = false;

let liveStream = null;
let liveRunning = false;
let liveBusy = false;
let liveLoopId = null;
let liveDetections = [];
let lastLiveDetection = 0;

let bufferRecorder = null;
let bufferChunks = [];
let bufferMimeType = "";
let bufferStartedAt = 0;
let bufferTimer = null;
let downloadBusy = false;

let recordingCanvas = null;
let recordingCanvasContext = null;
let recordingDrawLoop = null;
let activeExportCanvasStream = null;
let activeExportRecorder = null;
let exportChunks = [];
let exportTimeout = null;

const BUFFER_SECONDS = 60;
const BUFFER_SLICE_MS = 1000;
const BUFFER_MAX_BYTES = 100 * 1024 * 1024;
const LIVE_DETECTION_INTERVAL = 300;
const EXPORT_TIMEOUT_MS = 30000;

function setStatus(message) {
  $("status").textContent = message;
}

function setLiveStatus(message) {
  $("liveStatus").textContent = message;
}

function setBufferStatus(message) {
  $("bufferStatus").textContent = message;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;

  const wholeSeconds = Math.floor(seconds);
  const minutes = Math.floor(wholeSeconds / 60);
  const remainder = wholeSeconds % 60;

  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

/* Theme */

function setupTheme() {
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
}

/* Detection overlays */

function containedRect(stage, sourceWidth, sourceHeight) {
  if (
    !sourceWidth ||
    !sourceHeight ||
    !stage.clientWidth ||
    !stage.clientHeight
  ) {
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

function drawHumanSightLogo(context, x, y, scale = 1) {
  const text = "HumanSight";
  const padding = 8 * scale;
  const height = 28 * scale;
  const fontSize = 14 * scale;

  context.save();
  context.font = `bold ${fontSize}px system-ui, sans-serif`;

  const width = context.measureText(text).width + padding * 2;

  context.fillStyle = "rgba(0, 0, 0, 0.68)";
  context.beginPath();
  context.roundRect(x, y, width, height, 7 * scale);
  context.fill();

  context.fillStyle = "#ffffff";
  context.textBaseline = "middle";
  context.fillText(text, x + padding, y + height / 2);
  context.restore();

  return { width, height };
}

function drawLiveOverlay(context, width, height, options = {}) {
  const showHeads = $("liveHeadToggle").checked;
  const mirrorImage = options.mirrorImage === true;

  context.clearRect(0, 0, width, height);

  for (const result of liveDetections) {
    const [x, y, boxWidth, boxHeight] = result.bbox;
    const boxX = mirrorImage ? width - x - boxWidth : x;

    context.lineWidth = Math.max(3, width / 320);
    context.strokeStyle = "#17d895";
    context.strokeRect(boxX, y, boxWidth, boxHeight);

    const label = `Person ${(result.score * 100).toFixed(0)}%`;
    const fontSize = Math.max(14, width / 50);
    const labelHeight = Math.max(25, width / 45);

    context.font = `bold ${fontSize}px system-ui, sans-serif`;

    const labelWidth = context.measureText(label).width + 12;
    const labelY = Math.max(0, y - labelHeight);

    context.fillStyle = "#17d895";
    context.fillRect(boxX, labelY, labelWidth, labelHeight);

    context.fillStyle = "#10251d";
    context.textBaseline = "middle";
    context.fillText(
      label,
      boxX + 6,
      labelY + labelHeight / 2
    );

    if (showHeads) {
      const headWidth = boxWidth * 0.48;
      const headHeight = boxHeight * 0.22;
      const headX = x + (boxWidth - headWidth) / 2;
      const mirroredHeadX = mirrorImage
        ? width - headX - headWidth
        : headX;
      const headY = y + boxHeight * 0.025;

      context.lineWidth = Math.max(2, width / 500);
      context.strokeStyle = "#a855f7";
      context.strokeRect(
        mirroredHeadX,
        headY,
        headWidth,
        headHeight
      );
    }
  }

  const logoScale = Math.max(1, width / 640);
  const logoHeight = 28 * logoScale;
  const logoY = height - logoHeight - 10 * logoScale;

  drawHumanSightLogo(
    context,
    width - 10 * logoScale,
    logoY,
    logoScale
  );
}

function drawLiveCanvas() {
  const video = $("liveVideo");
  const canvas = $("liveCanvas");
  const stage = $("liveStage");

  if (!video.videoWidth || !video.videoHeight) return;

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

  const rect = containedRect(stage, video.videoWidth, video.videoHeight);
  if (!rect) return;

  // Draw detection overlays in the same fitted area as the video.
  context.save();
  context.translate(rect.x, rect.y);
  context.scale(rect.scale, rect.scale);
  drawLiveOverlay(context, video.videoWidth, video.videoHeight, {
    mirrorImage: false
  });
  context.restore();
}

function filterPeople(results, width, height) {
  if (!width || !height) return [];

  return results.filter(item => {
    if (item.class !== "person" || item.score < 0.35) return false;

    const [, , boxWidth, boxHeight] = item.bbox;

    return boxWidth / width < 0.98 && boxHeight / height < 0.99;
  });
}

/* Camera and detection */

async function startCamera() {
  if (liveRunning) return;

  if (!navigator.mediaDevices?.getUserMedia) {
    setLiveStatus("Camera access requires HTTPS or localhost.");
    return;
  }

  if (!modelsReady) {
    setLiveStatus("Detection model is still loading.");
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

    setLiveStatus("Camera on. Detecting people locally.");
    startRollingBuffer();
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

    setLiveStatus(
      error.name === "NotAllowedError"
        ? "Camera access denied. Allow camera access and try again."
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

      drawLiveCanvas();

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

/* Rolling 60-second recording buffer */

function supportedRecordingFormat() {
  if (!window.MediaRecorder) return null;

  const types = [
    { mimeType: "video/mp4;codecs=avc1.42E01E", extension: "mp4" },
    { mimeType: "video/mp4", extension: "mp4" },
    { mimeType: "video/webm;codecs=vp9", extension: "webm" },
    { mimeType: "video/webm;codecs=vp8", extension: "webm" },
    { mimeType: "video/webm", extension: "webm" }
  ];

  return types.find(item => MediaRecorder.isTypeSupported(item.mimeType)) || null;
}

function updateBufferStatus() {
  if (!bufferStartedAt || !bufferRecorder) return;

  const elapsed = Math.min(
    BUFFER_SECONDS,
    Math.floor((Date.now() - bufferStartedAt) / 1000)
  );

  setBufferStatus(
    `Rolling buffer: ${formatTime(elapsed)} / 1:00. Older video is discarded automatically.`
  );

  $("downloadBufferButton").disabled = elapsed < 1 || downloadBusy;
}

function startRollingBuffer() {
  stopRollingBuffer();

  const format = supportedRecordingFormat();

  if (!format) {
    setBufferStatus("This browser does not support video recording.");
    $("downloadBufferButton").disabled = true;
    return;
  }

  if (!HTMLCanvasElement.prototype.captureStream) {
    setBufferStatus("Canvas recording is not supported in this browser.");
    $("downloadBufferButton").disabled = true;
    return;
  }

  const video = $("liveVideo");

  recordingCanvas = document.createElement("canvas");
  recordingCanvas.width = video.videoWidth || 640;
  recordingCanvas.height = video.videoHeight || 480;
  recordingCanvasContext = recordingCanvas.getContext("2d");
  bufferMimeType = format.mimeType;
  bufferChunks = [];
  bufferStartedAt = Date.now();

  const canvasStream = recordingCanvas.captureStream(30);

  try {
    bufferRecorder = new MediaRecorder(canvasStream, {
      mimeType: format.mimeType,
      videoBitsPerSecond: 2_000_000
    });
  } catch (error) {
    canvasStream.getTracks().forEach(track => track.stop());
    recordingCanvas = null;
    recordingCanvasContext = null;
    bufferStartedAt = 0;

    console.error(error);
    setBufferStatus(`Could not start rolling buffer: ${error.message}`);
    $("downloadBufferButton").disabled = true;
    return;
  }

  bufferRecorder.addEventListener("dataavailable", event => {
    if (!event.data || !event.data.size) return;

    bufferChunks.push({
      blob: event.data,
      time: Date.now()
    });

    trimBuffer();
    updateBufferStatus();
  });

  bufferRecorder.addEventListener("error", event => {
    console.error(event.error);
    setBufferStatus("Recording buffer stopped because of an error.");
  });

  drawRecordingFrame();
  bufferRecorder.start(BUFFER_SLICE_MS);

  bufferTimer = setInterval(() => {
    trimBuffer();
    updateBufferStatus();
  }, 1000);

  setBufferStatus("Rolling buffer started. It keeps up to the latest 60 seconds.");
  $("downloadBufferButton").disabled = true;
}

function drawRecordingFrame() {
  if (!recordingCanvas || !recordingCanvasContext || !liveRunning) return;

  const video = $("liveVideo");
  const width = video.videoWidth;
  const height = video.videoHeight;

  if (width && height) {
    if (recordingCanvas.width !== width || recordingCanvas.height !== height) {
      recordingCanvas.width = width;
      recordingCanvas.height = height;
    }

    // The recorded video, boxes, head boxes, and logo are composited together.
    recordingCanvasContext.save();
    recordingCanvasContext.translate(width, 0);
    recordingCanvasContext.scale(-1, 1);
    recordingCanvasContext.drawImage(video, 0, 0, width, height);
    recordingCanvasContext.restore();

    drawLiveOverlay(recordingCanvasContext, width, height, {
      mirrorImage: true
    });
  }

  recordingDrawLoop = requestAnimationFrame(drawRecordingFrame);
}

function trimBuffer() {
  const cutoff = Date.now() - BUFFER_SECONDS * 1000;

  while (bufferChunks.length && bufferChunks[0].time < cutoff) {
    bufferChunks.shift();
  }

  let totalBytes = bufferChunks.reduce(
    (total, entry) => total + entry.blob.size,
    0
  );

  while (bufferChunks.length > 1 && totalBytes > BUFFER_MAX_BYTES) {
    const removed = bufferChunks.shift();
    totalBytes -= removed.blob.size;
  }
}

function stopRollingBuffer() {
  clearInterval(bufferTimer);
  bufferTimer = null;

  if (bufferRecorder && bufferRecorder.state !== "inactive") {
    try {
      bufferRecorder.stop();
    } catch (error) {
      console.warn("Could not stop rolling recorder:", error);
    }
  }

  if (recordingDrawLoop !== null) {
    cancelAnimationFrame(recordingDrawLoop);
  }

  recordingDrawLoop = null;

  if (bufferRecorder?.stream) {
    bufferRecorder.stream.getTracks().forEach(track => track.stop());
  }

  bufferRecorder = null;
  recordingCanvas = null;
  recordingCanvasContext = null;
  bufferStartedAt = 0;
  bufferChunks = [];

  $("downloadBufferButton").disabled = true;
  setBufferStatus("Rolling buffer stopped.");
}

function waitForExportStop(recorder) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out preparing the video download."));
    }, EXPORT_TIMEOUT_MS);

    recorder.addEventListener("stop", () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });

    recorder.addEventListener("error", event => {
      clearTimeout(timeout);
      reject(event.error || new Error("Video export failed."));
    }, { once: true });
  });
}

async function downloadLast60Seconds() {
  if (downloadBusy) return;

  trimBuffer();

  const chunks = bufferChunks.map(entry => entry.blob);

  if (!chunks.length) {
    $("recordingStatus").textContent =
      "The rolling buffer is not ready yet.";
    return;
  }

  if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) {
    $("recordingStatus").textContent =
      "This browser cannot export the rolling video.";
    return;
  }

  downloadBusy = true;
  $("downloadBufferButton").disabled = true;
  $("recordingStatus").textContent = "Preparing your last 60 seconds…";

  try {
    // Periodic MediaRecorder chunks share one continuous recording stream.
    // Recombine them with the original MIME type rather than re-encoding.
    const blob = new Blob(chunks, { type: bufferMimeType });

    if (!blob.size) throw new Error("No recorded video data is available.");

    const format = supportedRecordingFormat();
    const extension = format?.extension || "webm";
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = `humansight-last-60-seconds-${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")}.${extension}`;

    document.body.appendChild(link);
    link.click();
    link.remove();

    setTimeout(() => URL.revokeObjectURL(url), 60_000);

    $("recordingStatus").textContent =
      "Download started. Detection boxes and HumanSight logo are included.";
  } catch (error) {
    console.error(error);
    $("recordingStatus").textContent =
      `Could not download the buffer: ${error.message}`;
  } finally {
    downloadBusy = false;
    updateBufferStatus();
  }
}

/* Stop camera */

function stopCamera() {
  liveRunning = false;

  if (liveLoopId !== null) cancelAnimationFrame(liveLoopId);
  liveLoopId = null;
  liveBusy = false;

  stopRollingBuffer();

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
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, canvas.width, canvas.height);

  $("livePlaceholder").hidden = false;
  $("startCameraButton").disabled = false;
  $("stopCameraButton").disabled = true;

  setLiveStatus("Camera is off.");
}

/* Fullscreen */

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

/* Events */

$("startCameraButton").addEventListener("click", startCamera);
$("stopCameraButton").addEventListener("click", stopCamera);
$("downloadBufferButton").addEventListener("click", downloadLast60Seconds);
$("liveHeadToggle").addEventListener("change", drawLiveCanvas);
$("fullscreenButton").addEventListener("click", toggleFullscreen);

document.addEventListener("fullscreenchange", () => {
  $("fullscreenButton").textContent = document.fullscreenElement
    ? "⛶ Exit full screen"
    : "⛶ Full screen";

  requestAnimationFrame(drawLiveCanvas);
});

window.addEventListener("resize", drawLiveCanvas);

document.addEventListener("visibilitychange", () => {
  if (document.hidden && liveRunning) stopCamera();
});

window.addEventListener("pagehide", stopCamera);

/* Load detection model */

async function loadModel() {
  try {
    setStatus("Loading person detection model…");

    if (!window.tf || !window.cocoSsd) {
      throw new Error(
        "AI scripts did not load. Check your internet connection."
      );
    }

    detector = await window.cocoSsd.load();
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

setupTheme();
loadModel();

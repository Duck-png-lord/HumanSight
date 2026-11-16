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
let buf
1000
ferTimer = null;
let downloadBusy = false;

let recordingCanvas = null;
let recordingCanvasContext = null;
let recordingDrawLoop = null;

const BUFFER_SECONDS = 60;
const BUFFER_SLICE_MS = 1000;
const BUFFER_MAX_BYTES = 100 * 1024 * 1024;
const LIVE_DETECTION_INTERVAL = 300;

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

function drawLiveOverlay(context, width, height, mirrorImage = false) {
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
    context.fillText(label, boxX + 6, labelY + labelHeight / 2);

    if ($("liveHeadToggle").checked) {
      const headWidth = boxWidth * 0.48;
      const headHeight = boxHeight * 0.22;
      const headX = x + (boxWidth - headWidth) / 2;
      const displayHeadX = mirrorImage
        ? width - headX - headWidth
        : headX;
      const headY = y + boxHeight * 0.025;

      context.lineWidth = Math.max(2, width / 500);
      context.strokeStyle = "#a855f7";
      context.strokeRect(displayHeadX, headY, headWidth, headHeight);
    }
  }

  const scale = Math.max(1, width / 640);
  const text = "HumanSight";
  const padding = 8 * scale;
  const logoHeight = 28 * scale;
  const fontSize = 14 * scale;

  context.save();
  context.font = `bold ${fontSize}px system-ui, sans-serif`;

  const logoWidth = context.measureText(text).width + padding * 2;
  const logoX = width - logoWidth - 10 * scale;
  const logoY = height - logoHeight - 10 * scale;

  context.fillStyle = "rgba(0, 0, 0, 0.68)";
  context.beginPath();
  context.roundRect(logoX, logoY, logoWidth, logoHeight, 7 * scale);
  context.fill();

  context.fillStyle = "#ffffff";
  context.textBaseline = "middle";
  context.fillText(text, logoX + padding, logoY + logoHeight / 2);
  context.restore();
}

function drawLiveCanvas() {
  const video = $("liveVideo");
  const canvas = $("liveCanvas");
  const stage = $("liveStage");

  if (!video.videoWidth || !video.videoHeight) return;

  const stageWidth = stage.clientWidth;
  const stageHeight = stage.clientHeight;
  const dpr = window.devicePixelRatio || 1;

  canvas.width = Math.round(stageWidth * dpr);
  canvas.height = Math.round(stageHeight * dpr);
  canvas.style.width = `${stageWidth}px`;
  canvas.style.height = `${stageHeight}px`;

  const context = canvas.getContext("2d");
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0,
1000
 0, stageWidth, stageHeight);

  const scale = Math.min(
    stageWidth / video.videoWidth,
    stageHeight / video.videoHeight
  );

  const displayWidth = video.videoWidth * scale;
  const displayHeight = video.videoHeight * scale;
  const offsetX = (stageWidth - displayWidth) / 2;
  const offsetY = (stageHeight - displayHeight) / 2;

  context.save();
  context.translate(offsetX, offsetY);
  context.scale(scale, scale);
  drawLiveOverlay(context, video.videoWidth, video.videoHeight, false);
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

/* Camera */

async function startCamera() {
  if (liveRunning) return;

  if (!navigator.mediaDevices?.getUserMedia) {
    setLiveStatus("Camera access requires HTTPS or localhost.");
    return;
  }

  if (!modelsReady) {
    setLiveStatus("Detection model is still loading. Please wait.");
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
        ? "Camera access denied. Allow camera permission and try again."
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

/* Rolling 60-second buffer */

function getRecordingFormat() {
  if (!window.MediaRecorder) return null;

  const formats = [
    { mimeType: "video/mp4;codecs=avc1.42E01E", extension: "mp4" },
    { mimeType: "video/mp4", extension: "mp4" },
    { mimeType: "video/webm;codecs=vp9", extension: "webm" },
    { mimeType: "video/webm;codecs=vp8", extension: "webm" },
    { mimeType: "video/webm", extension: "webm" }
  ];

  return formats.find(format =>
    MediaRecorder.isTypeSupported(format.mimeType)
  ) || null;
}

functio
1000
n updateBufferStatus() {
  if (!bufferStartedAt) return;

  const elapsed = Math.min(
    BUFFER_SECONDS,
    Math.floor((Date.now() - bufferStartedAt) / 1000)
  );

  setBufferStatus(
    `Rolling buffer: ${formatTime(elapsed)} / 1:00.`
  );

  $("downloadBufferButton").disabled = elapsed < 1 || downloadBusy;
}

function startRollingBuffer() {
  stopRollingBuffer();

  if (!HTMLCanvasElement.prototype.captureStream) {
    setBufferStatus("This browser does not support canvas recording.");
    return;
  }

  const format = getRecordingFormat();

  if (!format) {
    setBufferStatus("This browser does not support video recording.");
    return;
  }

  const video = $("liveVideo");

  recordingCanvas = document.createElement("canvas");
  recordingCanvas.width = video.videoWidth || 640;
  recordingCanvas.height = video.videoHeight || 480;
  recordingCanvasContext = recordingCanvas.getContext("2d");

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

    console.error(error);
    setBufferStatus(`Could not start buffer: ${error.message}`);
    return;
  }

  bufferMimeType = format.mimeType;
  bufferChunks = [];
  bufferStartedAt = Date.now();

  bufferRecorder.addEventListener("dataavailable", event => {
    if (!event.data || event.data.size === 0) return;

    bufferChunks.push({
      blob: event.data,
      time: Date.now()
    });

    trimBuffer();
    updateBufferStatus();
  });

  bufferRecorder.addEventListener("error", event => {
    console.error(event.error);
    setBufferStatus("The rolling video buffer encountered an error.");
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

    recordingCanvasContext.clearRect(0, 0, width, height);

    // The preview is mirrored; mirror the recorded video the same way.
    recordingCanvasContext.save();
    recordingCanvasContext.translate(width, 0);
    recordingCanvasContext.scale(-1, 1);
    recordingCanvasContext.drawImage(video, 0, 0, width, height);
    recordingCanvasContext.restore();

    // Add detection boxes, optional head boxes, and the watermark to the clip.
    drawLiveOverlay(recordingCanvasContext, width, height, true);
  }

  recordingDrawLoop = requestAnimationFrame(drawRecordingFrame);
}

function trimBuffer() {
  const cutoff = Date.now() - BUFFER_SECONDS * 1000;

  while (bufferChunks.length && bufferChunks[0].time < cutoff) {
    bufferChunks.shift();
  }

  let totalBytes = bufferChunks.reduce(
    (total, chunk) => total + chunk.blob.size,
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
      console.warn("Could not stop rolling buffer:", error);
    }
  }

  if (bufferRecorder?.stream) {
    bufferRecorder.stream.getTracks().forEach(track => track.stop());
  }

  if (recordingDrawLoop !== null) {
    cancelAnimationFrame(recordingDrawLoop);
  }

  recordingDrawLoop = null;
  bufferRecorder = null;
  buffer
1000
Chunks = [];
  bufferStartedAt = 0;
  recordingCanvas = null;
  recordingCanvasContext = null;

  $("downloadBufferButton").disabled = true;
  setBufferStatus("Rolling buffer stopped.");
}

function downloadLast60Seconds() {
  if (downloadBusy) return;

  trimBuffer();

  const chunks = bufferChunks.map(chunk => chunk.blob);

  if (!chunks.length) {
    $("recordingStatus").textContent = "The buffer is not ready yet.";
    return;
  }

  downloadBusy = true;
  $("downloadBufferButton").disabled = true;
  $("recordingStatus").textContent = "Preparing your clip…";

  try {
    const blob = new Blob(chunks, { type: bufferMimeType });

    if (!blob.size) {
      throw new Error("No recorded video data is available.");
    }

    const format = getRecordingFormat();
    const extension = format?.extension || "webm";
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download =
      `humansight-last-60-seconds-${new Date()
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
      `Download failed: ${error.message}`;
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
  canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);

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

/* Button events */

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

/* Load AI model */

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

/* Initialize after page elements exist */

function initialize() {
  setupTheme();

  $("startC
3b8
ameraButton").addEventListener("click", startCamera);
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

  loadModel();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initialize, { once: true });
} else {
  initialize();
}

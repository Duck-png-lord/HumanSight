"use strict";

(() => {
  const $ = id => document.getElementById(id);

  let detector = null;
  let modelsReady = false;

  let liveStream = null;
  let liveRunning = false;
  let detectionBusy = false;
  let animationId = null;
  let lastDetectionAt = 0;
  let detections = [];

  let recordingCanvas = null;
  let recordingContext = null;
  let recordingAnimationId = null;

  let recorder = null;
  let recorderStream = null;
  let chunks = [];
  let mi
1000
meType = "";
  let recorderStartedAt = 0;
  let bufferTimer = null;

  let isDownloading = false;
  let destroyed = false;

  const BUFFER_DURATION_MS = 60_000;
  const MAX_BUFFER_BYTES = 100 * 1024 * 1024;
  const DETECTION_INTERVAL_MS = 300;

  function setText(id, message) {
    const element = $(id);
    if (element) element.textContent = message;
  }

  function getSupportedFormat() {
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

  function formatTime(seconds) {
    const value = Math.max(0, Math.floor(seconds || 0));
    return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
  }

  function setTheme(theme) {
    const valid = ["cctv", "light", "dark", "pastel", "cats"];
    const selected = valid.includes(theme) ? theme : "cctv";

    document.body.dataset.theme = selected;
    $("themeSelect").value = selected;
    localStorage.setItem("trainer-theme", selected);
  }

  function setupTheme() {
    const saved = localStorage.getItem("trainer-theme");
    setTheme(saved || "cctv");

    $("themeSelect").addEventListener("change", event => {
      setTheme(event.target.value);
    });
  }

  function fitRect(containerWidth, containerHeight, sourceWidth, sourceHeight) {
    if (!containerWidth || !containerHeight || !sourceWidth || !sourceHeight) {
      return null;
    }

    const scale = Math.min(
      containerWidth / sourceWidth,
      containerHeight / sourceHeight
    );

    return {
      scale,
      x: (containerWidth - sourceWidth * scale) / 2,
      y: (containerHeight - sourceHeight * scale) / 2
    };
  }

  function drawLogo(context, width, height) {
    const scale = Math.max(1, width / 640);
    const text = "HumanSight";
    const padding = 8 * scale;
    const boxHeight = 28 * scale;

    context.save();
    context.font = `bold ${14 * scale}px monospace`;

    const boxWidth = context.measureText(text).width + padding * 2;
    const x = width - boxWidth - 10 * scale;
    const y = height - boxHeight - 10 * scale;

    context.fillStyle = "rgba(0, 0, 0, .75)";
    context.beginPath();
    context.roundRect(x, y, boxWidth, boxHeight, 4 * scale);
    context.fill();

    context.fillStyle = "#9bffb7";
    context.textBaseline = "middle";
    context.fillText(text, x + padding, y + boxHeight / 2);
    context.restore();
  }

  function drawOverlay(context, width, height, mirrorBoxes = false) {
    context.clearRect(0, 0, width, height);

    for (const detection of detections) {
      const [x, y, boxWidth, boxHeight] = detection.bbox;
      const drawX = mirrorBoxes ? width - x - boxWidth : x;
      const label = `PERSON ${(detection.score * 100).toFixed(0)}%`;
      const fontSize = Math.max(13, width / 52);
      const labelHeight = Math.max(24, width / 46);

      context.lineWidth = Math.max(2, width / 320);
      context.strokeStyle = "#71ff9b";
      context.strokeRect(drawX, y, boxWidth, boxHeight);

      context.font = `bold ${fontSize}px monospace`;
      const labelWidth = context.measureText(label).width + 12;
      const labelY = Math.max(0, y - labelHeight);

      context.fillStyle = "rgba(15, 65, 34, .94)";
      context.fillRect(drawX, labelY, labelWidth, labelHeight);
      context.fillStyle = "#a8ffbf";
      context.textBaseline = "middle";
      context.fillText(label, drawX + 6, labelY + labelHeight / 2);

      if ($("liveHeadToggle").checked) {
        const headWidth = boxWidth * 0.48;
        const headHeight = boxHeight * 0.22;
        const headX = x + (boxWidth - headWidth) / 2;
        const displayedHeadX = mirrorBoxes
          ? width - headX - headWidth
          : headX;

        context.lineWidth = Math.max(2, width / 500);
        c
1000
ontext.strokeStyle = "#f4d56e";
        context.strokeRect(
          displayedHeadX,
          y + boxHeight * 0.025,
          headWidth,
          headHeight
        );
      }
    }

    drawLogo(context, width, height);
  }

  function drawPreview() {
    const video = $("liveVideo");
    const canvas = $("liveCanvas");
    const stage = $("liveStage");

    if (!video.videoWidth || !video.videoHeight) return;

    const width = stage.clientWidth;
    const height = stage.clientHeight;
    const dpr = window.devicePixelRatio || 1;

    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const context = canvas.getContext("2d");
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);

    const rect = fitRect(width, height, video.videoWidth, video.videoHeight);
    if (!rect) return;

    context.save();
    context.translate(rect.x, rect.y);
    context.scale(rect.scale, rect.scale);
    drawOverlay(context, video.videoWidth, video.videoHeight);
    context.restore();
  }

  function peopleOnly(results, width, height) {
    if (!width || !height) return [];

    return results.filter(item => {
      if (item.class !== "person" || item.score < 0.35) return false;

      const [, , boxWidth, boxHeight] = item.bbox;
      return boxWidth / width < 0.98 && boxHeight / height < 0.99;
    });
  }

  async function startCamera() {
    if (liveRunning) return;

    if (!navigator.mediaDevices?.getUserMedia) {
      setText("liveStatus", "Camera requires HTTPS or localhost.");
      return;
    }

    if (!modelsReady) {
      setText("liveStatus", "Detection model is loading. Please wait.");
      return;
    }

    $("startCameraButton").disabled = true;
    setText("liveStatus", "Requesting camera permission…");

    try {
      liveStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: "user",
          width: { ideal: 640 },
          height: { ideal: 480 }
        }
      });

      if (destroyed) {
        liveStream.getTracks().forEach(track => track.stop());
        liveStream = null;
        return;
      }

      const video = $("liveVideo");
      video.srcObject = liveStream;

      await new Promise((resolve, reject) => {
        if (video.readyState >= 1) {
          resolve();
          return;
        }

        video.onloadedmetadata = resolve;
        video.onerror = () => reject(new Error("Could not read webcam video."));
      });

      await video.play();

      liveRunning = true;
      detections = [];
      lastDetectionAt = 0;

      video.classList.add("visible");
      $("livePlaceholder").hidden = true;
      $("stopCameraButton").disabled = false;
      document.body.classList.add("camera-on");

      setText("liveStatus", "Camera online. Detection is running locally.");
      startRollingBuffer();
      detectionLoop();
    } catch (error) {
      console.error("Camera start failed:", error);

      if (liveStream) {
        liveStream.getTracks().forEach(track => track.stop());
        liveStream = null;
      }

      $("liveVideo").srcObject = null;
      $("liveVideo").classList.remove("visible");
      $("livePlaceholder").hidden = false;
      $("startCameraButton").disabled = false;
      $("stopCameraButton").disabled = true;
      document.body.classList.remove("camera-on");

      setText(
        "liveStatus",
        error.name === "NotAllowedError"
          ? "Camera permission denied. Allow camera access in browser settings."
          : error.name === "NotFoundError"
            ? "No camera was found."
            : `Could not start camera: ${error.message}`
      );
    }
  }

  function detectionLoop() {
    if (!liveRunning) return;

    animationId = requestAnimationFrame(detectionLoop);

    if (
      detectionBusy ||
      performance.now() - lastDetectionAt < DETECTION_INTERVAL_MS
    ) {
      return;
    }

    const video = $("liveVideo");
    if (!video.
1000
videoWidth || video.readyState < 2) return;

    detectionBusy = true;
    lastDetectionAt = performance.now();

    detector.detect(video, 10, 0.3)
      .then(results => {
        if (!liveRunning) return;

        detections = peopleOnly(results, video.videoWidth, video.videoHeight);
        drawPreview();

        setText(
          "liveStatus",
          detections.length
            ? `${detections.length} person${detections.length === 1 ? "" : "s"} detected`
            : "Camera online. No people detected."
        );
      })
      .catch(error => {
        console.error("Detection error:", error);
        setText("liveStatus", `Detection error: ${error.message}`);
      })
      .finally(() => {
        detectionBusy = false;
      });
  }

  function drawRecordingFrame() {
    if (!liveRunning || !recordingCanvas || !recordingContext) return;

    const video = $("liveVideo");
    const width = video.videoWidth;
    const height = video.videoHeight;

    if (width && height) {
      if (recordingCanvas.width !== width || recordingCanvas.height !== height) {
        recordingCanvas.width = width;
        recordingCanvas.height = height;
      }

      recordingContext.save();
      recordingContext.translate(width, 0);
      recordingContext.scale(-1, 1);
      recordingContext.drawImage(video, 0, 0, width, height);
      recordingContext.restore();

      drawOverlay(recordingContext, width, height, true);
    }

    recordingAnimationId = requestAnimationFrame(drawRecordingFrame);
  }

  function trimBuffer() {
    const cutoff = Date.now() - BUFFER_DURATION_MS;

    while (chunks.length && chunks[0].time < cutoff) {
      chunks.shift();
    }

    let bytes = chunks.reduce((sum, item) => sum + item.blob.size, 0);

    while (chunks.length > 1 && bytes > MAX_BUFFER_BYTES) {
      bytes -= chunks.shift().blob.size;
    }
  }

  function updateBufferUi() {
    if (!recorder || !recorderStartedAt) return;

    trimBuffer();

    const elapsed = Math.min(
      BUFFER_DURATION_MS / 1000,
      Math.floor((Date.now() - recorderStartedAt) / 1000)
    );

    setText("bufferStatus", `Rolling buffer: ${formatTime(elapsed)} / 1:00`);
    $("downloadBufferButton").disabled = chunks.length === 0 || isDownloading;
  }

  function startRollingBuffer() {
    stopRollingBuffer();

    const format = getSupportedFormat();
    if (!format || !HTMLCanvasElement.prototype.captureStream) {
      setText("bufferStatus", "This browser does not support recording.");
      $("downloadBufferButton").disabled = true;
      return;
    }

    const video = $("liveVideo");
    recordingCanvas = document.createElement("canvas");
    recordingCanvas.width = video.videoWidth || 640;
    recordingCanvas.height = video.videoHeight || 480;
    recordingContext = recordingCanvas.getContext("2d");

    recorderStream = recordingCanvas.captureStream(30);
    chunks = [];
    mimeType = format.mimeType;
    recorderStartedAt = Date.now();

    try {
      recorder = new MediaRecorder(recorderStream, {
        mimeType: format.mimeType,
        videoBitsPerSecond: 2_000_000
      });
    } catch (error) {
      console.error("Recorder creation failed:", error);
      recorderStream.getTracks().forEach(track => track.stop());
      recorderStream = null;
      recorder = null;
      recordingCanvas = null;
      recordingContext = null;
      recorderStartedAt = 0;
      setText("bufferStatus", `Could not start recording: ${error.message}`);
      return;
    }

    recorder.addEventListener("dataavailable", event => {
      if (event.data?.size) {
        chunks.push({ blob: event.data, time: Date.now() });
        updateBufferUi();
      }
    });

    recorder.addEventListener("error", event => {
      console.error("Recording error:", event.error);
      setText("bufferStatus", "Recording error. Check the browser console.");
    });

    recorder.addEventListener("stop", () => {
      if (recorderStream) {
        recorderStream.getTracks().forEach(track => track.stop());
      }
      recorderStream = null;
    });

    recorder.start(1000);
1000

    drawRecordingFrame();

    bufferTimer = setInterval(updateBufferUi, 1000);
    setText("bufferStatus", "Rolling buffer starting…");
  }

  function stopRollingBuffer() {
    if (bufferTimer) clearInterval(bufferTimer);
    bufferTimer = null;

    if (recordingAnimationId !== null) {
      cancelAnimationFrame(recordingAnimationId);
    }
    recordingAnimationId = null;

    if (recorder && recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch (error) {
        console.warn("Recorder stop error:", error);
      }
    }

    if (recorderStream) {
      recorderStream.getTracks().forEach(track => track.stop());
    }

    recorder = null;
    recorderStream = null;
    recordingCanvas = null;
    recordingContext = null;
    chunks = [];
    recorderStartedAt = 0;

    $("downloadBufferButton").disabled = true;
  }

  function downloadBuffer() {
    if (isDownloading) return;

    trimBuffer();

    if (!chunks.length) {
      setText("recordingStatus", "No recorded video is available yet.");
      return;
    }

    isDownloading = true;
    $("downloadBufferButton").disabled = true;
    setText("recordingStatus", "Preparing the clip…");

    try {
      const format = getSupportedFormat();
      const outputType = mimeType || format?.mimeType || "video/webm";
      const extension = outputType.includes("mp4") ? "mp4" : "webm";
      const blob = new Blob(chunks.map(item => item.blob), { type: outputType });

      if (!blob.size) throw new Error("The recording is empty.");

      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

      link.href = url;
      link.download = `humansight-last-60-seconds-${timestamp}.${extension}`;
      document.body.appendChild(link);
      link.click();
      link.remove();

      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setText("recordingStatus", `Download started as ${extension.toUpperCase()}.`);
    } catch (error) {
      console.error("Download failed:", error);
      setText("recordingStatus", `Download failed: ${error.message}`);
    } finally {
      isDownloading = false;
      updateBufferUi();
    }
  }

  function stopCamera() {
    liveRunning = false;

    if (animationId !== null) cancelAnimationFrame(animationId);
    animationId = null;
    detectionBusy = false;

    stopRollingBuffer();

    if (liveStream) {
      liveStream.getTracks().forEach(track => track.stop());
      liveStream = null;
    }

    const video = $("liveVideo");
    video.pause();
    video.srcObject = null;
    video.classList.remove("visible");

    detections = [];
    const canvas = $("liveCanvas");
    canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);

    $("livePlaceholder").hidden = false;
    $("startCameraButton").disabled = false;
    $("stopCameraButton").disabled = true;
    document.body.classList.remove("camera-on");

    setText("liveStatus", "Camera is off.");
    setText("bufferStatus", "Start the camera to begin the 60-second rolling buffer.");
  }

  async function toggleFullscreen() {
    const card = document.querySelector(".live-card");

    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else if (card.requestFullscreen) {
        await card.requestFullscreen();
      }
    } catch (error) {
      setText("liveStatus", `Full screen failed: ${error.message}`);
    }
  }

  async function loadModel() {
    try {
      setText("status", "Loading person detection model…");

      if (!window.tf || !window.cocoSsd) {
        throw new Error("AI scripts did not load. Check your internet connection.");
      }

      detector = await window.cocoSsd.load();
      modelsReady = true;

      setText("status", "SYSTEM READY");
      setText("liveStatus", "Camera is off. Press Start camera.");
    } catch (error) {
      console.error("Model loading failed:", error);
      setText("status", "MODEL LOAD FAILED");
      setText("liveStatus", `Detection unav
606
ailable: ${error.message}`);
    }
  }

  function initialize() {
    setupTheme();

    // Attach directly after the DOM exists; IDs match index.html exactly.
    $("startCameraButton").addEventListener("click", startCamera);
    $("stopCameraButton").addEventListener("click", stopCamera);
    $("downloadBufferButton").addEventListener("click", downloadBuffer);
    $("fullscreenButton").addEventListener("click", toggleFullscreen);
    $("liveHeadToggle").addEventListener("change", drawPreview);

    window.addEventListener("resize", drawPreview);
    document.addEventListener("fullscreenchange", () => {
      $("fullscreenButton").textContent = document.fullscreenElement
        ? "Exit full screen"
        : "⛶ Full screen";
      requestAnimationFrame(drawPreview);
    });

    document.addEventListener("visibilitychange", () => {
      if (document.hidden && liveRunning) stopCamera();
    });

    window.addEventListener("pagehide", () => {
      destroyed = true;
      stopCamera();
    });

    loadModel();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize, { once: true });
  } else {
    initialize();
  }
})();
  document.addEventListener("DOMContentLoaded", initialize, { once: true });
} else {
  initialize();
}

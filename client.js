"use strict";

(() => {
  const $ = id => document.getElementById(id);

  let detector = null;
  let modelReady = false;
  let cameraStarting = false;
  let stream = null;
  let running = false;
  let detecting = false;
  let frameId = null;
  let lastDetection = 0;
  let detections = [];

  let recorder = null;
  let recorderStream = null;
  let chunks = [];
  let mimeType = "";
  let recordingStarted = 0;
  let bufferTimer = null;
  let recordingCanvas = null;
  let recordingContext = null;
  let recordingFrameId = null;
  let downloading = false;

  const BUFFER_MS = 60_000;
  const MAX_BUFFER_BYTES = 100 * 1024 * 1024;
  const DETECTION_INTERVAL_MS = 300;

  function message(id, text) {
    const element = $(id);
    if (element) element.textContent = text;
  }

  function showError(error, line) {
    console.error(error);

    const detail = line ? ` (line ${line})` : "";
    message("liveStatus", `JavaScript error: ${error}${detail}`);
  }

  // Display otherwise-hidden JavaScript errors directly in the page.
  window.onerror = function (event, source, line) {
    showError(event, line);
    return false;
  };

  window.onunhandledrejection = function (event) {
    const reason = event.reason?.message || event.reason || "Unknown error";
    showError(`Unhandled promise rejection: ${reason}`);
  };

  function setTheme(theme) {
    const allowed = ["cctv", "light", "dark", "pastel", "cats"];
    const selected = allowed.includes(theme) ? theme : "cctv";

    document.body.dataset.theme = selected;

    const selector = $("themeSelect");
    if (selector) selector.value = selected;

    try {
      localStorage.setItem("trainer-theme", selected);
    } catch (_) {
      // Theme still works if browser storage is unavailable.
    }
  }

  function setupTheme() {
    const selector = $("themeSelect");
    if (!selector) return;

    let saved = null;
    try {
      saved = localStorage.getItem("trainer-theme");
    } catch (_) {}

    setTheme(saved || "cctv");
    selector.addEventListener("change", event => setTheme(event.target.value));
  }

  function recordingFormat() {
    if (!window.MediaRecorder) return null;

    const choices = [
      { type: "video/mp4;codecs=avc1.42E01E", extension: "mp4" },
      { type: "video/mp4", extension: "mp4" },
      { type: "video/webm;codecs=vp9", extension: "webm" },
      { type: "video/webm;codecs=vp8", extension: "webm" },
      { type: "video/webm", extension: "webm" }
    ];

    return choices.find(item => MediaRecorder.isTypeSupported(item.type)) || null;
  }

  function fitRect(boxWidth, boxHeight, videoWidth, videoHeight) {
    if (!boxWidth || !boxHeight || !videoWidth || !videoHeight) return null;

    const scale = Math.min(boxWidth / videoWidth, boxHeight / videoHeight);

    return {
      scale,
      x: (boxWidth - videoWidth * scale) / 2,
      y: (boxHeight - videoHeight * scale) / 2
    };
  }

  function drawWatermark(context, width, height) {
    const scale = Math.max(1, width / 640);
    const label = "HumanSight";
    const padding = 8 * scale;
    const boxHeight = 27 * scale;

    context.save();
    context.font = `bold ${14 * scale}px monospace`;

    const boxWidth = context.measureText(label).width + 2 * padding;
    const x = width - boxWidth - 10 * scale;
    const y = height - boxHeight - 10 * scale;

    context.fillStyle = "rgba(0, 0, 0, 0.75)";
    context.beginPath();
    context.roundRect(x, y, boxWidth, boxHeight, 5 * scale);
    context.fill();

    context.fillStyle = "#9bffb7";
    context.textBaseline = "middle";
    context.fillText(label, x + padding, y + boxHeight / 2);
    context.restore();
  }

  function drawOverlay(context, width, height, mirrored = false) {
    context.clearRect(0, 0, width, height);

    for (const item of detections) {
      const [x, y, boxWidth, boxHeight] = item.bbox;
      const drawX = mirrored ? width - x - boxWidth : x;
      const label = `PERSON ${(item.score * 100).toFixed(0)}%`;
      const fontSize = Math.max(13, width / 52);
      const labelHeight = Math.max(24, width / 46);

      context.lineWidth = Math.max(2, width / 320);
      context.strokeStyle = "#71ff9b";
      context.strokeRect(drawX, y, boxWidth, boxHeight);

      context.font = `bold ${fontSize}px monospace`;
      const labelWidth = context.measureText(label).width + 12;
      const labelY = Math.max(0, y - labelHeight);

      context.fillStyle = "rgba(15, 65, 34, 0.94)";
      context.fillRect(drawX, labelY, labelWidth, labelHeight);
      context.fillStyle = "#a8ffbf";
      context.textBaseline = "middle";
      context.fillText(label, drawX + 6, labelY + labelHeight / 2);

      if ($("liveHeadToggle")?.checked) {
        const headWidth = boxWidth * 0.48;
        const headHeight = boxHeight * 0.22;
        const headX = x + (boxWidth - headWidth) / 2;

        context.lineWidth = Math.max(2, width / 500);
        context.strokeStyle = "#f4d56e";
        context.strokeRect(
          mirrored ? width - headX - headWidth : headX,
          y + boxHeight * 0.025,
          headWidth,
          headHeight
        );
      }
    }

    drawWatermark(context, width, height);
  }

  function drawPreview() {
    const video = $("liveVideo");
    const canvas = $("liveCanvas");
    const stage = $("liveStage");

    if (!video || !canvas || !stage || !video.videoWidth) return;

    const width = stage.clientWidth;
    const height = stage.clientHeight;
    const dpr = window.devicePixelRatio || 1;

    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const context = canvas.getContext("2d");
    if (!context) return;

    context.setTransform(dpr, 0, 0, dpr, 0, 0);

    const rect = fitRect(width, height, video.videoWidth, video.videoHeight);
    if (!rect) return;

    context.save();
    context.translate(rect.x, rect.y);
    context.scale(rect.scale, rect.scale);
    drawOverlay(context, video.videoWidth, video.videoHeight);
    context.restore();
  }

  function keepPeople(results, width, height) {
    return results.filter(item => {
      if (item.class !== "person" || item.score < 0.35) return false;
      const [, , boxWidth, boxHeight] = item.bbox;
      return boxWidth / width < 0.98 && boxHeight / height < 0.99;
    });
  }

  async function startCamera() {
    if (running || cameraStarting) return;

    if (!navigator.mediaDevices?.getUserMedia) {
      message("liveStatus", "Camera unavailable. Open the site over HTTPS in a normal browser.");
      return;
    }

    cameraStarting = true;
    $("startCameraButton").disabled = true;
    message("liveStatus", "Requesting camera permission…");

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: "user",
          width: { ideal: 640 },
          height: { ideal: 480 }
        }
      });

      const video = $("liveVideo");
      if (!video) throw new Error("The liveVideo element is missing from index.html.");

      video.srcObject = stream;

      if (video.readyState < 1) {
        await new Promise((resolve, reject) => {
          video.onloadedmetadata = resolve;
          video.onerror = () => reject(new Error("Could not read the camera video."));
        });
      }

      await video.play();

      running = true;
      detections = [];
      lastDetection = 0;

      video.classList.add("visible");
      if ($("livePlaceholder")) $("livePlaceholder").hidden = true;
      $("stopCameraButton").disabled = false;
      document.body.classList.add("camera-on");

      if (modelReady) {
        message("liveStatus", "Camera online. Detection is running locally.");
      } else {
        message("liveStatus", "Camera online. Detection model is still loading.");
      }

      startRollingBuffer();
      detectionLoop();
    } catch (error) {
      console.error("Camera start failed:", error);

      if (stream) {
        stream.getTracks().forEach(track => track.stop());
        stream = null;
      }

      const video = $("liveVideo");
      if (video) {
        video.srcObject = null;
        video.classList.remove("visible");
      }

      if ($("livePlaceholder")) $("livePlaceholder").hidden = false;
      $("stopCameraButton").disabled = true;
      $("startCameraButton").disabled = false;
      document.body.classList.remove("camera-on");

      const explanation =
        error.name === "NotAllowedError"
          ? "Camera permission was denied. Allow camera access in browser settings."
          : error.name === "NotFoundError"
            ? "No camera was found."
            : error.name === "NotReadableError"
              ? "The camera may already be in use by another app."
              : error.message || String(error);

      message("liveStatus", `Camera could not start: ${explanation}`);
    } finally {
      cameraStarting = false;
    }
  }

  function detectionLoop() {
    if (!running) return;

    frameId = requestAnimationFrame(detectionLoop);

    if (!modelReady || detecting || !detector) return;
    if (performance.now() - lastDetection < DETECTION_INTERVAL_MS) return;

    const video = $("liveVideo");
    if (!video?.videoWidth || video.readyState < 2) return;

    detecting = true;
    lastDetection = performance.now();

    detector.detect(video, 10, 0.3)
      .then(results => {
        if (!running) return;

        detections = keepPeople(results, video.videoWidth, video.videoHeight);
        drawPreview();

        message(
          "liveStatus",
          detections.length
            ? `${detections.length} person${detections.length === 1 ? "" : "s"} detected`
            : "Camera online. No people detected."
        );
      })
      .catch(error => {
        console.error("Detection failed:", error);
        message("liveStatus", `Detection error: ${error.message}`);
      })
      .finally(() => {
        detecting = false;
      });
  }

  function drawRecordingFrame() {
    if (!running || !recordingCanvas || !recordingContext) return;

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

    recordingFrameId = requestAnimationFrame(drawRecordingFrame);
  }

  function trimBuffer() {
    const cutoff = Date.now() - BUFFER_MS;

    while (chunks.length && chunks[0].time < cutoff) chunks.shift();

    let size = chunks.reduce((sum, item) => sum + item.blob.size, 0);

    while (chunks.length > 1 && size > MAX_BUFFER_BYTES) {
      size -= chunks.shift().blob.size;
    }
  }

  function updateBufferStatus() {
    if (!recorder || !recordingStarted) return;

    trimBuffer();

    const elapsed = Math.min(
      60,
      Math.floor((Date.now() - recordingStarted) / 1000)
    );

    message("bufferStatus", `Rolling buffer: ${elapsed} / 60 seconds`);
    $("downloadBufferButton").disabled = chunks.length === 0 || downloading;
  }

  function startRollingBuffer() {
    stopRollingBuffer();

    const format = recordingFormat();
    if (!format || !HTMLCanvasElement.prototype.captureStream) {
      message("bufferStatus", "Video recording is not supported in this browser.");
      return;
    }

    const video = $("liveVideo");
    recordingCanvas = document.createElement("canvas");
    recordingCanvas.width = video.videoWidth || 640;
    recordingCanvas.height = video.videoHeight || 480;
    recordingContext = recordingCanvas.getContext("2d");

    recorderStream = recordingCanvas.captureStream(30);
    chunks = [];
    mimeType = format.type;
    recordingStarted = Date.now();

    try {
      recorder = new MediaRecorder(recorderStream, {
        mimeType: format.type,
        videoBitsPerSecond: 2_000_000
      });
    } catch (error) {
      console.error("Recorder setup failed:", error);
      recorderStream.getTracks().forEach(track => track.stop());
      recorderStream = null;
      recorder = null;
      recordingStarted = 0;
      message("bufferStatus", `Recording setup failed: ${error.message}`);
      return;
    }

    recorder.addEventListener("dataavailable", event => {
      if (event.data?.size) {
        chunks.push({ blob: event.data, time: Date.now() });
        updateBufferStatus();
      }
    });

    recorder.addEventListener("error", event => {
      console.error("Recorder error:", event.error);
      message("bufferStatus", "Recording error. Try a different browser.");
    });

    recorder.start(1000);
    drawRecordingFrame();

    bufferTimer = setInterval(updateBufferStatus, 1000);
    message("bufferStatus", "Starting rolling recording…");
  }

  function stopRollingBuffer() {
    if (bufferTimer) clearInterval(bufferTimer);
    bufferTimer = null;

    if (recordingFrameId !== null) cancelAnimationFrame(recordingFrameId);
    recordingFrameId = null;

    if (recorder && recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch (error) {
        console.warn("Recorder stop failed:", error);
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
    recordingStarted = 0;

    if ($("downloadBufferButton")) $("downloadBufferButton").disabled = true;
  }

  function downloadBuffer() {
    if (downloading) return;
    trimBuffer();

    if (!chunks.length) {
      message("recordingStatus", "No recorded video is available yet.");
      return;
    }

    downloading = true;
    $("downloadBufferButton").disabled = true;
    message("recordingStatus", "Preparing download…");

    try {
      const format = recordingFormat();
      const type = mimeType || format?.type || "video/webm";
      const extension = type.includes("mp4") ? "mp4" : "webm";
      const blob = new Blob(chunks.map(item => item.blob), { type });

      if (!blob.size) throw new Error("The video buffer is empty.");

      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");

      link.href = url;
      link.download = `humansight-last-60-seconds-${stamp}.${extension}`;
      document.body.appendChild(link);
      link.click();
      link.remove();

      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      message("recordingStatus", `Download started (${extension.toUpperCase()}).`);
    } catch (error) {
      console.error("Download failed:", error);
      message("recordingStatus", `Download failed: ${error.message}`);
    } finally {
      downloading = false;
      updateBufferStatus();
    }
  }

  function stopCamera() {
    running = false;

    if (frameId !== null) cancelAnimationFrame(frameId);
    frameId = null;
    detecting = false;

    stopRollingBuffer();

    if (stream) {
      stream.getTracks().forEach(track => track.stop());
      stream = null;
    }

    const video = $("liveVideo");
    if (video) {
      video.pause();
      video.srcObject = null;
      video.classList.remove("visible");
    }

    detections = [];

    const canvas = $("liveCanvas");
    if (canvas) {
      const context = canvas.getContext("2d");
      context.clearRect(0, 0, canvas.width, canvas.height);
    }

    if ($("livePlaceholder")) $("livePlaceholder").hidden = false;
    $("startCameraButton").disabled = false;
    $("stopCameraButton").disabled = true;
    document.body.classList.remove("camera-on");

    message("liveStatus", "Camera is off.");
    message("bufferStatus", "Start the camera to begin the 60-second rolling buffer.");
  }

  async function toggleFullscreen() {
    try {
      const card = document.querySelector(".live-card");

      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else if (card?.requestFullscreen) {
        await card.requestFullscreen();
      }
    } catch (error) {
      message("liveStatus", `Full screen failed: ${error.message}`);
    }
  }

  async function loadModel() {
    try {
      message("status", "Loading detection model…");

      if (!window.cocoSsd) {
        throw new Error("Detection library did not load. Check your internet connection.");
      }

      detector = await window.cocoSsd.load();
      modelReady = true;
      message("status", "SYSTEM READY");

      if (running) {
        message("liveStatus", "Camera online. Detection is running locally.");
      } else {
        message("liveStatus", "Camera is off. Press Start camera.");
      }
    } catch (error) {
      console.error("Model loading failed:", error);
      message("status", "MODEL LOAD FAILED");
      message("liveStatus", `Model unavailable: ${error.message}`);
    }
  }

  function initialize() {
    setupTheme();

    const start = $("startCameraButton");
    const stop = $("stopCameraButton");
    const download = $("downloadBufferButton");
    const fullscreen = $("fullscreenButton");

    if (!start || !stop) {
      message("liveStatus", "Page setup error: camera buttons are missing from index.html.");
      return;
    }

    start.addEventListener("click", startCamera);
    stop.addEventListener("click", stopCamera);

    if (download) download.addEventListener("click", downloadBuffer);
    if (fullscreen) fullscreen.addEventListener("click", toggleFullscreen);

    $("liveHeadToggle")?.addEventListener("change", drawPreview);
    window.addEventListener("resize", drawPreview);

    document.addEventListener("fullscreenchange", () => {
      const button = $("fullscreenButton");
      if (button) {
        button.textContent = document.fullscreenElement
          ? "Exit full screen"
          : "⛶ Full screen";
      }
      requestAnimationFrame(drawPreview);
    });

    document.addEventListener("visibilitychange", () => {
      if (document.hidden && running) stopCamera();
    });

    loadModel();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize, { once: true });
  } else {
    initialize();
  }
})();

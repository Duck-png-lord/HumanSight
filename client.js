"use strict";

(() => {
  const $ = id => document.getElementById(id);

  const video = $("video");
  const canvas = $("overlay");
  const ctx = canvas.getContext("2d");
  const startButton = $("startButton");
  const stopButton = $("stopButton");
  const fullscreenButton = $("fullscreenButton");
  const placeholder = $("placeholder");
  const status = $("status");
  const modelStatus = $("modelStatus");
  const themeSelect = $("themeSelect");

  let stream = null;
  let model = null;
  let running = false;
  let busy = false;
  let animationId = null;

  function setStatus(text) {
    status.textContent = text;
  }

  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    const scale = window.devicePixelRatio || 1;

    canvas.width = Math.round(rect.width * scale);
    canvas.height = Math.round(rect.height * scale);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
  }

  function setTheme(theme) {
    document.body.dataset.theme = theme;
    try {
      localStorage.setItem("humansight-theme", theme);
    } catch (_) {}
  }

  function reportError(error) {
    console.error(error);
    setStatus(`Error: ${error.message || error}`);
  }

  async function startCamera() {
    if (running) return;

    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus("Camera unavailable. Open this site via HTTPS in a supported browser.");
      return;
    }

    startButton.disabled = true;
    setStatus("Requesting camera permission…");

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: "user" }
      });

      video.srcObject = stream;
      await video.play();

      running = true;
      stopButton.disabled = false;
      placeholder.hidden = true;
      resizeCanvas();

      setStatus(model ? "Camera on. Looking for people…" : "Camera on. Model is loading…");
      animationId = requestAnimationFrame(detectFrame);
    } catch (error) {
      if (stream) {
        stream.getTracks().forEach(track => track.stop());
        stream = null;
      }
      startButton.disabled = false;
      reportError(error);
    }
  }

  function stopCamera() {
    running = false;
    busy = false;

    if (animationId !== null) cancelAnimationFrame(animationId);
    animationId = null;

    if (stream) {
      stream.getTracks().forEach(track => track.stop());
      stream = null;
    }

    video.pause();
    video.srcObject = null;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    placeholder.hidden = false;
    startButton.disabled = false;
    stopButton.disabled = true;
    setStatus("Camera is off.");
  }

  async function detectFrame() {
    if (!running) return;

    animationId = requestAnimationFrame(detectFrame);

    if (!model || busy || video.readyState < 2 || !video.videoWidth) return;

    busy = true;

    try {
      const predictions = await model.detect(video);
      if (!running) return;

      const rect = canvas.getBoundingClientRect();
      const width = rect.width;
      const height = rect.height;

      ctx.clearRect(0, 0, width, height);

      const scale = Math.max(width / video.videoWidth, height / video.videoHeight);
      const drawnWidth = video.videoWidth * scale;
      const drawnHeight = video.videoHeight * scale;
      const cropX = (drawnWidth - width) / 2;
      const cropY = (drawnHeight - height) / 2;

      let people = 0;

      for (const item of predictions) {
        if (item.class !== "person" || item.score < 0.45) continue;
        people++;

        const [x, y, boxWidth, boxHeight] = item.bbox;

        // The preview is mirrored, so mirror the box horizontally too.
        const left = width - ((x * scale) - cropX) - (boxWidth * scale);
        const top = (y * scale) - cropY;
        const w = boxWidth * scale;
        const h = boxHeight * scale;

        ctx.lineWidth = 3;
        ctx.strokeStyle = "#70ff9a";
        ctx.strokeRect(left, top, w, h);

        const label = `PERSON ${Math.round(item.score * 100)}%`;
        ctx.font = "bold 14px sans-serif";
        const labelWidth = ctx.measureText(label).width + 12;
        const labelTop = Math.max(0, top - 25);

        ctx.fillStyle = "#176c37";
        ctx.fillRect(left, labelTop, labelWidth, 23);
        ctx.fillStyle = "#ffffff";
        ctx.fillText(label, left + 6, labelTop + 16);
      }

      setStatus(people
        ? `${people} person${people === 1 ? "" : "s"} detected`
        : "Camera on. No people detected.");
    } catch (error) {
      reportError(error);
    } finally {
      busy = false;
    }
  }

  startButton.addEventListener("click", startCamera);
  stopButton.addEventListener("click", stopCamera);

  fullscreenButton.addEventListener("click", async () => {
    try {
      const stage = $("stage");
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else if (stage.requestFullscreen) {
        await stage.requestFullscreen();
      }
    } catch (error) {
      reportError(error);
    }
  });

  themeSelect.addEventListener("change", () => setTheme(themeSelect.value));

  window.addEventListener("resize", resizeCanvas);

  try {
    const savedTheme = localStorage.getItem("humansight-theme");
    if (savedTheme && [...themeSelect.options].some(option => option.value === savedTheme)) {
      themeSelect.value = savedTheme;
    }
  } catch (_) {}

  setTheme(themeSelect.value);
  resizeCanvas();

  async function loadModel() {
    try {
      if (!window.tf || !window.cocoSsd) {
        throw new Error("AI libraries did not load. Check your internet connection.");
      }

      await window.tf.ready();
      model = await window.cocoSsd.load();

      modelStatus.textContent = "AI model ready.";
      setStatus("Ready. Press Start camera.");
    } catch (error) {
      modelStatus.textContent = `Model failed to load: ${error.message || error}`;
      setStatus("Camera controls still work, but person detection is unavailable.");
      console.error(error);
    }
  }

  window.addEventListener("error", event => {
    setStatus(`Page error: ${event.message}`);
  });

  loadModel();
})();

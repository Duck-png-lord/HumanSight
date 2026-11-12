let detector = null;
let scanFile = null;
let predictionLabel = null;
let detections = [];

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
    bar.style.width = `${percent}%`;
  }
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

    await request(`/api/upload/${label}`, {
      method: "POST",
      body: form
    });

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

function drawPersonBoxes() {
  const image = $("scanPreview");
  const canvas = $("boxCanvas");
  const stage = $("scanStage");

  if (!image.naturalWidth || !image.naturalHeight) return;

  const stageWidth = stage.clientWidth;
  const stageHeight = stage.clientHeight;
  const dpr = window.devicePixelRatio || 1;

  canvas.width = Math.round(stageWidth * dpr);
  canvas.height = Math.round(stageHeight * dpr);
  canvas.style.width = `${stageWidth}px`;
  canvas.style.height = `${stageHeight}px`;

  const context = canvas.getContext("2d");
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, stageWidth, stageHeight);

  // Scale the whole image to fit. Nothing is cropped.
  const scale = Math.min(
    stageWidth / image.naturalWidth,
    stageHeight / image.naturalHeight
  );

  const displayedWidth = image.naturalWidth * scale;
  const displayedHeight = image.naturalHeight * scale;
  const offsetX = (stageWidth - displayedWidth) / 2;
  const offsetY = (stageHeight - displayedHeight) / 2;

  for (const detection of detections) {
    if (detection.class !== "person") continue;

    const [x, y, width, height] = detection.bbox;
    const boxX = offsetX + x * scale;
    const boxY = offsetY + y * scale;
    const boxWidth = width * scale;
    const boxHeight = height * scale;

    context.lineWidth = 3;
    context.strokeStyle = "#19d38b";
    context.strokeRect(boxX, boxY, boxWidth, boxHeight);

    const label = `Person ${(detection.score * 100).toFixed(0)}%`;
    context.font = "bold 13px system-ui, sans-serif";

    const labelWidth = context.measureText(label).width + 12;
    const labelY = Math.max(0, boxY - 24);

    context.fillStyle = "#19d38b";
    context.fillRect(boxX, labelY, labelWidth, 23);

    context.fillStyle = "#10251d";
    context.fillText(label, boxX + 6, labelY + 16);
  }
}

$("scanInput").addEventListener("change", event => {
  scanFile = event.target.files[0] || null;
  detections = [];
  predictionLabel = null;

  const canvas = $("boxCanvas");
  canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);

  $("prediction").textContent = "Ready to scan";
  $("confidence").textContent = "";
  $("feedbackNote").textContent = "";
  $("correctButton").disabled = true;
  $("incorrectButton").disabled = true;

  if (!scanFile) return;

  const preview = $("scanPreview");

  if (preview.dataset.url) {
    URL.revokeObjectURL(preview.dataset.url);
  }

  preview.onload = () => {
    drawPersonBoxes();
  };

  preview.dataset.url = URL.createObjectURL(scanFile);
  preview.src = preview.dataset.url;
  preview.classList.add("visible");
  $("scanPlaceholder").hidden = true;
});

$("scanButton").addEventListener("click", async () => {
  if (!scanFile) {
    setStatus("Choose an image to scan first.");
    return;
  }

  if (!detector) {
    setStatus("The detector is still loading. Try again shortly.");
    return;
  }

  $("scanButton").disabled = true;
  $("prediction").textContent = "Scanning…";
  $("confidence").textContent = "";
  $("correctButton").disabled = true;
  $("incorrectButton").disabled = true;

  try {
    setProgress("Looking for people…");

    detections = await detector.detect($("scanPreview"), 20, 0.35);
    drawPersonBoxes();

    const people = detections.filter(item => item.class === "person");

    if (people.length > 0) {
      predictionLabel = "person";
      $("prediction").textContent =
        `${people.length} ${people.length === 1 ? "person" : "people"} detected`;

      const highestScore = Math.max(...people.map(item => item.score));
      $("confidence").textContent =
        `Highest box confidence: ${(highestScore * 100).toFixed(0)}%`;
    } else {
      predictionLabel = "not-person";
      $("prediction").textContent = "No person detected";
      $("confidence").textContent = "";
    }

    $("correctButton").disabled = false;
    $("incorrectButton").disabled = false;

    setProgress("Scan complete", 100);
    setStatus("Scan complete. Green boxes mark detected people.");
  } catch (error) {
    console.error(error);
    $("prediction").textContent = "Scan failed";
    setProgress(error.message, 100);
    setStatus(`Scan failed: ${error.message}`);
  } finally {
    $("scanButton").disabled = false;
  }
});

async function saveFeedback(wasCorrect) {
  if (!scanFile || !predictionLabel) return;

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

    $("feedbackNote").textContent = wasCorrect
      ? "Marked yes. Image saved to its training folder."
      : `Marked no. Image saved to the ${
          correctLabel === "person" ? "Person" : "Not Person"
        } training folder.`;

    $("correctButton").disabled = true;
    $("incorrectButton").disabled = true;

    setStatus("Feedback saved.");
  } catch (error) {
    setStatus(`Could not save feedback: ${error.message}`);
  }
}

$("correctButton").addEventListener("click", () => saveFeedback(true));
$("incorrectButton").addEventListener("click", () => saveFeedback(false));

$("themeSelect").addEventListener("change", event => {
  document.body.dataset.theme = event.target.value;
  localStorage.setItem("trainer-theme", event.target.value);
});

const savedTheme = localStorage.getItem("trainer-theme");

if (["light", "dark", "pastel", "cats"].includes(savedTheme)) {
  document.body.dataset.theme = savedTheme;
  $("themeSelect").value = savedTheme;
}

window.addEventListener("resize", drawPersonBoxes);

setupUploader("personInput", "personDrop", "person");
setupUploader("otherInput", "otherDrop", "not-person");

async function start() {
  try {
    setStatus("Loading person detector…");
    detector = await cocoSsd.load();
    setStatus("Ready. Choose an image to scan.");
  } catch (error) {
    console.error(error);
    setStatus(`Could not load detector: ${error.message}`);
  }
}

start();

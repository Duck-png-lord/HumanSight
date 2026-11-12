let detector = null;
let scanFile = null;
let predictionLabel = null;
let detections = [];

const $ = id => document.getElementById(id);

async function request(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
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

async function loadSavedImages() {
  const images = await request("/api/images");
  $("personCount").textContent = images.person.length;
  $("otherCount").textContent = images.notPerson.length;
  return images;
}

/* The uploads remain saved as training examples. Person boxes come from
   the object detector rather than assigning every image a person score. */
async function refreshCounts() {
  try {
    await loadSavedImages();
  } catch (error) {
    setStatus(`Could not load saved-image counts: ${error.message}`);
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
    await request(`/api/upload/${label}`, { method: "POST", body: form });
    await refreshCounts();
    setStatus("Images saved. They’ll be available to the app on this Codespace.");
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
  const rect = image.getBoundingClientRect();
  const stageRect = stage.getBoundingClientRect();

  if (!image.naturalWidth || !image.naturalHeight || !rect.width || !rect.height) {
    return;
  }

  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(stage.clientWidth * dpr);
  canvas.height = Math.round(stage.clientHeight * dpr);
  canvas.style.width = `${stage.clientWidth}px`;
  canvas.style.height = `${stage.clientHeight}px`;

  const context = canvas.getContext("2d");
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, stage.clientWidth, stage.clientHeight);

  // The image uses object-fit: contain. Offset boxes to match its displayed area.
  const imageLeft = rect.left - stageRect.left;
  const imageTop = rect.top - stageRect.top;
  const scaleX = rect.width / image.naturalWidth;
  const scaleY = rect.height / image.naturalHeight;

  for (const detection of detections) {
    if (detection.class !== "person") continue;

    const [x, y, width, height] = detection.bbox;
    const boxX = imageLeft + x * scaleX;
    const boxY = imageTop + y * scaleY;
    const boxWidth = width * scaleX;
    const boxHeight = height * scaleY;

    context.lineWidth = 3;
    context.strokeStyle = "#19d38b";
    context.fillStyle = "#19d38b";
    context.strokeRect(boxX, boxY, boxWidth, boxHeight);

    const label = `Person ${(detection.score * 100).toFixed(0)}%`;
    context.font = "bold 13px system-ui, sans-serif";
    const labelWidth = context.measureText(label).width + 12;
    const labelY = Math.max(0, boxY - 24);

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
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, canvas.width, canvas.height);

  if (!scanFile) return;

  const preview = $("scanPreview");
  if (preview.dataset.url) URL.revokeObjectURL(preview.dataset.url);

  preview.dataset.url = URL.createObjectURL(scanFile);
  preview.onload = () => drawPersonBoxes();
  preview.src = preview.dataset.url;
  preview.classList.add("visible");
  $("scanPlaceholder").hidden = true;

  $("prediction").textContent = "Ready to scan";
  $("confidence").textContent = "";
  $("feedbackNote").textContent = "";
  $("correctButton").disabled = true;
  $("incorrectButton").disabled = true;
});

$("scanButton").addEventListener("click", async () => {
  if (!scanFile) {
    setStatus("Choose an image to scan first.");
    return;
  }

  if (!detector) {
    setStatus("The detector is still loading. Try again in a moment.");
    return;
  }

  $("scanButton").disabled = true;
  $("prediction").textContent = "Scanning…";
  $("confidence").textContent = "";
  $("correctButton").disabled = true;
  $("incorrectButton").disabled = true;

  try {
    setProgress("Looking for people…", null);

    const image = $("scanPreview");
    detections = await detector.detect(image, 20, 0.35);
    const people = detections.filter(item => item.class === "person");

    drawPersonBoxes();

    if (people.length) {
      predictionLabel = "person";
      $("prediction").textContent =
        `${people.length} ${people.length === 1 ? "person" : "people"} detected`;
      $("confidence").textContent =
        `Highest detection confidence: ${(Math.max(...people.map(item => item.score)) * 100).toFixed(0)}%`;
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
      ? "Yes — image saved to its training folder."
      : `No — image saved to the ${correctLabel === "person" ? "Person" : "Not Person"} training folder.`;

    $("correctButton").disabled = true;
    $("incorrectButton").disabled = true;
    await refreshCounts();
  } catch (error) {
    setStatus(`Could not save feedback: ${error.message}`);
  }
}

$("correctButton").addEventListener("click", () => saveFeedback(true));
$("incorrectButton").addEventListener("click", () => saveFeedback(false));

$("trainButton").addEventListener("click", () => {
  setStatus("Person detection uses the object-detection model and does not need training.");
});

$("clearButton").addEventListener("click", async () => {
  if (!confirm("Delete all saved training images?")) return;

  try {
    const images = await request("/api/images");

    for (const [label, list] of [
      ["person", images.person],
      ["not-person", images.notPerson]
    ]) {
      for (const image of list) {
        await request(`/api/images/${label}/${encodeURIComponent(image.name)}`, {
          method: "DELETE"
        });
      }
    }

    await refreshCounts();
    setStatus("Saved training images deleted.");
  } catch (error) {
    setStatus(`Could not clear images: ${error.message}`);
  }
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

window.addEventListener("resize", drawPersonBoxes);

setupUploader("personInput", "personDrop", "person");
setupUploader("otherInput", "otherDrop", "not-person");

async function start() {
  try {
    await refreshCounts();
    setStatus("Loading person detector…");
    detector = await cocoSsd.load();
    setStatus("Ready. Choose an image to scan.");
  } catch (error) {
    console.error(error);
    setStatus(`Could not start detector: ${error.message}`);
  }
}

start();

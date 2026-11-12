let detector = null;
let mobileNetModel = null;
let scanFile = null;
let searchFile = null;
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

function getDisplayedImageRect() {
  const image = $("scanPreview");
  const stage = $("scanStage");

  if (!image.naturalWidth || !image.naturalHeight) return null;

  const stageWidth = stage.clientWidth;
  const stageHeight = stage.clientHeight;
  const scale = Math.min(
    stageWidth / image.naturalWidth,
    stageHeight / image.naturalHeight
  );
  const width = image.naturalWidth * scale;
  const height = image.naturalHeight * scale;

  return {
    x: (stageWidth - width) / 2,
    y: (stageHeight - height) / 2,
    scale
  };
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

  const displayed = getDisplayedImageRect();
  if (!displayed) return;

  for (const detection of detections) {
    if (detection.class !== "person") continue;

    const [x, y, width, height] = detection.bbox;
    const boxX = displayed.x + x * displayed.scale;
    const boxY = displayed.y + y * displayed.scale;
    const boxWidth = width * displayed.scale;
    const boxHeight = height * displayed.scale;

    context.lineWidth = 3;
    context.strokeStyle = "#19d38b";
    context.strokeRect(boxX, boxY, boxWidth, boxHeight);

    const label = `Person ${(detection.score * 100).toFixed(0)}%`;
    context.font = "bold 13px system-ui, sans-serif";

    const labelWidth = context.measureText(label).width + 12;
    const labelHeight = 23;
    const labelY = Math.max(0, boxY - labelHeight);

    context.fillStyle = "#19d38b";
    context.fillRect(boxX, labelY, labelWidth, labelHeight);

    context.fillStyle = "#10251d";
    context.fillText(label, boxX + 6, labelY + 16);
  }
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

function mergeDuplicateDetections(items) {
  const sorted = [...items].sort((a, b) => b.score - a.score);
  const kept = [];

  for (const item of sorted) {
    if (!kept.some(existing => intersectionOverUnion(existing, item) >= 0.5)) {
      kept.push(item);
    }
  }

  return kept;
}

async function detectThreeTimes(image) {
  const allDetections = [];

  for (let pass = 1; pass <= 3; pass++) {
    setProgress(`Person detection pass ${pass} of 3…`, Math.round(((pass - 1) / 3) * 100));
    const results = await detector.detect(image, 20, 0.25);
    allDetections.push(...results.filter(item => item.class === "person"));
  }

  return mergeDuplicateDetections(allDetections);
}

$("scanInput").addEventListener("change", event => {
  scanFile = event.target.files[0] || null;
  clearBoxes();
  predictionLabel = null;

  $("prediction").textContent = "Ready to scan";
  $("confidence").textContent = "";
  $("feedbackNote").textContent = "";
  $("correctButton").disabled = true;
  $("incorrectButton").disabled = true;

  if (!scanFile) return;

  const preview = $("scanPreview");

  if (preview.dataset.url) URL.revokeObjectURL(preview.dataset.url);

  preview.onload = drawPersonBoxes;
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
    setStatus("The detector is still loading.");
    return;
  }

  $("scanButton").disabled = true;
  $("prediction").textContent = "Scanning three times…";
  $("confidence").textContent = "";
  $("correctButton").disabled = true;
  $("incorrectButton").disabled = true;
  clearBoxes();

  try {
    detections = await detectThreeTimes($("scanPreview"));
    drawPersonBoxes();

    if (detections.length) {
      predictionLabel = "person";
      $("prediction").textContent =
        `${detections.length} ${detections.length === 1 ? "person" : "people"} detected`;

      const bestScore = Math.max(...detections.map(item => item.score));
      $("confidence").textContent = `Highest box confidence: ${(bestScore * 100).toFixed(0)}%`;
    } else {
      predictionLabel = "not-person";
      $("prediction").textContent = "No person detected";
    }

    $("correctButton").disabled = false;
    $("incorrectButton").disabled = false;
    setProgress("Three passes complete", 100);
    setStatus("Scan complete. Green boxes show detected people.");
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
      : `Marked no. Image saved to the ${correctLabel === "person" ? "Person" : "Not Person"} folder.`;

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

  try {
    const preview = $("searchPreview");
    const predictions = await detector.detect(preview, 10, 0.35);
    const containsPerson = predictions.some(item => item.class === "person");

    if (!containsPerson) {
      $("searchMessage").textContent = "No person detected, so the Person image database was not searched.";
      return;
    }

    $("searchMessage").textContent = "Searching saved Person images…";

    const queryEmbedding = mobileNetModel.infer(preview, true);
    const images = await request("/api/images");
    const personImages = images.person || [];
    const comparisons = [];

    for (const item of personImages) {
      try {
        const databaseImage = await loadImage(item.url);
        const databaseEmbedding = mobileNetModel.infer(databaseImage, true);

        const similarity = tf.tidy(() => {
          const a = queryEmbedding.flatten();
          const b = databaseEmbedding.flatten();
          const dot = tf.sum(tf.mul(a, b));
          const normA = tf.norm(a);
          const normB = tf.norm(b);
          return dot.div(normA.mul(normB)).dataSync()[0];
        });

        databaseEmbedding.dispose();

        comparisons.push({
          ...item,
          similarity: Number.isFinite(similarity) ? similarity : -1
        });
      } catch (error) {
        console.warn(`Skipping ${item.name}:`, error);
      }
    }

    queryEmbedding.dispose();

    comparisons.sort((a, b) => b.similarity - a.similarity);
    const topResults = comparisons.slice(0, 3);

    if (!topResults.length) {
      $("searchMessage").textContent = "No saved Person images were available to compare.";
      return;
    }

    $("searchMessage").textContent = "Top matches from your saved Person images:";
    renderSearchResults(topResults);
  } catch (error) {
    console.error(error);
    $("searchMessage").textContent = `Search failed: ${error.message}`;
  } finally {
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

window.addEventListener("resize", drawPersonBoxes);
setupUploader("personInput", "personDrop", "person");
setupUploader("otherInput", "otherDrop", "not-person");

async function start() {
  try {
    setStatus("Loading detection and similarity models…");

    [detector, mobileNetModel] = await Promise.all([
      cocoSsd.load(),
      mobilenet.load({ version: 2, alpha: 1.0 })
    ]);

    setStatus("Ready. Choose an image to scan or search.");
  } catch (error) {
    console.error(error);
    setStatus(`Could not load models: ${error.message}`);
  }
}

start();

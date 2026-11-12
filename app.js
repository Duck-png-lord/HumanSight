// MobileNet v2 alpha 0.5 returns 1280 features.
const EMBEDDING_SIZE = 1280;

let net = null;
let classifier = null;
let scanFile = null;
let predictionLabel = null;
let trainingPromise = null;

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

async function loadSavedImages() {
  const images = await request("/api/images");
  $("personCount").textContent = images.person.length;
  $("otherCount").textContent = images.notPerson.length;
  return images;
}

async function readImageFeatures(blob) {
  const url = URL.createObjectURL(blob);
  const image = new Image();
  image.src = url;

  try {
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error("Could not open this image."));
    });

    const tensor = tf.tidy(() => {
      const pixels = tf.browser.fromPixels(image);
      const resized = tf.image.resizeBilinear(pixels, [160, 160]);
      return net.infer(resized, true).reshape([EMBEDDING_SIZE]);
    });

    const values = Array.from(await tensor.data());
    tensor.dispose();
    return values;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function trainFromSavedImages() {
  if (trainingPromise) return trainingPromise;

  trainingPromise = (async () => {
    if (!net) throw new Error("The image model is still loading.");

    const images = await request("/api/images");

    if (images.person.length < 2 || images.notPerson.length < 2) {
      classifier?.dispose();
      classifier = null;
      setStatus("Add at least 2 images to each trainer box. Training will start automatically.");
      return false;
    }

    const examples = [
      ...images.person.map(image => ({ ...image, label: 0 })),
      ...images.notPerson.map(image => ({ ...image, label: 1 }))
    ];

    const samples = [];

    for (let i = 0; i < examples.length; i++) {
      setStatus(`Preparing saved images: ${i + 1}/${examples.length}`);

      const response = await fetch(examples[i].url);
      if (!response.ok) throw new Error(`Could not load ${examples[i].name}`);

      const vector = await readImageFeatures(await response.blob());
      samples.push({ vector, label: examples[i].label });
    }

    tf.util.shuffle(samples);

    const xs = tf.tensor2d(samples.map(sample => sample.vector));
    const ys = tf.tensor2d(samples.map(sample =>
      sample.label === 0 ? [1, 0] : [0, 1]
    ));

    classifier?.dispose();
    classifier = tf.sequential({
      layers: [
        tf.layers.dense({
          inputShape: [EMBEDDING_SIZE],
          units: 32,
          activation: "relu"
        }),
        tf.layers.dropout({ rate: 0.15 }),
        tf.layers.dense({ units: 2, activation: "softmax" })
      ]
    });

    classifier.compile({
      optimizer: tf.train.adam(0.003),
      loss: "categoricalCrossentropy"
    });

    setStatus("Training automatically from saved images…");

    await classifier.fit(xs, ys, {
      epochs: 20,
      batchSize: Math.min(16, samples.length),
      shuffle: true,
      verbose: 0
    });

    xs.dispose();
    ys.dispose();

    setStatus(`Ready. Automatically trained with ${samples.length} images.`);
    return true;
  })();

  try {
    return await trainingPromise;
  } finally {
    trainingPromise = null;
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

    classifier?.dispose();
    classifier = null;

    await loadSavedImages();
    setStatus("Images saved. Retraining automatically…");
    await trainFromSavedImages();
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

$("trainButton").addEventListener("click", async () => {
  $("trainButton").disabled = true;

  try {
    await trainFromSavedImages();
  } catch (error) {
    console.error(error);
    setStatus(`Training failed: ${error.message}`);
  } finally {
    $("trainButton").disabled = false;
  }
});

$("scanInput").addEventListener("change", event => {
  scanFile = event.target.files[0] || null;
  if (!scanFile) return;

  const preview = $("scanPreview");

  if (preview.dataset.url) {
    URL.revokeObjectURL(preview.dataset.url);
  }

  preview.dataset.url = URL.createObjectURL(scanFile);
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

  $("scanButton").disabled = true;

  try {
    if (!classifier) {
      setStatus("Training automatically from saved images…");
      await trainFromSavedImages();
    }

    if (!classifier) return;

    $("prediction").textContent = "Scanning…";
    $("confidence").textContent = "";
    setProgress("Reading image…", 10);

    const vector = await readImageFeatures(scanFile);
    setProgress("Comparing image features…", 70);

    const input = tf.tensor2d([vector]);
    const output = classifier.predict(input);
    const scores = Array.from(await output.data());

    input.dispose();
    output.dispose();

    const isPerson = scores[0] >= scores[1];
    predictionLabel = isPerson ? "person" : "not-person";

    $("prediction").textContent = isPerson ? "Person" : "Not Person";
    $("confidence").textContent =
      `${(Math.max(...scores) * 100).toFixed(1)}%`;

    $("correctButton").disabled = false;
    $("incorrectButton").disabled = false;

    setProgress("Scan complete", 100);
    setStatus("Scan complete. Choose Yes or No to add feedback to training.");
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
      : `Marked no. Image saved to the ${correctLabel === "person" ? "Person" : "Not Person"} training folder.`;

    $("correctButton").disabled = true;
    $("incorrectButton").disabled = true;

    classifier?.dispose();
    classifier = null;

    await loadSavedImages();
    setStatus("Feedback saved. Retraining automatically…");
    await trainFromSavedImages();
  } catch (error) {
    setStatus(`Could not save feedback: ${error.message}`);
  }
}

$("correctButton").addEventListener("click", () => saveFeedback(true));
$("incorrectButton").addEventListener("click", () => saveFeedback(false));

$("clearButton").addEventListener("click", async () => {
  if (!confirm("Delete all saved training images?")) return;

  try {
    const images = await request("/api/images");

    for (const [label, list] of [
      ["person", images.person],
      ["not-person", images.notPerson]
    ]) {
      for (const image of list) {
        await request(
          `/api/images/${label}/${encodeURIComponent(image.name)}`,
          { method: "DELETE" }
        );
      }
    }

    classifier?.dispose();
    classifier = null;
    await loadSavedImages();
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

setupUploader("personInput", "personDrop", "person");
setupUploader("otherInput", "otherDrop", "not-person");

async function start() {
  try {
    setStatus("Connecting to saved training files…");
    await loadSavedImages();

    setStatus("Loading image model…");
    await tf.ready();
    net = await mobilenet.load({ version: 2, alpha: 0.5 });

    setStatus("Training automatically from saved images…");
    await trainFromSavedImages();
  } catch (error) {
    console.error(error);
    setStatus(`Could not start: ${error.message}`);
  }
}

start();

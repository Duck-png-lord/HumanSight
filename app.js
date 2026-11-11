let net = null;
let classifier = null;
let imageSets = { person: [], other: [] };
let scannedImageName = "";
let scannedPrediction = "";

const $ = id => document.getElementById(id);
const statusEl = $("status");
const EMBEDDING_SIZE = 1280;

function setStatus(text) {
  statusEl.textContent = text;
}

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

function renderImages(label, items) {
  const isPerson = label === "person";
  const grid = $(isPerson ? "personGrid" : "otherGrid");
  const count = $(isPerson ? "personCount" : "otherCount");
  count.textContent = items.length;
  grid.replaceChildren();

  for (const item of items) {
    const wrap = document.createElement("div");
    wrap.className = "thumb-wrap";

    const image = document.createElement("img");
    image.src = item.url;
    image.alt = isPerson ? "Saved person example" : "Saved not-person example";
    image.loading = "lazy";

    const remove = document.createElement("button");
    remove.className = "delete-image";
    remove.type = "button";
    remove.textContent = "×";
    remove.title = "Delete image";
    remove.onclick = async () => {
      try {
        await api(`/api/images/${isPerson ? "person" : "not-person"}/${encodeURIComponent(item.name)}`, {
          method: "DELETE"
        });
        await refreshImages();
        classifier = null;
        setStatus("Image deleted. Train the model again to use the updated examples.");
      } catch (error) {
        setStatus(error.message);
      }
    };

    wrap.append(image, remove);
    grid.append(wrap);
  }
}

async function refreshImages() {
  const images = await api("/api/images");
  imageSets = { person: images.person, other: images.notPerson };
  renderImages("person", imageSets.person);
  renderImages("other", imageSets.other);
}

function connectUploader(inputId, dropId, label) {
  const input = $(inputId);
  const drop = $(dropId);

  async function send(files) {
    const imageFiles = [...files].filter(file => file.type.startsWith("image/"));
    if (!imageFiles.length) return setStatus("Choose image files to upload.");

    const form = new FormData();
    imageFiles.forEach(file => form.append("images", file));

    setStatus(`Uploading ${imageFiles.length} image(s)…`);
    try {
      const result = await api(`/api/upload/${label}`, { method: "POST", body: form });
      await refreshImages();
      classifier = null;
      setStatus(`Saved ${result.saved.length} image(s) to data/${label}/. Train the model to use them.`);
    } catch (error) {
      setStatus(`Upload failed: ${error.message}`);
    }
  }

  input.addEventListener("change", async event => {
    await send(event.target.files);
    input.value = "";
  });

  drop.addEventListener("dragover", event => {
    event.preventDefault();
    drop.classList.add("dragover");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("dragover"));
  drop.addEventListener("drop", event => {
    event.preventDefault();
    drop.classList.remove("dragover");
    send(event.dataTransfer.files);
  });
}

async function imageFeatures(file) {
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.src = url;

  try {
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error("The selected image could not be opened."));
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

$("trainButton").onclick = async () => {
  if (!net) return setStatus("The image model is still loading.");
  if (imageSets.person.length < 2 || imageSets.other.length < 2) {
    return setStatus("Upload at least 2 person and 2 not-person images first.");
  }

  $("trainButton").disabled = true;
  setStatus("Extracting features from saved training images…");

  let xs, ys;
  try {
    const samples = [];
    const all = [
      ...imageSets.person.map(item => ({ ...item, label: 0 })),
      ...imageSets.other.map(item => ({ ...item, label: 1 }))
    ];

    for (let i = 0; i < all.length; i++) {
      setStatus(`Preparing training image ${i + 1} of ${all.length}…`);
      const response = await fetch(all[i].url);
      if (!response.ok) throw new Error(`Could not load ${all[i].name}`);
      const file = await response.blob();
      const vector = await imageFeatures(file);
      samples.push({ vector, label: all[i].label });
    }

    tf.util.shuffle(samples);
    xs = tf.tensor2d(samples.map(sample => sample.vector));
    ys = tf.tensor2d(samples.map(sample => sample.label === 0 ? [1, 0] : [0, 1]));

    if (classifier) classifier.dispose();
    classifier = tf.sequential({ layers: [
      tf.layers.dense({ inputShape: [EMBEDDING_SIZE], units: 32, activation: "relu" }),
      tf.layers.dropout({ rate: 0.15 }),
      tf.layers.dense({ units: 2, activation: "softmax" })
    ] });
    classifier.compile({
      optimizer: tf.train.adam(0.003),
      loss: "categoricalCrossentropy"
    });

    setStatus("Training classifier…");
    await classifier.fit(xs, ys, {
      epochs: 20,
      batchSize: Math.min(16, samples.length),
      shuffle: true,
      verbose: 0
    });

    setStatus("Training complete. Choose an image in SCAN.");
  } catch (error) {
    console.error(error);
    setStatus(`Training failed: ${error.message}`);
  } finally {
    if (xs) xs.dispose();
    if (ys) ys.dispose();
    $("trainButton").disabled = false;
  }
};

$("scanInput").addEventListener("change", event => {
  const file = event.target.files[0];
  if (!file) return;

  scannedImageName = file.name;
  const preview = $("scanPreview");
  if (preview.dataset.url) URL.revokeObjectURL(preview.dataset.url);
  preview.dataset.url = URL.createObjectURL(file);
  preview.src = preview.dataset.url;
  preview.classList.add("visible");
  $("scanPlaceholder").hidden = true;

  $("prediction").textContent = "Ready to scan";
  $("confidence").textContent = "";
  $("feedbackNote").textContent = "";
  $("correctButton").disabled = true;
  $("incorrectButton").disabled = true;
});

function progress(text, value = null) {
  $("progressArea").hidden = false;
  $("progressText").textContent = text;
  const bar = $("progressBar");
  if (value === null) {
    bar.classList.add("busy");
    bar.style.width = "";
  } else {
    bar.classList.remove("busy");
    bar.style.width = `${value}%`;
  }
}

$("scanButton").onclick = async () => {
  const file = $("scanInput").files[0];
  if (!file) return setStatus("Choose an image to scan first.");
  if (!net) return setStatus("The image model is still loading.");
  if (!classifier) return setStatus("Upload examples in both trainer boxes and train first.");

  $("scanButton").disabled = true;
  $("prediction").textContent = "Scanning…";
  $("confidence").textContent = "";
  progress("Reading image…", 10);

  try {
    await new Promise(requestAnimationFrame);
    progress("Comparing visual features…", 35);
    const vector = await imageFeatures(file);

    progress("Calculating prediction…", 80);
    const input = tf.tensor2d([vector]);
    const output = classifier.predict(input);
    const scores = await output.data();
    input.dispose();
    output.dispose();

    const person = scores[0] >= scores[1];
    scannedPrediction = person ? "person" : "not-person";
    $("prediction").textContent = person ? "Person" : "Not Person";
    $("confidence").textContent = `${(Math.max(...scores) * 100).toFixed(1)}%`;
    $("correctButton").disabled = false;
    $("incorrectButton").disabled = false;
    progress("Scan complete", 100);
    setStatus("Scan complete. Mark whether it was correct.");
  } catch (error) {
    console.error(error);
    $("prediction").textContent = "Scan failed";
    progress(error.message, 100);
    setStatus(`Scan failed: ${error.message}`);
  } finally {
    $("scanButton").disabled = false;
  }
};

async function submitFeedback(correct) {
  const correctLabel = correct
    ? scannedPrediction
    : (scannedPrediction === "person" ? "not-person" : "person");

  try {
    await api("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image: scannedImageName,
        prediction: scannedPrediction,
        correctLabel,
        correct
      })
    });

    $("feedbackNote").textContent = correct
      ? "Marked correct. Feedback saved."
      : `Marked incorrect. Feedback saved. For training, upload the image to TRAINER ${correctLabel === "person" ? "Person" : "Not Person"}, then retrain.`;

    $("correctButton").disabled = true;
    $("incorrectButton").disabled = true;
  } catch (error) {
    $("feedbackNote").textContent = `Could not save feedback: ${error.message}`;
  }
}

$("correctButton").onclick = () => submitFeedback(true);
$("incorrectButton").onclick = () => submitFeedback(false);

$("clearButton").onclick = async () => {
  if (!confirm("Delete every saved training image? This removes files from data/."))
    return;

  try {
    for (const [label, items] of [
      ["person", imageSets.person],
      ["not-person", imageSets.other]
    ]) {
      for (const item of items) {
        await api(`/api/images/${label}/${encodeURIComponent(item.name)}`, { method: "DELETE" });
      }
    }
    classifier = null;
    await refreshImages();
    setStatus("Saved training images deleted. Upload new examples to train again.");
  } catch (error) {
    setStatus(`Could not clear images: ${error.message}`);
  }
};

connectUploader("personInput", "personDrop", "person");
connectUploader("otherInput", "otherDrop", "not-person");

async function start() {
  try {
    setStatus("Connecting to image storage…");
    await refreshImages();

    setStatus("Loading image model… first load may take a little while.");
    await tf.ready();
    net = await mobilenet.load({ version: 2, alpha: 0.5 });

    setStatus("Ready. Your server-saved images are loaded.");
  } catch (error) {
    console.error(error);
    setStatus(`Could not start: ${error.message}. Check your internet connection and refresh.`);
  }
}

start();

const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const sharp = require("sharp");

const app = express();
const PORT = process.env.PORT || 8080;
const DATA = path.join(__dirname, "data");
const LABELS = ["person", "not-person"];
const ALLOWED_EXTENSIONS = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i;

for (const label of LABELS) {
  fs.mkdirSync(path.join(DATA, label), { recursive: true });
}

app.use(express.json({ limit: "1mb" }));

const storage = multer.diskStorage({
  destination(req, file, callback) {
    const label = req.params.label || req.query.label;

    if (!LABELS.includes(label)) {
      return callback(new Error("Invalid image label."));
    }

    callback(null, path.join(DATA, label));
  },

  filename(req, file, callback) {
    const extension = path.extname(file.originalname).toLowerCase() || ".jpg";
    callback(null, `${Date.now()}-${crypto.randomUUID()}${extension}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter(req, file, callback) {
    if (!file.mimetype || !file.mimetype.startsWith("image/")) {
      return callback(new Error("Please upload image files only."));
    }
    callback(null, true);
  }
});

function listImages(label) {
  const directory = path.join(DATA, label);

  return fs.readdirSync(directory)
    .filter(name => ALLOWED_EXTENSIONS.test(name))
    .map(name => ({
      name,
      url: `/data/${label}/${encodeURIComponent(name)}`
    }));
}

app.get("/api/images", (req, res) => {
  res.json({
    person: listImages("person"),
    notPerson: listImages("not-person")
  });
});

app.post("/api/upload/:label", upload.array("images", 50), (req, res) => {
  if (!LABELS.includes(req.params.label)) {
    return res.status(400).json({ error: "Invalid image label." });
  }

  res.json({
    saved: (req.files || []).map(file => ({
      name: file.filename,
      url: `/data/${req.params.label}/${encodeURIComponent(file.filename)}`
    }))
  });
});

/* Feedback images are saved in the corrected training folder. */
app.post("/api/feedback/image", upload.single("image"), (req, res) => {
  if (!LABELS.includes(req.query.label)) {
    return res.status(400).json({ error: "Invalid image label." });
  }

  if (!req.file) {
    return res.status(400).json({ error: "No image received." });
  }

  res.json({
    saved: true,
    name: req.file.filename,
    label: req.query.label
  });
});

app.post("/api/feedback", (req, res) => {
  const { image, prediction, correctLabel, correct } = req.body || {};

  if (
    !image ||
    !prediction ||
    !LABELS.includes(correctLabel) ||
    typeof correct !== "boolean"
  ) {
    return res.status(400).json({ error: "Feedback details are missing or invalid." });
  }

  fs.appendFileSync(
    path.join(DATA, "feedback.jsonl"),
    JSON.stringify({
      image,
      prediction,
      correctLabel,
      correct,
      at: new Date().toISOString()
    }) + "\n"
  );

  res.json({ saved: true });
});

/*
 * Similarity search:
 * - Corrects EXIF orientation.
 * - Resizes both query and saved images to the same dimensions.
 * - Compares normalized pixel colour features.
 *
 * This is a lightweight visual similarity baseline, not semantic recognition.
 * Saved images in the Person folder are the search database.
 */
async function makeImageFeature(imageBuffer) {
  const { data, info } = await sharp(imageBuffer)
    .rotate()
    .resize(24, 24, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const channels = info.channels;
  const values = [];

  for (let pixel = 0; pixel < 24 * 24; pixel++) {
    const index = pixel * channels;
    values.push(data[index] / 255, data[index + 1] / 255, data[index + 2] / 255);
  }

  // Normalize brightness somewhat so exposure changes matter less.
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const centered = values.map(value => value - mean);
  const norm = Math.sqrt(centered.reduce((sum, value) => sum + value * value, 0));

  if (!norm) return centered;

  return centered.map(value => value / norm);
}

function cosineSimilarity(a, b) {
  let dot = 0;
  const length = Math.min(a.length, b.length);

  for (let i = 0; i < length; i++) {
    dot += a[i] * b[i];
  }

  return dot;
}

app.post("/api/search/similar", upload.single("image"), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Choose an image to search with." });
    }

    const queryFeature = await makeImageFeature(req.file.buffer);
    const candidates = listImages("person");
    const results = [];

    for (const candidate of candidates) {
      const filePath = path.join(DATA, "person", candidate.name);

      try {
        const imageBuffer = fs.readFileSync(filePath);
        const feature = await makeImageFeature(imageBuffer);
        const similarity = cosineSimilarity(queryFeature, feature);

        results.push({
          name: candidate.name,
          url: candidate.url,
          similarity
        });
      } catch (error) {
        console.warn(`Skipping unreadable database image ${candidate.name}:`, error.message);
      }
    }

    results.sort((a, b) => b.similarity - a.similarity);

    res.json({
      results: results.slice(0, 3).map(item => ({
        ...item,
        similarity: Math.max(0, Math.min(1, item.similarity))
      }))
    });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/images/:label/:name", (req, res) => {
  const { label, name } = req.params;

  if (!LABELS.includes(label) || name !== path.basename(name)) {
    return res.status(400).json({ error: "Invalid image path." });
  }

  const file = path.join(DATA, label, name);

  if (!fs.existsSync(file)) {
    return res.status(404).json({ error: "Image not found." });
  }

  fs.unlinkSync(file);
  res.json({ deleted: true });
});

app.use("/data", express.static(DATA));
app.use(express.static(__dirname, { index: "index.html" }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(400).json({ error: err.message || "Request failed." });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Trainer running on port ${PORT}`);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Trainer running on port ${PORT}`);
});

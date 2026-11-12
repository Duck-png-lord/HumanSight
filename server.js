const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const sharp = require("sharp");

const app = express();
const PORT = Number(process.env.PORT) || 8080;
const DATA = path.join(__dirname, "data");
const LABELS = ["person", "not-person"];
const IMAGE_EXTENSIONS = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i;

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
    .filter(name => IMAGE_EXTENSIONS.test(name))
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

app.post("/api/upload/:label", (req, res, next) => {
  if (!LABELS.includes(req.params.label)) {
    return res.status(400).json({ error: "Invalid image label." });
  }

  upload.array("images", 50)(req, res, error => {
    if (error) return next(error);

    res.json({
      saved: (req.files || []).map(file => ({
        name: file.filename,
        url: `/data/${req.params.label}/${encodeURIComponent(file.filename)}`
      }))
    });
  });
});

app.post("/api/feedback/image", (req, res, next) => {
  if (!LABELS.includes(req.query.label)) {
    return res.status(400).json({ error: "Invalid image label." });
  }

  upload.single("image")(req, res, error => {
    if (error) return next(error);
    if (!req.file) {
      return res.status(400).json({ error: "No image received." });
    }

    res.json({
      saved: true,
      name: req.file.filename,
      label: req.query.label
    });
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
    return res.status(400).json({
      error: "Feedback details are missing or invalid."
    });
  }

  const feedbackPath = path.join(DATA, "feedback.jsonl");

  fs.appendFileSync(
    feedbackPath,
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
 * Turn an image into a small orientation-corrected colour feature.
 * This provides basic visual similarity, not face recognition.
 */
async function makeImageFeature(imageBuffer) {
  const { data, info } = await sharp(imageBuffer)
    .rotate()
    .resize(24, 24, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const values = [];
  const channels = info.channels;

  for (let pixel = 0; pixel < 24 * 24; pixel++) {
    const index = pixel * channels;
    values.push(
      data[index] / 255,
      data[index + 1] / 255,
      data[index + 2] / 255
    );
  }

  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const centered = values.map(value => value - mean);
  const norm = Math.sqrt(
    centered.reduce((sum, value) => sum + value * value, 0)
  );

  return norm
    ? centered.map(value => value / norm)
    : centered;
}

function cosineSimilarity(a, b) {
  let dot = 0;

  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i];
  }

  return dot;
}

app.post("/api/search/similar", (req, res, next) => {
  upload.single("image")(req, res, async error => {
    try {
      if (error) return next(error);
      if (!req.file) {
        return res.status(400).json({ error: "Choose an image to search with." });
      }

      const queryFeature = await makeImageFeature(req.file.buffer);
      const candidates = listImages("person");
      const results = [];

      for (const candidate of candidates) {
        try {
          const filePath = path.join(DATA, "person", candidate.name);
          const imageBuffer = fs.readFileSync(filePath);
          const feature = await makeImageFeature(imageBuffer);

          results.push({
            ...candidate,
            similarity: cosineSimilarity(queryFeature, feature)
          });
        } catch (imageError) {
          console.warn(`Skipping ${candidate.name}: ${imageError.message}`);
        }
      }

      results.sort((a, b) => b.similarity - a.similarity);

      res.json({
        results: results.slice(0, 3).map(item => ({
          ...item,
          similarity: Math.max(0, Math.min(1, item.similarity))
        }))
      });
    } catch (searchError) {
      next(searchError);
    }
  });
});

app.delete("/api/images/:label/:name", (req, res) => {
  const { label, name } = req.params;

  if (!LABELS.includes(label) || name !== path.basename(name)) {
    return res.status(400).json({ error: "Invalid image path." });
  }

  const filePath = path.join(DATA, label, name);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "Image not found." });
  }

  fs.unlinkSync(filePath);
  res.json({ deleted: true });
});

app.use("/data", express.static(DATA));
app.use(express.static(__dirname, { index: "index.html" }));

app.use((error, req, res, next) => {
  console.error(error);
  res.status(400).json({ error: error.message || "Request failed." });
});

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`Trainer running on port ${PORT}`);
});

server.on("error", error => {
  if (error.code === "EADDRINUSE") {
    console.error(
      `Port ${PORT} is already in use. Stop the process using it, or set a different PORT.`
    );
  } else {
    console.error("Could not start the server:", error);
  }

  process.exit(1);
});

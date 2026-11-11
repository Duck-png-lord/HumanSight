const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 8080;
const DATA = path.join(__dirname, "data");

for (const label of ["person", "not-person"]) {
  fs.mkdirSync(path.join(DATA, label), { recursive: true });
}

app.use(express.json({ limit: "1mb" }));

const storage = multer.diskStorage({
  destination(req, file, callback) {
    const label = req.params.label || req.query.label;
    if (!["person", "not-person"].includes(label)) {
      return callback(new Error("Invalid image label."));
    }
    callback(null, path.join(DATA, label));
  },
  filename(req, file, callback) {
    callback(null, `${Date.now()}-${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter(req, file, callback) {
    if (!file.mimetype.startsWith("image/")) {
      return callback(new Error("Please upload image files only."));
    }
    callback(null, true);
  }
});

app.get("/api/images", (req, res) => {
  function list(label) {
    const dir = path.join(DATA, label);
    return fs.readdirSync(dir)
      .filter(name => /\.(png|jpe?g|webp|gif|bmp)$/i.test(name))
      .map(name => ({
        name,
        url: `/data/${label}/${encodeURIComponent(name)}`
      }));
  }

  res.json({ person: list("person"), notPerson: list("not-person") });
});

app.post("/api/upload/:label", upload.array("images", 50), (req, res) => {
  res.json({
    saved: (req.files || []).map(file => ({
      name: file.filename,
      url: `/data/${req.params.label}/${encodeURIComponent(file.filename)}`
    }))
  });
});

/* Feedback images are saved into their corrected training folder. */
app.post("/api/feedback/image", upload.single("image"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No image received." });
  res.json({ saved: true, name: req.file.filename, label: req.query.label });
});

app.post("/api/feedback", (req, res) => {
  const { image, prediction, correctLabel, correct } = req.body || {};
  if (!image || !prediction || !correctLabel || typeof correct !== "boolean") {
    return res.status(400).json({ error: "Feedback details are missing." });
  }

  fs.appendFileSync(
    path.join(DATA, "feedback.jsonl"),
    JSON.stringify({
      image, prediction, correctLabel, correct,
      at: new Date().toISOString()
    }) + "\n"
  );

  res.json({ saved: true });
});

app.delete("/api/images/:label/:name", (req, res) => {
  const { label, name } = req.params;
  if (!["person", "not-person"].includes(label) || name !== path.basename(name)) {
    return res.status(400).json({ error: "Invalid image path." });
  }

  const file = path.join(DATA, label, name);
  if (!fs.existsSync(file)) return res.status(404).json({ error: "Image not found." });

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

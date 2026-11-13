const express = require("express");
const multer = require("multer");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const app = express();
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";
const dataRoot = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const personDir = path.join(dataRoot, "person");
const notPersonDir = path.join(dataRoot, "not-person");
const feedbackFile = path.join(dataRoot, "feedback.jsonl");

for (const directory of [dataRoot, personDir, notPersonDir]) {
  fs.mkdirSync(directory, { recursive: true });
}

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

const storage = multer.diskStorage({
  destination(req, file, callback) {
    const label = req.params.label;

    if (label !== "person" && label !== "not-person") {
      callback(new Error("Invalid upload category."));
      return;
    }

    callback(null, label === "person" ? personDir : notPersonDir);
  },

  filename(req, file, callback) {
    const extension = path.extname(file.originalname).toLowerCase();
    callback(null, `${Date.now()}-${crypto.randomUUID()}${extension}`);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 30
  },
  fileFilter(req, file, callback) {
    if (!file.mimetype || !file.mimetype.startsWith("image/")) {
      callback(new Error("Only image files are accepted."));
      return;
    }
    callback(null, true);
  }
});

function safeImageFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && /\.(png|jpe?g|gif|webp|bmp)$/i.test(entry.name))
    .map(entry => entry.name);
}

function publicImageUrl(category, filename) {
  return `/data/${category}/${encodeURIComponent(filename)}`;
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/styles.css", (req, res) => {
  res.sendFile(path.join(__dirname, "styles.css"));
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/api/images", (req, res) => {
  const person = safeImageFiles(personDir).map(name => ({
    name,
    url: publicImageUrl("person", name)
  }));

  const notPerson = safeImageFiles(notPersonDir).map(name => ({
    name,
    url: publicImageUrl("not-person", name)
  }));

  res.json({ person, "not-person": notPerson });
});

app.post("/api/upload/:label", upload.array("images", 30), (req, res) => {
  if (!req.files?.length) {
    res.status(400).json({ error: "No image files were uploaded." });
    return;
  }

  res.json({
    ok: true,
    saved: req.files.map(file => file.filename)
  });
});

app.post("/api/feedback/image", upload.single("image"), (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "No image was uploaded." });
    return;
  }

  const label = req.query.label;
  if (label !== "person" && label !== "not-person") {
    fs.unlink(req.file.path, () => {});
    res.status(400).json({ error: "Invalid feedback label." });
    return;
  }

  const destination = label === "person" ? personDir : notPersonDir;
  const finalPath = path.join(destination, req.file.filename);

  fs.rename(req.file.path, finalPath, error => {
    if (error) {
      res.status(500).json({ error: "Could not save feedback image." });
      return;
    }

    res.json({ ok: true, saved: req.file.filename });
  });
});

app.post("/api/feedback", (req, res) => {
  const record = {
    time: new Date().toISOString(),
    image: String(req.body?.image || "").slice(0, 300),
    prediction: String(req.body?.prediction || "").slice(0, 50),
    correctLabel: String(req.body?.correctLabel || "").slice(0, 50),
    correct: Boolean(req.body?.correct)
  };

  fs.appendFile(feedbackFile, `${JSON.stringify(record)}\n`, error => {
    if (error) {
      res.status(500).json({ error: "Could not write feedback log." });
      return;
    }
    res.json({ ok: true });
  });
});

app.get("/data/:category/:filename", (req, res) => {
  const category = req.params.category;

  if (category !== "person" && category !== "not-person") {
    res.sendStatus(404);
    return;
  }

  const filename = path.basename(req.params.filename);
  const directory = category === "person" ? personDir : notPersonDir;
  const filePath = path.join(directory, filename);

  if (!fs.existsSync(filePath)) {
    res.sendStatus(404);
    return;
  }

  res.sendFile(filePath);
});

app.use((error, req, res, next) => {
  console.error(error);

  if (res.headersSent) {
    next(error);
    return;
  }

  res.status(400).json({ error: error.message || "Request failed." });
});

app.listen(port, host, () => {
  console.log(`Image Trainer server at http://${host}:${port}`);
});

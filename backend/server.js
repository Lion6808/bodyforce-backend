// ✅ server.js (corrigé avec route d'import Excel protégée et support Multer)

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const sqlite3 = require("sqlite3").verbose();
const multer = require("multer");
const path = require("path");
const bcrypt = require("bcrypt");
const fs = require("fs");
const xlsx = require("xlsx");

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(helmet());
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));
app.use("/upload", express.static(path.join(__dirname, "upload")));

const db = new sqlite3.Database("./club.db");
const usersDb = new sqlite3.Database("./users.db");

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

app.use((req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (authHeader) {
      req.user = JSON.parse(authHeader);
    } else {
      req.user = null;
    }
  } catch (e) {
    console.error("Erreur parsing Authorization:", e);
    req.user = null;
  }
  next();
});

function isAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    console.warn("Accès refusé à /api/users. Utilisateur :", req.user);
    return res.status(403).json({ error: "Accès interdit (admin uniquement)" });
  }
  next();
}

const photoStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "upload/photos/"),
  filename: (req, file, cb) => cb(null, Date.now() + "_" + file.originalname),
});
const fileStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "upload/files/"),
  filename: (req, file, cb) => cb(null, Date.now() + "_" + file.originalname),
});
const uploadPhoto = multer({ storage: photoStorage });
const uploadFile = multer({ storage: fileStorage });

app.post("/upload/photo", uploadPhoto.single("photo"), (req, res) => {
  if (!req.file) return res.status(400).send("Aucun fichier reçu");
  res.json({ path: `/upload/photos/${req.file.filename}` });
});

app.post("/upload/file", uploadFile.single("file"), (req, res) => {
  if (!req.file) return res.status(400).send("Aucun fichier reçu");
  res.json({ name: req.file.originalname, url: `/upload/files/${req.file.filename}` });
});

// ✅ Import Excel vers presences
const importExcel = multer({ dest: "upload/tmp/" });
app.post("/api/import-events", isAdmin, importExcel.single("file"), (req, res) => {
  const filePath = req.file?.path;
  if (!filePath) return res.status(400).json({ error: "Fichier manquant" });

  try {
    const workbook = xlsx.readFile(filePath);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = xlsx.utils.sheet_to_json(sheet);

    let inserts = 0;
    const stmt = db.prepare("INSERT OR IGNORE INTO presences (badgeId, timestamp) VALUES (?, ?)");
    data.forEach((row) => {
      if (row.badgeId && row.timestamp) stmt.run(row.badgeId, row.timestamp), inserts++;
    });
    stmt.finalize();
    fs.unlinkSync(filePath);
    res.json({ success: true, count: inserts });
  } catch (err) {
    console.error("Erreur d'import Excel :", err);
    res.status(500).json({ error: "Erreur lors de l'import" });
  }
});

// (autres routes backend non recollées ici par souci de place...)

app.listen(port, () => {
  console.log(`Serveur lancé sur le port ${port}`);
});

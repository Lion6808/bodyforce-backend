const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const sqlite3 = require("sqlite3").verbose();
const multer = require("multer");
const path = require("path");
const bcrypt = require("bcrypt");

const app = express();
const port = process.env.PORT || 3001;

// --- Middleware global ---
app.use(cors());
app.use(helmet());
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));
app.use("/upload", express.static(path.join(__dirname, "upload")));

// --- Connexions aux bases de données ---
const db = new sqlite3.Database("./club.db");
const usersDb = new sqlite3.Database("./users.db");

// --- Logging simple ---
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// --- Middleware pour injecter les infos user depuis Authorization ---
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

// --- Middleware isAdmin ---
function isAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    console.warn("Accès refusé à /api/users. Utilisateur :", req.user);
    return res.status(403).json({ error: "Accès interdit (admin uniquement)" });
  }
  next();
}

// --- Configuration Multer ---
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

// --- Routes Upload ---
app.post("/upload/photo", uploadPhoto.single("photo"), (req, res) => {
  if (!req.file) return res.status(400).send("Aucun fichier reçu");
  res.json({ path: `/upload/photos/${req.file.filename}` });
});

app.post("/upload/file", uploadFile.single("file"), (req, res) => {
  if (!req.file) return res.status(400).send("Aucun fichier reçu");
  res.json({ name: req.file.originalname, url: `/upload/files/${req.file.filename}` });
});

// --- Authentification ---
app.post("/api/login", (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: "Champs requis manquants" });

  usersDb.get("SELECT * FROM users WHERE username = ?", [username], (err, user) => {
    if (err || !user)
      return res.status(401).json({ error: "Utilisateur inconnu" });

    bcrypt.compare(password, user.passwordHash, (err, match) => {
      if (err || !match)
        return res.status(401).json({ error: "Mot de passe incorrect" });

      res.json({ id: user.id, username: user.username, role: user.role });
    });
  });
});

// --- Gestion des utilisateurs ---
app.get("/api/users", isAdmin, (req, res) => {
  console.log("Route GET /api/users appelée par :", req.user);
  usersDb.all("SELECT id, username, role FROM users", (err, rows) => {
    if (err) {
      console.error("Erreur SQL /api/users:", err.message);
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

app.post("/api/users", isAdmin, async (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password || !role)
    return res.status(400).json({ error: "Tous les champs sont requis" });

  const hash = await bcrypt.hash(password, 10);
  usersDb.run("INSERT INTO users (username, passwordHash, role) VALUES (?, ?, ?)",
    [username, hash, role], function (err) {
      if (err) return res.status(400).json({ error: err.message });
      res.json({ id: this.lastID, username, role });
    });
});

app.put("/api/users/:id", async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  const userId = parseInt(req.params.id);
  const currentUserId = parseInt(req.user?.id);
  const isAdminUser = req.user?.role === "admin";

  usersDb.get("SELECT * FROM users WHERE id = ?", [userId], async (err, user) => {
    if (err || !user) return res.status(404).json({ error: "Utilisateur non trouvé" });

    if (!isAdminUser && userId !== currentUserId)
      return res.status(403).json({ error: "Non autorisé" });

    const isValid = await bcrypt.compare(oldPassword, user.passwordHash);
    if (!isValid) return res.status(401).json({ error: "Ancien mot de passe incorrect" });

    const newHash = await bcrypt.hash(newPassword, 10);
    usersDb.run("UPDATE users SET passwordHash = ? WHERE id = ?", [newHash, userId], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    });
  });
});

app.delete("/api/users/:id", isAdmin, (req, res) => {
  usersDb.run("DELETE FROM users WHERE id = ?", [req.params.id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// --- Route GET /api/members ---
app.get("/api/members", (req, res) => {
  db.all("SELECT * FROM members", (err, rows) => {
    if (err) {
      console.error("Erreur requête SQL :", err.message);
      return res.status(500).json({ error: err.message });
    }
    const members = rows.map(row => ({
      ...row,
      files: JSON.parse(row.files || '[]'),
      etudiant: !!row.etudiant
    }));
    res.json(members);
  });
});

// --- Route GET /api/presences ---
app.get("/api/presences", (req, res) => {
  db.all("SELECT * FROM presences", (err, rows) => {
    if (err) {
      console.error("Erreur lors de la récupération des présences :", err.message);
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

// --- Route POST /api/members ---
app.post("/api/members", (req, res) => {
  const {
    name, firstName, birthdate, gender,
    address, phone, mobile, email,
    subscriptionType, startDate, endDate,
    badgeId, files, photo, etudiant
  } = req.body;

  const sql = `
    INSERT INTO members (
      name, firstName, birthdate, gender,
      address, phone, mobile, email,
      subscriptionType, startDate, endDate,
      badgeId, files, photo, etudiant
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  db.run(sql, [
    name, firstName, birthdate, gender,
    address, phone, mobile, email,
    subscriptionType, startDate, endDate,
    badgeId, JSON.stringify(files || []), photo,
    etudiant ? 1 : 0
  ], function (err) {
    if (err) {
      console.error("Erreur INSERT membre :", err.message);
      return res.status(500).json({ error: "Erreur lors de la création du membre." });
    }
    res.json({ id: this.lastID });
  });
});

// --- Route PUT /api/members/:id ---
app.put("/api/members/:id", (req, res) => {
  const id = req.params.id;
  const {
    name, firstName, birthdate, gender,
    address, phone, mobile, email,
    subscriptionType, startDate, endDate,
    badgeId, files, photo, etudiant
  } = req.body;

  const sql = `
    UPDATE members SET
      name = ?, firstName = ?, birthdate = ?, gender = ?,
      address = ?, phone = ?, mobile = ?, email = ?,
      subscriptionType = ?, startDate = ?, endDate = ?,
      badgeId = ?, files = ?, photo = ?, etudiant = ?
    WHERE id = ?
  `;

  db.run(sql, [
    name, firstName, birthdate, gender,
    address, phone, mobile, email,
    subscriptionType, startDate, endDate,
    badgeId, JSON.stringify(files || []), photo,
    etudiant ? 1 : 0,
    id
  ], function (err) {
    if (err) {
      console.error("Erreur UPDATE membre :", err.message);
      return res.status(500).json({ error: "Erreur lors de la mise à jour du membre." });
    }
    res.json({ success: true });
  });
});


// --- Route POST /api/import-events (ajoutée uniquement cette partie) ---
const fs = require("fs");
const xlsx = require("xlsx");

app.post("/api/import-events", isAdmin, (req, res) => {
  const excelPath = path.join(__dirname, "upload", "presences.xlsx");
  if (!fs.existsSync(excelPath)) {
    return res.status(404).json({ error: "Fichier Excel non trouvé (upload/presences.xlsx)" });
  }

  const workbook = xlsx.readFile(excelPath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const data = xlsx.utils.sheet_to_json(sheet);

  let inserted = 0;
  const stmt = db.prepare("INSERT OR IGNORE INTO presences (badgeId, timestamp) VALUES (?, ?)");

  for (const row of data) {
    if (row.badgeId && row.timestamp) {
      stmt.run(row.badgeId, row.timestamp, (err) => {
        if (!err) inserted++;
      });
    }
  }

  stmt.finalize(() => {
    res.json({ success: true, imported: inserted });
  });
});



// --- Lancement Render-compatible ---
app.listen(port, () => {
  console.log(`Serveur lancé sur le port ${port}`);
});
